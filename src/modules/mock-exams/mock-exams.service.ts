import { HttpStatus, Injectable } from '@nestjs/common';
import { AccessLevel, AttemptStatus, MultiSelectPolicy, Prisma, PublishStatus, ResultVisibility, SelectionMode } from '@prisma/client';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { centiToDecimal, decToNumber, toCenti } from '../../common/utils/marks.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PUBLISHED_QUESTION } from '../questions/questions.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { CreateMockTemplateDto, MockConfigDto, MockQueryDto, UpdateMockTemplateDto } from './mock-exams.dto';
import { QuestionSelector } from './question-selector';

const VERSION_WITH_SECTIONS = { sections: { orderBy: { sequence: 'asc' as const } } } satisfies Prisma.MockExamTemplateVersionInclude;
type VersionWithSections = Prisma.MockExamTemplateVersionGetPayload<{ include: typeof VERSION_WITH_SECTIONS }>;

/** Static validation of a draft configuration (returns problems; empty = valid). */
export function validateMockConfig(cfg: MockConfigDto): string[] {
  const errors: string[] = [];
  cfg.sections.forEach((s, i) => {
    const label = `section ${i + 1} (${s.title})`;
    if (s.negativeMarks > s.marksPerQuestion) errors.push(`${label}: negative marks cannot exceed marks per question`);
    if (s.selectionMode === SelectionMode.FIXED) {
      if (!s.questionIds?.length) errors.push(`${label}: FIXED sections need questionIds`);
      else if (new Set(s.questionIds).size !== s.questionIds.length) errors.push(`${label}: duplicate questionIds`);
      else if (s.questionIds.length !== s.questionCount) errors.push(`${label}: questionCount must equal the number of questionIds`);
    } else if (s.questionIds?.length) errors.push(`${label}: questionIds are only allowed for FIXED sections`);
    if (s.difficultyMix) {
      const sum = (s.difficultyMix.EASY ?? 0) + (s.difficultyMix.MEDIUM ?? 0) + (s.difficultyMix.HARD ?? 0);
      if (sum <= 0) errors.push(`${label}: difficultyMix must have a positive weight`);
    }
  });
  const total = cfg.sections.reduce((n, s) => n + toCenti(s.marksPerQuestion) * s.questionCount, 0);
  if (cfg.passMarks !== undefined && toCenti(cfg.passMarks) > total) errors.push('passMarks cannot exceed total marks');
  if (cfg.availableFrom && cfg.availableUntil && new Date(cfg.availableFrom) >= new Date(cfg.availableUntil)) {
    errors.push('availableFrom must be before availableUntil');
  }
  const fixedIds = cfg.sections.flatMap((s) => s.questionIds ?? []);
  if (new Set(fixedIds).size !== fixedIds.length) errors.push('a question cannot appear in more than one section');
  return errors;
}

@Injectable()
export class MockExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly selector: QuestionSelector,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ───────── Admin ─────────

  async create(dto: CreateMockTemplateDto, actorId: string, ctx: RequestContext) {
    this.assertConfig(dto.config);
    const exam = await this.prisma.exam.findUnique({ where: { id: dto.examId } });
    if (!exam) throw AppError.notFound('Exam');
    const { config, ...rest } = dto;
    const t = await this.prisma.mockExamTemplate.create({
      data: { ...rest, draftConfig: config as unknown as Prisma.InputJsonValue, createdById: actorId },
    });
    await this.audit.record({ actorId, action: 'mock.create', entityType: 'MockExamTemplate', entityId: t.id, after: dto, ctx });
    return t;
  }

  async update(id: string, dto: UpdateMockTemplateDto, actorId: string, ctx: RequestContext) {
    if (dto.config) this.assertConfig(dto.config);
    const before = await this.prisma.mockExamTemplate.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Mock exam');
    const { config, ...rest } = dto;
    const t = await this.prisma.mockExamTemplate.update({
      where: { id },
      data: { ...rest, draftConfig: config ? (config as unknown as Prisma.InputJsonValue) : undefined },
    });
    await this.audit.record({ actorId, action: 'mock.update', entityType: 'MockExamTemplate', entityId: id, before: before.draftConfig, after: dto, ctx });
    return t;
  }

  /**
   * Freezes the current draft into a new immutable version. FIXED questions are pinned to their currently
   * published version; RANDOM pools are verified to contain enough published questions.
   */
  async publish(id: string, actorId: string, ctx: RequestContext) {
    const template = await this.prisma.mockExamTemplate.findUnique({ where: { id }, include: { versions: { select: { versionNumber: true } } } });
    if (!template) throw AppError.notFound('Mock exam');
    const cfg = template.draftConfig as unknown as MockConfigDto;
    this.assertConfig(cfg);

    const problems: string[] = [];
    const pinned = new Map<number, { questionVersionId: string; position: number }[]>();
    for (const [i, s] of cfg.sections.entries()) {
      if (s.selectionMode === SelectionMode.FIXED) {
        const qs = await this.prisma.question.findMany({ where: { id: { in: s.questionIds! }, ...PUBLISHED_QUESTION }, select: { id: true, publishedVersionId: true } });
        const byId = new Map(qs.map((q) => [q.id, q.publishedVersionId!]));
        const missing = s.questionIds!.filter((qid) => !byId.has(qid));
        if (missing.length) problems.push(`section ${i + 1}: ${missing.length} question(s) are not published: ${missing.slice(0, 5).join(', ')}`);
        pinned.set(i, s.questionIds!.filter((qid) => byId.has(qid)).map((qid, pos) => ({ questionVersionId: byId.get(qid)!, position: pos })));
      } else {
        const size = await this.selector.poolSize({ subjectId: s.subjectId, topicIds: s.topicIds, questionTypes: s.questionTypes });
        if (size < s.questionCount) problems.push(`section ${i + 1}: only ${size} published questions match, ${s.questionCount} needed`);
      }
    }
    if (problems.length) throw new AppError('MOCK_NOT_PUBLISHABLE', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, problems);

    const totalCenti = cfg.sections.reduce((n, s) => n + toCenti(s.marksPerQuestion) * s.questionCount, 0);
    const versionNumber = Math.max(0, ...template.versions.map((v) => v.versionNumber)) + 1;
    const version = await this.prisma.$transaction(async (tx) => {
      const v = await tx.mockExamTemplateVersion.create({
        data: {
          templateId: id,
          versionNumber,
          durationMinutes: cfg.durationMinutes,
          totalMarks: centiToDecimal(totalCenti),
          passMarks: cfg.passMarks !== undefined ? centiToDecimal(toCenti(cfg.passMarks)) : null,
          shuffleQuestions: cfg.shuffleQuestions ?? true,
          shuffleOptions: cfg.shuffleOptions ?? true,
          multiSelectPolicy: cfg.multiSelectPolicy ?? MultiSelectPolicy.EXACT,
          allowNegativeTotal: cfg.allowNegativeTotal ?? false,
          maxAttempts: cfg.maxAttempts ?? null,
          resultVisibility: cfg.resultVisibility ?? ResultVisibility.IMMEDIATE,
          availableFrom: cfg.availableFrom ? new Date(cfg.availableFrom) : null,
          availableUntil: cfg.availableUntil ? new Date(cfg.availableUntil) : null,
          configSnapshot: cfg as unknown as Prisma.InputJsonValue,
          publishedById: actorId,
        },
      });
      for (const [i, s] of cfg.sections.entries()) {
        await tx.mockExamSection.create({
          data: {
            versionId: v.id,
            title: s.title,
            sequence: i + 1,
            subjectId: s.subjectId,
            topicIds: s.topicIds ?? [],
            questionTypes: s.questionTypes ?? [],
            difficultyMix: (s.difficultyMix as Prisma.InputJsonValue) ?? undefined,
            selectionMode: s.selectionMode,
            questionCount: s.questionCount,
            marksPerQuestion: centiToDecimal(toCenti(s.marksPerQuestion)),
            negativeMarks: centiToDecimal(toCenti(s.negativeMarks)),
            questions: pinned.has(i) ? { create: pinned.get(i) } : undefined,
          },
        });
      }
      await tx.mockExamTemplate.update({ where: { id }, data: { currentVersionId: v.id, status: PublishStatus.PUBLISHED } });
      await this.audit.record({ actorId, action: 'mock.publish', entityType: 'MockExamTemplate', entityId: id, metadata: { versionId: v.id, versionNumber }, ctx }, tx);
      return v;
    });
    return { templateId: id, versionId: version.id, versionNumber };
  }

  async setStatus(id: string, status: PublishStatus, actorId: string, ctx: RequestContext) {
    const t = await this.prisma.mockExamTemplate.findUnique({ where: { id } });
    if (!t) throw AppError.notFound('Mock exam');
    if (status === PublishStatus.PUBLISHED && !t.currentVersionId) throw AppError.badRequest('NOT_PUBLISHED', 'Use the publish endpoint to create the first version');
    await this.prisma.mockExamTemplate.update({ where: { id }, data: { status } });
    await this.audit.record({ actorId, action: `mock.status.${status.toLowerCase()}`, entityType: 'MockExamTemplate', entityId: id, ctx });
    return { id, status };
  }

  async adminList(q: MockQueryDto) {
    const where: Prisma.MockExamTemplateWhereInput = { examId: q.examId, stageId: q.stageId, accessLevel: q.accessLevel, status: q.status };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.mockExamTemplate.findMany({ where, include: { currentVersion: true, _count: { select: { versions: true } } }, orderBy: { updatedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.mockExamTemplate.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async adminGet(id: string) {
    const t = await this.prisma.mockExamTemplate.findUnique({
      where: { id },
      include: { versions: { orderBy: { versionNumber: 'desc' }, include: { sections: { orderBy: { sequence: 'asc' } }, _count: { select: { attempts: true } } } } },
    });
    if (!t) throw AppError.notFound('Mock exam');
    return t;
  }

  /** Pool availability per draft section (helps editors before publishing). */
  async poolReport(id: string) {
    const t = await this.prisma.mockExamTemplate.findUnique({ where: { id } });
    if (!t) throw AppError.notFound('Mock exam');
    const cfg = t.draftConfig as unknown as MockConfigDto;
    return Promise.all(
      cfg.sections.map(async (s) => ({
        title: s.title,
        selectionMode: s.selectionMode,
        needed: s.questionCount,
        available: s.selectionMode === SelectionMode.FIXED ? s.questionIds?.length ?? 0 : await this.selector.poolSize({ subjectId: s.subjectId, topicIds: s.topicIds, questionTypes: s.questionTypes }),
      })),
    );
  }

  // ───────── Student ─────────

  async list(userId: string, q: MockQueryDto) {
    const where: Prisma.MockExamTemplateWhereInput = {
      status: PublishStatus.PUBLISHED,
      currentVersionId: { not: null },
      examId: q.examId,
      stageId: q.stageId,
      accessLevel: q.accessLevel,
      exam: { status: PublishStatus.PUBLISHED },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mockExamTemplate.findMany({ where, include: { currentVersion: { include: VERSION_WITH_SECTIONS } }, orderBy: { updatedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.mockExamTemplate.count({ where }),
    ]);
    const premium = await this.entitlements.has(userId, FEATURES.MOCK_PREMIUM);
    const templateIds = rows.map((r) => r.id);
    const attempts = await this.prisma.examAttempt.findMany({
      where: { userId, templateVersion: { templateId: { in: templateIds } } },
      select: { id: true, status: true, templateVersionId: true, templateVersion: { select: { templateId: true } } },
    });
    return PageResult.of(
      rows.map((r) => this.summary(r, r.currentVersion!, premium, attempts.filter((a) => a.templateVersion.templateId === r.id))),
      total,
      q,
    );
  }

  async detail(userId: string, idOrSlug: string) {
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
    const t = await this.prisma.mockExamTemplate.findFirst({
      where: { ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }), status: PublishStatus.PUBLISHED, currentVersionId: { not: null } },
      include: { currentVersion: { include: VERSION_WITH_SECTIONS } },
    });
    if (!t) throw AppError.notFound('Mock exam');
    const v = t.currentVersion!;
    const premium = await this.entitlements.has(userId, FEATURES.MOCK_PREMIUM);
    const attempts = await this.prisma.examAttempt.findMany({
      where: { userId, templateVersion: { templateId: t.id } },
      select: { id: true, status: true, templateVersionId: true },
    });
    return {
      ...this.summary(t, v, premium, attempts),
      description: t.description,
      versionId: v.id,
      passMarks: decToNumber(v.passMarks),
      multiSelectPolicy: v.multiSelectPolicy,
      resultVisibility: v.resultVisibility,
      sections: v.sections.map((s) => ({
        id: s.id,
        title: s.title,
        sequence: s.sequence,
        questionCount: s.questionCount,
        marksPerQuestion: decToNumber(s.marksPerQuestion)!,
        negativeMarks: decToNumber(s.negativeMarks)!,
      })),
    };
  }

  private summary(
    t: { id: string; slug: string; title: string; titleBn: string | null; examId: string; accessLevel: AccessLevel; isDemo: boolean },
    v: VersionWithSections,
    premium: boolean,
    attempts: { id: string; status: AttemptStatus; templateVersionId: string }[],
  ) {
    return {
      id: t.id,
      slug: t.slug,
      title: t.title,
      titleBn: t.titleBn,
      examId: t.examId,
      accessLevel: t.accessLevel,
      isDemo: t.isDemo,
      durationMinutes: v.durationMinutes,
      totalMarks: decToNumber(v.totalMarks)!,
      questionCount: v.sections.reduce((n, s) => n + s.questionCount, 0),
      availableFrom: v.availableFrom,
      availableUntil: v.availableUntil,
      unlocked: t.accessLevel === AccessLevel.FREE || premium,
      attemptsUsed: attempts.filter((a) => a.templateVersionId === v.id).length,
      maxAttempts: v.maxAttempts,
      activeAttemptId: attempts.find((a) => a.status === AttemptStatus.IN_PROGRESS)?.id ?? null,
    };
  }

  private assertConfig(cfg: MockConfigDto) {
    const errors = validateMockConfig(cfg);
    if (errors.length) throw new AppError('INVALID_MOCK_CONFIG', errors.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, errors);
  }
}
