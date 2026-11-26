import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ContentStatus,
  Prisma,
  QuestionType,
  ReportStatus,
  ReviewDecision,
  ReviewEntityType,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { escapeLike } from '../../common/utils/text.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { AuditService } from '../audit/audit.service';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';
import { ContentInput, validateQuestionContent } from './question-content';
import { VERSION_INCLUDE, VersionWithContent, toAnswerKey, toStudentView } from './question-views';
import {
  AdminQuestionQueryDto,
  CreateQuestionDto,
  CreateReportDto,
  ImportQuestionsDto,
  PassageDto,
  PublicQuestionQueryDto,
  ReportQueryDto,
  ResolveReportDto,
  ReviewDto,
  SourceDto,
  UpdateQuestionDto,
} from './questions.dto';

export function newQuestionCode(): string {
  return `Q${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
}

/** Student-visible question filter: published, not deleted, has a published version. */
export const PUBLISHED_QUESTION: Prisma.QuestionWhereInput = {
  status: ContentStatus.PUBLISHED,
  deletedAt: null,
  publishedVersionId: { not: null },
};

@Injectable()
export class QuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SystemConfigService,
    @InjectQueue(QUEUES.QUESTION_IMPORT) private readonly importQueue: Queue,
  ) {}

  // ───────── Authoring ─────────

  async create(dto: CreateQuestionDto, user: AuthUser, ctx?: RequestContext, tx?: Tx) {
    this.assertContent(dto.type, dto.content);
    const run = async (t: Tx) => {
      await this.assertRefs(t, dto);
      const q = await t.question.create({
        data: {
          code: newQuestionCode(),
          type: dto.type,
          difficulty: dto.difficulty,
          subjectId: dto.subjectId,
          topicId: dto.topicId,
          passageId: dto.passageId,
          sourceId: dto.sourceId,
          isDemo: dto.isDemo ?? false,
          aiGenerated: dto.aiGenerated ?? false,
          createdById: user.id,
          status: ContentStatus.DRAFT,
        },
      });
      const v = await this.writeVersion(t, q.id, 1, dto.content, user.id, 'Initial version');
      await t.question.update({ where: { id: q.id }, data: { latestVersionId: v.id } });
      await this.syncLinks(t, q.id, dto);
      await this.audit.record(
        {
          actorId: user.id,
          action: 'question.create',
          entityType: 'Question',
          entityId: q.id,
          after: { type: dto.type, code: q.code },
          ctx,
        },
        t,
      );
      return q.id;
    };
    const id = tx ? await run(tx) : await this.prisma.$transaction(run);
    return tx ? { id } : this.adminGet(id);
  }

  async update(id: string, dto: UpdateQuestionDto, user: AuthUser, ctx: RequestContext) {
    const q = await this.prisma.question.findUnique({ where: { id }, include: { latestVersion: true } });
    if (!q || q.deletedAt) throw AppError.notFound('Question');
    if (dto.content) this.assertContent(q.type, dto.content);

    await this.prisma.$transaction(async (tx) => {
      await this.assertRefs(tx, { subjectId: dto.subjectId ?? q.subjectId, ...dto });
      const { content, changeNote, extraTopicIds: _e, examIds: _x, tags: _t, ...meta } = dto;
      if (Object.keys(meta).length) await tx.question.update({ where: { id }, data: meta });
      await this.syncLinks(tx, id, dto);

      if (content) {
        const latest = q.latestVersion!;
        if (latest.status === ContentStatus.IN_REVIEW) {
          throw AppError.conflict(
            'VERSION_IN_REVIEW',
            'The latest version is in review; wait for the decision before editing',
          );
        }
        const editableInPlace = (
          [ContentStatus.DRAFT, ContentStatus.CHANGES_REQUESTED, ContentStatus.REJECTED] as ContentStatus[]
        ).includes(latest.status);
        if (editableInPlace) {
          // Never-published drafts can be rewritten: no attempt can reference them.
          await tx.questionOption.deleteMany({ where: { versionId: latest.id } });
          await tx.questionExplanation.deleteMany({ where: { versionId: latest.id } });
          await tx.questionVersion.update({
            where: { id: latest.id },
            data: {
              stem: content.stem,
              stemBn: content.stemBn,
              imageFileId: content.imageFileId,
              defaultMarks: content.defaultMarks ?? 1,
              acceptedAnswers: content.acceptedAnswers ?? [],
              rubric: content.rubric,
              changeNote: changeNote ?? latest.changeNote,
              status: ContentStatus.DRAFT,
              options: { create: this.optionRows(content) },
              explanation: content.explanation
                ? { create: { ...content.explanation, references: content.explanation.references ?? [] } }
                : undefined,
            },
          });
        } else {
          // Published/approved content is immutable: create the next version.
          const v = await this.writeVersion(tx, id, latest.versionNumber + 1, content, user.id, changeNote);
          await tx.question.update({ where: { id }, data: { latestVersionId: v.id } });
        }
        if (!q.publishedVersionId)
          await tx.question.update({ where: { id }, data: { status: ContentStatus.DRAFT } });
      }
      await this.audit.record(
        {
          actorId: user.id,
          action: 'question.update',
          entityType: 'Question',
          entityId: id,
          after: { ...dto, content: dto.content ? '[content]' : undefined },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  async submitForReview(id: string, user: AuthUser, ctx: RequestContext) {
    const q = await this.getLatest(id);
    const v = q.latestVersion!;
    if (!([ContentStatus.DRAFT, ContentStatus.CHANGES_REQUESTED] as ContentStatus[]).includes(v.status)) {
      throw AppError.conflict('INVALID_TRANSITION', `Cannot submit a version in ${v.status} for review`);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.questionVersion.update({ where: { id: v.id }, data: { status: ContentStatus.IN_REVIEW } });
      if (!q.publishedVersionId)
        await tx.question.update({ where: { id }, data: { status: ContentStatus.IN_REVIEW } });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'question.submit_review',
          entityType: 'Question',
          entityId: id,
          metadata: { versionId: v.id },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  /** Four-eyes review: by default the reviewer must not be the version's author. */
  async review(id: string, dto: ReviewDto, user: AuthUser, ctx: RequestContext) {
    const q = await this.getLatest(id);
    const v = q.latestVersion!;
    if (v.status !== ContentStatus.IN_REVIEW)
      throw AppError.conflict('INVALID_TRANSITION', 'Latest version is not awaiting review');
    const distinct = await this.settings.get<boolean>(SETTINGS.REQUIRE_DISTINCT_REVIEWER, true);
    if ((distinct || q.aiGenerated) && v.createdById === user.id) {
      throw AppError.forbidden('Authors cannot review their own content', 'SELF_REVIEW_FORBIDDEN');
    }
    const next: Record<ReviewDecision, ContentStatus> = {
      APPROVED: ContentStatus.APPROVED,
      REJECTED: ContentStatus.REJECTED,
      CHANGES_REQUESTED: ContentStatus.CHANGES_REQUESTED,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.contentReview.create({
        data: {
          entityType: ReviewEntityType.QUESTION,
          entityId: id,
          questionVersionId: v.id,
          reviewerId: user.id,
          decision: dto.decision,
          comments: dto.comments,
        },
      });
      await tx.questionVersion.update({ where: { id: v.id }, data: { status: next[dto.decision] } });
      if (!q.publishedVersionId)
        await tx.question.update({ where: { id }, data: { status: next[dto.decision] } });
      await this.audit.record(
        {
          actorId: user.id,
          action: `question.review.${dto.decision.toLowerCase()}`,
          entityType: 'Question',
          entityId: id,
          metadata: { versionId: v.id, comments: dto.comments },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  /** Publishes the latest APPROVED version. Earlier published versions are archived (but kept for attempts). */
  async publish(id: string, user: AuthUser, ctx: RequestContext) {
    const q = await this.getLatest(id);
    const v = q.latestVersion!;
    if (v.status !== ContentStatus.APPROVED)
      throw AppError.conflict('NOT_APPROVED', 'Only approved versions can be published');
    await this.prisma.$transaction(async (tx) => {
      if (q.publishedVersionId)
        await tx.questionVersion.update({
          where: { id: q.publishedVersionId },
          data: { status: ContentStatus.ARCHIVED },
        });
      await tx.questionVersion.update({ where: { id: v.id }, data: { status: ContentStatus.PUBLISHED } });
      await tx.question.update({
        where: { id },
        data: {
          status: ContentStatus.PUBLISHED,
          publishedVersionId: v.id,
          publishedAt: q.publishedAt ?? new Date(),
        },
      });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'question.publish',
          entityType: 'Question',
          entityId: id,
          metadata: { versionId: v.id, versionNumber: v.versionNumber, previous: q.publishedVersionId },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  async archive(id: string, user: AuthUser, ctx: RequestContext) {
    const q = await this.prisma.question.findUnique({ where: { id } });
    if (!q || q.deletedAt) throw AppError.notFound('Question');
    await this.prisma.question.update({ where: { id }, data: { status: ContentStatus.ARCHIVED } });
    await this.audit.record({
      actorId: user.id,
      action: 'question.archive',
      entityType: 'Question',
      entityId: id,
      ctx,
    });
    return { id, status: ContentStatus.ARCHIVED };
  }

  /** Soft delete: past attempts keep referencing the versions. */
  async remove(id: string, user: AuthUser, ctx: RequestContext) {
    const q = await this.prisma.question.findUnique({ where: { id } });
    if (!q || q.deletedAt) throw AppError.notFound('Question');
    await this.prisma.question.update({
      where: { id },
      data: { deletedAt: new Date(), status: ContentStatus.ARCHIVED },
    });
    await this.audit.record({
      actorId: user.id,
      action: 'question.delete',
      entityType: 'Question',
      entityId: id,
      ctx,
    });
    return { ok: true };
  }

  // ───────── Admin reads ─────────

  async adminList(q: AdminQuestionQueryDto) {
    const where: Prisma.QuestionWhereInput = {
      deletedAt: null,
      status: q.status,
      type: q.type,
      difficulty: q.difficulty,
      subjectId: q.subjectId,
      OR: q.topicId ? [{ topicId: q.topicId }, { topics: { some: { topicId: q.topicId } } }] : undefined,
      examMappings: q.examId ? { some: { examId: q.examId } } : undefined,
      tags: q.tag ? { some: { tag: { name: q.tag.toLowerCase() } } } : undefined,
      source: q.sourceType ? { type: q.sourceType } : undefined,
      aiGenerated: q.aiGenerated === undefined ? undefined : q.aiGenerated === 'true',
      isDemo: q.isDemo === undefined ? undefined : q.isDemo === 'true',
      latestVersion: q.q ? { stem: { contains: escapeLike(q.q), mode: 'insensitive' } } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        include: {
          latestVersion: true,
          publishedVersion: { select: { versionNumber: true } },
          subject: true,
          topic: true,
        },
        orderBy: { [q.sortBy ?? 'updatedAt']: q.sortOrder },
        ...pageArgs(q),
      }),
      this.prisma.question.count({ where }),
    ]);
    return PageResult.of(
      rows.map((r) => ({
        id: r.id,
        code: r.code,
        type: r.type,
        difficulty: r.difficulty,
        status: r.status,
        stem: r.latestVersion?.stem.slice(0, 300) ?? '',
        subjectName: r.subject.name,
        topicName: r.topic?.name ?? null,
        latestVersionNumber: r.latestVersion?.versionNumber ?? 0,
        latestVersionStatus: r.latestVersion?.status ?? ContentStatus.DRAFT,
        publishedVersionNumber: r.publishedVersion?.versionNumber ?? null,
        isDemo: r.isDemo,
        aiGenerated: r.aiGenerated,
        timesAnswered: r.timesAnswered,
        accuracy: r.timesAnswered ? Math.round((r.timesCorrect / r.timesAnswered) * 1000) / 10 : null,
        updatedAt: r.updatedAt,
      })),
      total,
      q,
    );
  }

  async adminGet(id: string) {
    const q = await this.prisma.question.findUnique({
      where: { id },
      include: {
        latestVersion: { include: { options: { orderBy: { sortOrder: 'asc' } }, explanation: true } },
        publishedVersion: { select: { id: true, versionNumber: true } },
        subject: true,
        topic: true,
        passage: true,
        source: true,
        tags: { include: { tag: true } },
        topics: { select: { topicId: true } },
        examMappings: { select: { examId: true, year: true } },
      },
    });
    if (!q || q.deletedAt) throw AppError.notFound('Question');
    const reviews = await this.prisma.contentReview.findMany({
      where: { entityType: ReviewEntityType.QUESTION, entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      ...q,
      tags: q.tags.map((t) => t.tag.name),
      extraTopicIds: q.topics.map((t) => t.topicId),
      reviews,
    };
  }

  async versions(id: string) {
    const versions = await this.prisma.questionVersion.findMany({
      where: { questionId: id },
      orderBy: { versionNumber: 'desc' },
      include: {
        options: { orderBy: { sortOrder: 'asc' } },
        explanation: true,
        reviews: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!versions.length) throw AppError.notFound('Question');
    return versions;
  }

  /** Oldest-first queue of questions whose latest version awaits review. */
  async reviewQueue(q: AdminQuestionQueryDto) {
    const where: Prisma.QuestionWhereInput = {
      deletedAt: null,
      latestVersion: { status: ContentStatus.IN_REVIEW },
      subjectId: q.subjectId,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        include: { latestVersion: true, subject: true },
        orderBy: { updatedAt: 'asc' },
        ...pageArgs(q),
      }),
      this.prisma.question.count({ where }),
    ]);
    return PageResult.of(
      rows.map((r) => ({
        id: r.id,
        code: r.code,
        type: r.type,
        subjectName: r.subject.name,
        stem: r.latestVersion?.stem.slice(0, 300),
        versionNumber: r.latestVersion?.versionNumber,
        authorId: r.latestVersion?.createdById,
        aiGenerated: r.aiGenerated,
        submittedAt: r.updatedAt,
      })),
      total,
      q,
    );
  }

  async createPassage(dto: PassageDto, user: AuthUser) {
    return this.prisma.questionPassage.create({ data: { ...dto, createdById: user.id } });
  }

  async createSource(dto: SourceDto) {
    if (dto.isOfficial && dto.type !== 'PREVIOUS_YEAR')
      throw AppError.badRequest('INVALID_SOURCE', 'Only previous-year sources can be marked official');
    if (dto.isOfficial && !dto.paperId && !dto.reference)
      throw AppError.badRequest('INVALID_SOURCE', 'Official sources need a paper or verifiable reference');
    return this.prisma.questionSource.create({ data: dto });
  }

  listSources() {
    return this.prisma.questionSource.findMany({ orderBy: [{ year: 'desc' }, { title: 'asc' }], take: 500 });
  }

  // ───────── Student-facing (published only, no answers) ─────────

  async publicList(q: PublicQuestionQueryDto) {
    const where: Prisma.QuestionWhereInput = {
      ...PUBLISHED_QUESTION,
      subjectId: q.subjectId,
      difficulty: q.difficulty,
      OR: q.topicId ? [{ topicId: q.topicId }, { topics: { some: { topicId: q.topicId } } }] : undefined,
      examMappings: q.examId ? { some: { examId: q.examId } } : undefined,
      source: q.paperId ? { paperId: q.paperId } : undefined,
      publishedVersion: q.q ? { stem: { contains: escapeLike(q.q), mode: 'insensitive' } } : undefined,
      type: { notIn: [QuestionType.WRITTEN, QuestionType.VIVA] },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        select: { publishedVersionId: true },
        orderBy: { publishedAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.question.count({ where }),
    ]);
    const versions = await this.loadVersions(rows.map((r) => r.publishedVersionId!));
    return PageResult.of(
      rows.map((r) => toStudentView(versions.get(r.publishedVersionId!)!)),
      total,
      q,
    );
  }

  async publicGet(id: string) {
    const q = await this.prisma.question.findFirst({
      where: { id, ...PUBLISHED_QUESTION },
      select: { publishedVersionId: true },
    });
    if (!q) throw AppError.notFound('Question');
    const v = (await this.loadVersions([q.publishedVersionId!])).get(q.publishedVersionId!)!;
    return toStudentView(v);
  }

  async loadVersions(ids: string[]): Promise<Map<string, VersionWithContent>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.questionVersion.findMany({
      where: { id: { in: ids } },
      include: VERSION_INCLUDE,
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  answerKey(v: VersionWithContent) {
    return toAnswerKey(v);
  }

  // ───────── Reports ─────────

  async report(questionId: string, dto: CreateReportDto, userId: string) {
    const q = await this.prisma.question.findFirst({ where: { id: questionId, ...PUBLISHED_QUESTION } });
    if (!q) throw AppError.notFound('Question');
    const open = await this.prisma.questionReport.count({
      where: { questionId, reporterId: userId, status: { in: [ReportStatus.OPEN, ReportStatus.IN_REVIEW] } },
    });
    if (open)
      throw AppError.conflict('ALREADY_REPORTED', 'You already have an open report for this question');
    return this.prisma.questionReport.create({
      data: {
        questionId,
        versionId: q.publishedVersionId,
        reporterId: userId,
        reason: dto.reason,
        details: dto.details,
      },
      select: { id: true, status: true, createdAt: true },
    });
  }

  async listReports(q: ReportQueryDto) {
    const where: Prisma.QuestionReportWhereInput = { status: q.status };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.questionReport.findMany({
        where,
        include: { question: { select: { code: true } } },
        orderBy: { createdAt: q.sortOrder },
        ...pageArgs(q),
      }),
      this.prisma.questionReport.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async resolveReport(id: string, dto: ResolveReportDto, user: AuthUser, ctx: RequestContext) {
    const report = await this.prisma.questionReport.findUnique({ where: { id } });
    if (!report) throw AppError.notFound('Report');
    const done = dto.status !== ReportStatus.IN_REVIEW;
    const updated = await this.prisma.questionReport.update({
      where: { id },
      data: {
        status: dto.status,
        resolution: dto.resolution,
        resolvedById: done ? user.id : null,
        resolvedAt: done ? new Date() : null,
      },
    });
    await this.audit.record({
      actorId: user.id,
      action: 'question.report.resolve',
      entityType: 'QuestionReport',
      entityId: id,
      after: dto,
      ctx,
    });
    return updated;
  }

  // ───────── Bulk import ─────────

  async startImport(dto: ImportQuestionsDto, user: AuthUser, ctx: RequestContext) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: dto.fileId } });
    if (!file || file.purpose !== 'QUESTION_IMPORT')
      throw AppError.badRequest('INVALID_FILE', 'Upload the file with purpose QUESTION_IMPORT first');
    const job = await this.prisma.questionImportJob.create({
      data: { fileId: dto.fileId, format: dto.format, createdById: user.id },
    });
    await this.importQueue.add(
      JOBS.IMPORT_QUESTIONS,
      { jobId: job.id, submitForReview: !!dto.submitForReview },
      { jobId: `import-${job.id}`, attempts: 1 },
    );
    await this.audit.record({
      actorId: user.id,
      action: 'question.import.start',
      entityType: 'QuestionImportJob',
      entityId: job.id,
      ctx,
    });
    return job;
  }

  async getImport(id: string) {
    const job = await this.prisma.questionImportJob.findUnique({ where: { id } });
    if (!job) throw AppError.notFound('Import job');
    return job;
  }

  listImports() {
    return this.prisma.questionImportJob.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  // ───────── Helpers ─────────

  private assertContent(type: QuestionType, content: ContentInput) {
    const errors = validateQuestionContent(type, content);
    if (errors.length)
      throw new AppError(
        'INVALID_QUESTION_CONTENT',
        errors.join('; '),
        HttpStatus.UNPROCESSABLE_ENTITY,
        errors,
      );
  }

  private optionRows(content: ContentInput) {
    return (content.options ?? []).map((o, i) => ({
      key: o.key.toUpperCase(),
      text: o.text,
      textBn: o.textBn,
      imageFileId: o.imageFileId,
      isCorrect: o.isCorrect,
      sortOrder: i,
    }));
  }

  private writeVersion(
    tx: Tx,
    questionId: string,
    versionNumber: number,
    content: ContentInput,
    userId: string,
    changeNote?: string,
  ) {
    return tx.questionVersion.create({
      data: {
        questionId,
        versionNumber,
        stem: content.stem,
        stemBn: content.stemBn,
        imageFileId: content.imageFileId,
        defaultMarks: content.defaultMarks ?? 1,
        acceptedAnswers: content.acceptedAnswers ?? [],
        rubric: content.rubric,
        changeNote,
        createdById: userId,
        status: ContentStatus.DRAFT,
        options: { create: this.optionRows(content) },
        explanation: content.explanation
          ? { create: { ...content.explanation, references: content.explanation.references ?? [] } }
          : undefined,
      },
    });
  }

  private async assertRefs(
    tx: Tx,
    dto: {
      subjectId?: string;
      topicId?: string;
      passageId?: string;
      sourceId?: string;
      extraTopicIds?: string[];
      examIds?: string[];
    },
  ) {
    if (dto.subjectId && !(await tx.subject.count({ where: { id: dto.subjectId } })))
      throw AppError.badRequest('INVALID_SUBJECT', 'Subject not found');
    if (dto.topicId) {
      const topic = await tx.topic.findUnique({ where: { id: dto.topicId }, include: { chapter: true } });
      if (!topic) throw AppError.badRequest('INVALID_TOPIC', 'Topic not found');
      if (dto.subjectId && topic.chapter.subjectId !== dto.subjectId)
        throw AppError.badRequest('TOPIC_SUBJECT_MISMATCH', 'Topic does not belong to the subject');
    }
    if (dto.passageId && !(await tx.questionPassage.count({ where: { id: dto.passageId } })))
      throw AppError.badRequest('INVALID_PASSAGE', 'Passage not found');
    if (dto.sourceId && !(await tx.questionSource.count({ where: { id: dto.sourceId } })))
      throw AppError.badRequest('INVALID_SOURCE', 'Source not found');
    if (
      dto.extraTopicIds?.length &&
      (await tx.topic.count({ where: { id: { in: dto.extraTopicIds } } })) !== new Set(dto.extraTopicIds).size
    ) {
      throw AppError.badRequest('INVALID_TOPIC', 'One or more topics not found');
    }
    if (
      dto.examIds?.length &&
      (await tx.exam.count({ where: { id: { in: dto.examIds } } })) !== new Set(dto.examIds).size
    ) {
      throw AppError.badRequest('INVALID_EXAM', 'One or more exams not found');
    }
  }

  private async syncLinks(
    tx: Tx,
    questionId: string,
    dto: { extraTopicIds?: string[]; examIds?: string[]; tags?: string[] },
  ) {
    if (dto.extraTopicIds) {
      await tx.questionTopic.deleteMany({ where: { questionId } });
      await tx.questionTopic.createMany({
        data: [...new Set(dto.extraTopicIds)].map((topicId) => ({ questionId, topicId })),
      });
    }
    if (dto.examIds) {
      await tx.examQuestionMapping.deleteMany({ where: { questionId } });
      await tx.examQuestionMapping.createMany({
        data: [...new Set(dto.examIds)].map((examId) => ({ questionId, examId })),
      });
    }
    if (dto.tags) {
      await tx.questionTagLink.deleteMany({ where: { questionId } });
      for (const name of [...new Set(dto.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]) {
        const tag = await tx.questionTag.upsert({ where: { name }, create: { name }, update: {} });
        await tx.questionTagLink.create({ data: { questionId, tagId: tag.id } });
      }
    }
  }

  private async getLatest(id: string) {
    const q = await this.prisma.question.findUnique({ where: { id }, include: { latestVersion: true } });
    if (!q || q.deletedAt || !q.latestVersion) throw AppError.notFound('Question');
    return q;
  }
}
