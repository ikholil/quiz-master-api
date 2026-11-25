import { Injectable } from '@nestjs/common';
import { Prisma, PublishStatus } from '@prisma/client';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { parseIsoDate } from '../../common/utils/date.util';
import { decToNumber } from '../../common/utils/marks.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CreateAuthorityDto,
  CreateCategoryDto,
  CreateExamDto,
  ExamQueryDto,
  NoticeDto,
  PaperDto,
  StageDto,
  UpdateCategoryDto,
  UpdateExamDto,
} from './exams.dto';

type ExamWithRefs = Prisma.ExamGetPayload<{ include: { category: true; authority: true } }>;

const json = (v: unknown) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private summary(e: ExamWithRefs) {
    return {
      id: e.id,
      slug: e.slug,
      name: e.name,
      nameBn: e.nameBn,
      shortName: e.shortName,
      categorySlug: e.category.slug,
      authorityName: e.authority?.name ?? null,
      isFeatured: e.isFeatured,
      status: e.status,
    };
  }

  // ───────── Public ─────────

  async listCategories() {
    const cats = await this.prisma.examCategory.findMany({
      where: { status: PublishStatus.PUBLISHED },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { exams: { where: { status: PublishStatus.PUBLISHED } } } } },
    });
    return cats.map((c) => ({ id: c.id, slug: c.slug, name: c.name, nameBn: c.nameBn, description: c.description, examCount: c._count.exams }));
  }

  listAuthorities() {
    return this.prisma.recruitingAuthority.findMany({ orderBy: { name: 'asc' } });
  }

  async listExams(q: ExamQueryDto, admin = false) {
    const where: Prisma.ExamWhereInput = {
      status: admin ? q.status : PublishStatus.PUBLISHED,
      category: q.category ? { slug: q.category } : admin ? undefined : { status: PublishStatus.PUBLISHED },
      authority: q.authority ? { slug: q.authority } : undefined,
      isFeatured: q.featured === undefined ? undefined : q.featured === 'true',
      OR: q.q
        ? [
            { name: { contains: q.q, mode: 'insensitive' } },
            { nameBn: { contains: q.q } },
            { shortName: { contains: q.q, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.exam.findMany({
        where,
        include: { category: true, authority: true },
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        ...pageArgs(q),
      }),
      this.prisma.exam.count({ where }),
    ]);
    return PageResult.of(rows.map((e) => this.summary(e)), total, q);
  }

  async getExam(slugOrId: string, userId?: string, admin = false) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(slugOrId);
    const exam = await this.prisma.exam.findFirst({
      where: { ...(isUuid ? { id: slugOrId } : { slug: slugOrId }), status: admin ? undefined : PublishStatus.PUBLISHED },
      include: {
        category: true,
        authority: true,
        stages: { orderBy: { sequence: 'asc' } },
        syllabusVersions: { where: { isCurrent: true, status: admin ? undefined : PublishStatus.PUBLISHED }, select: { id: true } },
      },
    });
    if (!exam) throw AppError.notFound('Exam');
    const isBookmarked = userId ? !!(await this.prisma.examBookmark.findUnique({ where: { userId_examId: { userId, examId: exam.id } } })) : false;
    return {
      ...this.summary(exam),
      description: exam.description,
      eligibility: exam.eligibility,
      pattern: exam.pattern,
      officialUrl: exam.officialUrl,
      stages: exam.stages.map((s) => ({
        id: s.id,
        name: s.name,
        nameBn: s.nameBn,
        sequence: s.sequence,
        totalMarks: decToNumber(s.totalMarks),
        durationMinutes: s.durationMinutes,
        passMarks: decToNumber(s.passMarks),
        negativeMarking: decToNumber(s.negativeMarking),
        description: s.description,
      })),
      currentSyllabusVersionId: exam.syllabusVersions[0]?.id ?? null,
      isBookmarked,
    };
  }

  async listNotices(examId: string, admin = false) {
    await this.assertExam(examId, admin);
    return this.prisma.examNotice.findMany({
      where: { examId, status: admin ? undefined : PublishStatus.PUBLISHED },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async listPapers(examId: string, admin = false) {
    await this.assertExam(examId, admin);
    const papers = await this.prisma.previousYearPaper.findMany({
      where: { examId, status: admin ? undefined : PublishStatus.PUBLISHED },
      orderBy: { year: 'desc' },
      include: { sources: { select: { _count: { select: { questions: { where: { status: 'PUBLISHED', deletedAt: null } } } } } } },
    });
    return papers.map((p) => ({
      id: p.id,
      year: p.year,
      title: p.title,
      sourceReference: p.sourceReference,
      fileId: p.fileId,
      questionCount: p.sources.reduce((n, s) => n + s._count.questions, 0),
    }));
  }

  // ───────── Bookmarks ─────────

  async bookmark(userId: string, examId: string) {
    await this.assertExam(examId);
    await this.prisma.examBookmark.upsert({ where: { userId_examId: { userId, examId } }, create: { userId, examId }, update: {} });
    return { bookmarked: true };
  }

  async unbookmark(userId: string, examId: string) {
    await this.prisma.examBookmark.deleteMany({ where: { userId, examId } });
    return { bookmarked: false };
  }

  async bookmarks(userId: string) {
    const rows = await this.prisma.examBookmark.findMany({
      where: { userId, exam: { status: PublishStatus.PUBLISHED } },
      include: { exam: { include: { category: true, authority: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.summary(r.exam));
  }

  // ───────── Admin ─────────

  async createCategory(dto: CreateCategoryDto, actorId: string, ctx: RequestContext) {
    const c = await this.prisma.examCategory.create({ data: dto });
    await this.audit.record({ actorId, action: 'catalog.category.create', entityType: 'ExamCategory', entityId: c.id, after: dto, ctx });
    return c;
  }

  async updateCategory(id: string, dto: UpdateCategoryDto, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.examCategory.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Category');
    const c = await this.prisma.examCategory.update({ where: { id }, data: dto });
    await this.audit.record({ actorId, action: 'catalog.category.update', entityType: 'ExamCategory', entityId: id, before, after: dto, ctx });
    return c;
  }

  adminCategories() {
    return this.prisma.examCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async createAuthority(dto: CreateAuthorityDto, actorId: string, ctx: RequestContext) {
    const a = await this.prisma.recruitingAuthority.create({ data: dto });
    await this.audit.record({ actorId, action: 'catalog.authority.create', entityType: 'RecruitingAuthority', entityId: a.id, after: dto, ctx });
    return a;
  }

  async updateAuthority(id: string, dto: Partial<CreateAuthorityDto>, actorId: string, ctx: RequestContext) {
    const { slug: _slug, ...data } = dto;
    const a = await this.prisma.recruitingAuthority.update({ where: { id }, data });
    await this.audit.record({ actorId, action: 'catalog.authority.update', entityType: 'RecruitingAuthority', entityId: id, after: dto, ctx });
    return a;
  }

  async createExam(dto: CreateExamDto, actorId: string, ctx: RequestContext) {
    const exam = await this.prisma.exam.create({
      data: { ...dto, eligibility: json(dto.eligibility), pattern: json(dto.pattern), status: PublishStatus.DRAFT },
    });
    await this.audit.record({ actorId, action: 'catalog.exam.create', entityType: 'Exam', entityId: exam.id, after: dto, ctx });
    return exam;
  }

  async updateExam(id: string, dto: UpdateExamDto, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.exam.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Exam');
    if (dto.status === PublishStatus.PUBLISHED) {
      const stages = await this.prisma.examStage.count({ where: { examId: id } });
      if (!stages) throw AppError.badRequest('EXAM_INCOMPLETE', 'Add at least one stage before publishing');
    }
    const exam = await this.prisma.exam.update({
      where: { id },
      data: { ...dto, eligibility: json(dto.eligibility), pattern: json(dto.pattern) },
    });
    await this.audit.record({ actorId, action: 'catalog.exam.update', entityType: 'Exam', entityId: id, before, after: dto, ctx });
    return exam;
  }

  async upsertStage(examId: string, dto: StageDto, actorId: string, ctx: RequestContext) {
    await this.assertExam(examId, true);
    const stage = await this.prisma.examStage.upsert({
      where: { examId_sequence: { examId, sequence: dto.sequence } },
      create: { ...dto, examId },
      update: dto,
    });
    await this.audit.record({ actorId, action: 'catalog.stage.upsert', entityType: 'ExamStage', entityId: stage.id, after: dto, ctx });
    return stage;
  }

  async deleteStage(stageId: string, actorId: string, ctx: RequestContext) {
    const inUse = await this.prisma.mockExamTemplate.count({ where: { stageId } });
    if (inUse) throw AppError.conflict('STAGE_IN_USE', 'Stage is referenced by mock examinations');
    await this.prisma.examStage.delete({ where: { id: stageId } });
    await this.audit.record({ actorId, action: 'catalog.stage.delete', entityType: 'ExamStage', entityId: stageId, ctx });
    return { ok: true };
  }

  async createNotice(examId: string, dto: NoticeDto, actorId: string, ctx: RequestContext) {
    await this.assertExam(examId, true);
    const notice = await this.prisma.examNotice.create({
      data: { ...dto, examId, noticeDate: dto.noticeDate ? parseIsoDate(dto.noticeDate.slice(0, 10)) : undefined, createdById: actorId },
    });
    await this.audit.record({ actorId, action: 'catalog.notice.create', entityType: 'ExamNotice', entityId: notice.id, after: dto, ctx });
    return notice;
  }

  async setNoticeStatus(id: string, status: PublishStatus, actorId: string, ctx: RequestContext) {
    const notice = await this.prisma.examNotice.findUnique({ where: { id } });
    if (!notice) throw AppError.notFound('Notice');
    if (status === PublishStatus.PUBLISHED && notice.isOfficial && !notice.sourceUrl && !notice.fileId) {
      throw AppError.badRequest('SOURCE_REQUIRED', 'Official notices must reference the source URL or an uploaded copy');
    }
    const updated = await this.prisma.examNotice.update({
      where: { id },
      data: { status, publishedAt: status === PublishStatus.PUBLISHED ? (notice.publishedAt ?? new Date()) : notice.publishedAt },
    });
    await this.audit.record({ actorId, action: `catalog.notice.${status.toLowerCase()}`, entityType: 'ExamNotice', entityId: id, ctx });
    return updated;
  }

  async createPaper(examId: string, dto: PaperDto, actorId: string, ctx: RequestContext) {
    await this.assertExam(examId, true);
    const paper = await this.prisma.previousYearPaper.create({ data: { ...dto, examId } });
    await this.audit.record({ actorId, action: 'catalog.paper.create', entityType: 'PreviousYearPaper', entityId: paper.id, after: dto, ctx });
    return paper;
  }

  async updatePaper(id: string, dto: Partial<PaperDto>, actorId: string, ctx: RequestContext) {
    const paper = await this.prisma.previousYearPaper.update({ where: { id }, data: dto });
    await this.audit.record({ actorId, action: 'catalog.paper.update', entityType: 'PreviousYearPaper', entityId: id, after: dto, ctx });
    return paper;
  }

  private async assertExam(examId: string, admin = false) {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId }, select: { status: true } });
    if (!exam || (!admin && exam.status !== PublishStatus.PUBLISHED)) throw AppError.notFound('Exam');
  }
}
