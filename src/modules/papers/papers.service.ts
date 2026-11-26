import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AnswerKeyType,
  ContentStatus,
  PaperVerification,
  Prisma,
  PublishStatus,
  QuestionSourceType,
  SelectionMode,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { centiToDecimal, decToNumber, toCenti } from '../../common/utils/marks.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { QUEUES } from '../../queue/queue.constants';
import { AuditService } from '../audit/audit.service';
import { toStudentView } from '../questions/question-views';
import { PUBLISHED_QUESTION, QuestionsService } from '../questions/questions.service';
import {
  AttachQuestionsDto,
  CreatePaperDto,
  DisputeDto,
  ImportPaperDto,
  PaperQueryDto,
  UpdatePaperDto,
  VerifyPaperDto,
} from './papers.dto';

@Injectable()
export class PapersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.QUESTION_IMPORT) private readonly importQueue: Queue,
  ) {}

  // ───────── Admin: archive management ─────────

  async create(dto: CreatePaperDto, actor: AuthUser, ctx: RequestContext) {
    if (!(await this.prisma.exam.count({ where: { id: dto.examId } }))) throw AppError.notFound('Exam');
    const paper = await this.prisma.$transaction(async (tx) => {
      const p = await tx.previousYearPaper.create({
        data: {
          examId: dto.examId,
          stageId: dto.stageId,
          year: dto.year,
          title: dto.title,
          sourceReference: dto.sourceReference,
          heldOn: dto.heldOn ? new Date(`${dto.heldOn.slice(0, 10)}T00:00:00Z`) : null,
          durationMinutes: dto.durationMinutes,
          totalMarks: dto.totalMarks,
          negativeMarking: dto.negativeMarking,
          fileId: dto.fileId,
        },
      });
      // Every paper owns a PREVIOUS_YEAR source; it becomes "official" only after verification.
      await tx.questionSource.create({
        data: {
          type: QuestionSourceType.PREVIOUS_YEAR,
          title: dto.title,
          year: dto.year,
          paperId: p.id,
          reference: dto.sourceReference,
          isOfficial: false,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'paper.create',
          entityType: 'PreviousYearPaper',
          entityId: p.id,
          after: dto,
          ctx,
        },
        tx,
      );
      return p;
    });
    return this.adminGet(paper.id);
  }

  async update(id: string, dto: UpdatePaperDto, actor: AuthUser, ctx: RequestContext) {
    const before = await this.get(id);
    if (
      dto.status === PublishStatus.PUBLISHED &&
      !(await this.prisma.paperQuestion.count({ where: { paperId: id } }))
    ) {
      throw AppError.badRequest('PAPER_EMPTY', 'Attach questions before publishing the paper');
    }
    await this.prisma.previousYearPaper.update({
      where: { id },
      data: { ...dto, heldOn: dto.heldOn ? new Date(`${dto.heldOn.slice(0, 10)}T00:00:00Z`) : undefined },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'paper.update',
      entityType: 'PreviousYearPaper',
      entityId: id,
      before,
      after: dto,
      ctx,
    });
    return this.adminGet(id);
  }

  async attach(id: string, dto: AttachQuestionsDto, actor: AuthUser, ctx: RequestContext) {
    await this.get(id);
    const numbers = dto.items.map((i) => i.questionNumber);
    if (new Set(numbers).size !== numbers.length)
      throw AppError.badRequest('DUPLICATE_NUMBER', 'Question numbers must be unique');
    const count = await this.prisma.question.count({
      where: { id: { in: dto.items.map((i) => i.questionId) }, deletedAt: null },
    });
    if (count !== new Set(dto.items.map((i) => i.questionId)).size)
      throw AppError.badRequest('UNKNOWN_QUESTION', 'One or more questions do not exist');
    await this.prisma.$transaction(async (tx) => {
      for (const it of dto.items) {
        await tx.paperQuestion.upsert({
          where: { paperId_questionId: { paperId: id, questionId: it.questionId } },
          create: {
            paperId: id,
            questionId: it.questionId,
            questionNumber: it.questionNumber,
            section: it.section,
            marks: it.marks,
          },
          update: { questionNumber: it.questionNumber, section: it.section, marks: it.marks },
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'paper.attach',
          entityType: 'PreviousYearPaper',
          entityId: id,
          metadata: { count: dto.items.length },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  async detach(id: string, questionId: string, actor: AuthUser, ctx: RequestContext) {
    await this.prisma.paperQuestion.deleteMany({ where: { paperId: id, questionId } });
    await this.audit.record({
      actorId: actor.id,
      action: 'paper.detach',
      entityType: 'PreviousYearPaper',
      entityId: id,
      metadata: { questionId },
      ctx,
    });
    return { ok: true };
  }

  /** Bulk import of a whole paper (CSV/JSON with a question_number column) as a background job. */
  async startImport(id: string, dto: ImportPaperDto, actor: AuthUser, ctx: RequestContext) {
    await this.get(id);
    const file = await this.prisma.storedFile.findUnique({ where: { id: dto.fileId } });
    if (!file || file.purpose !== 'QUESTION_IMPORT')
      throw AppError.badRequest('INVALID_FILE', 'Upload the file with purpose QUESTION_IMPORT first');
    const job = await this.prisma.questionImportJob.create({
      data: { fileId: dto.fileId, format: dto.format, createdById: actor.id },
    });
    await this.importQueue.add(
      'import-paper',
      { jobId: job.id, submitForReview: dto.submitForReview ?? true, paperId: id },
      { jobId: `paper-import-${job.id}`, attempts: 1 },
    );
    await this.audit.record({
      actorId: actor.id,
      action: 'paper.import.start',
      entityType: 'PreviousYearPaper',
      entityId: id,
      metadata: { importJobId: job.id },
      ctx,
    });
    return job;
  }

  /**
   * Verification gate: a paper is presented as an official previous-year paper only after a staff member
   * confirms it against evidence (the authority's published copy). Verification marks its source official.
   */
  async verify(id: string, dto: VerifyPaperDto, actor: AuthUser, ctx: RequestContext) {
    const paper = await this.get(id);
    if (
      dto.status === PaperVerification.VERIFIED &&
      !dto.evidenceUrl &&
      !dto.evidenceFileId &&
      !paper.evidenceUrl &&
      !paper.evidenceFileId
    ) {
      throw AppError.badRequest(
        'EVIDENCE_REQUIRED',
        'Verification requires a link to, or an uploaded copy of, the official paper',
      );
    }
    if (
      dto.answerKeyType === AnswerKeyType.OFFICIAL &&
      dto.status === PaperVerification.VERIFIED &&
      !dto.evidenceUrl &&
      !paper.evidenceUrl &&
      !dto.evidenceFileId &&
      !paper.evidenceFileId
    ) {
      throw AppError.badRequest('EVIDENCE_REQUIRED', 'An official answer key needs evidence');
    }
    const official = dto.status === PaperVerification.VERIFIED;
    await this.prisma.$transaction(async (tx) => {
      await tx.previousYearPaper.update({
        where: { id },
        data: {
          verificationStatus: dto.status,
          answerKeyType: dto.answerKeyType ?? paper.answerKeyType,
          evidenceUrl: dto.evidenceUrl ?? paper.evidenceUrl,
          evidenceFileId: dto.evidenceFileId ?? paper.evidenceFileId,
          verifiedById: official ? actor.id : null,
          verifiedAt: official ? new Date() : null,
        },
      });
      await tx.questionSource.updateMany({ where: { paperId: id }, data: { isOfficial: official } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: `paper.verify.${dto.status.toLowerCase()}`,
          entityType: 'PreviousYearPaper',
          entityId: id,
          after: dto,
          metadata: { note: dto.note },
          ctx,
        },
        tx,
      );
    });
    return this.adminGet(id);
  }

  async dispute(id: string, questionId: string, dto: DisputeDto, actor: AuthUser, ctx: RequestContext) {
    const pq = await this.prisma.paperQuestion.findUnique({
      where: { paperId_questionId: { paperId: id, questionId } },
    });
    if (!pq) throw AppError.notFound('Paper question');
    await this.prisma.paperQuestion.update({
      where: { paperId_questionId: { paperId: id, questionId } },
      data: { answerDisputed: dto.answerDisputed, disputeNote: dto.note },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'paper.question.dispute',
      entityType: 'PreviousYearPaper',
      entityId: id,
      metadata: { questionId, ...dto },
      ctx,
    });
    return { ok: true };
  }

  /** Builds a timed mock that replays the paper in its original order (pinned question versions). */
  async createReplayMock(id: string, actor: AuthUser, ctx: RequestContext) {
    const paper = await this.prisma.previousYearPaper.findUnique({
      where: { id },
      include: { questions: { orderBy: { questionNumber: 'asc' }, include: { question: true } }, exam: true },
    });
    if (!paper) throw AppError.notFound('Paper');
    if (!paper.questions.length) throw AppError.badRequest('PAPER_EMPTY', 'The paper has no questions');
    const unpublished = paper.questions.filter(
      (q) =>
        q.question.status !== ContentStatus.PUBLISHED ||
        !q.question.publishedVersionId ||
        q.question.deletedAt,
    );
    if (unpublished.length) {
      throw new AppError(
        'PAPER_NOT_READY',
        `${unpublished.length} question(s) are not published yet`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        unpublished.map((u) => u.questionNumber),
      );
    }
    const slug = `paper-${paper.year}-${paper.id.slice(0, 8)}`;
    if (await this.prisma.mockExamTemplate.findUnique({ where: { slug } }))
      throw AppError.conflict('MOCK_EXISTS', 'A replay mock already exists for this paper', { slug });
    const marks = paper.totalMarks ? toCenti(paper.totalMarks) / paper.questions.length : 100;
    const negative = toCenti(paper.negativeMarking ?? 0);
    const duration = paper.durationMinutes ?? Math.max(10, paper.questions.length);
    const config = {
      durationMinutes: duration,
      shuffleQuestions: false,
      shuffleOptions: false,
      multiSelectPolicy: 'EXACT',
      allowNegativeTotal: false,
      resultVisibility: 'IMMEDIATE',
      sections: [
        {
          title: paper.title,
          selectionMode: 'FIXED',
          questionCount: paper.questions.length,
          marksPerQuestion: marks / 100,
          negativeMarks: negative / 100,
          questionIds: paper.questions.map((q) => q.questionId),
        },
      ],
    };
    const result = await this.prisma.$transaction(async (tx: Tx) => {
      const t = await tx.mockExamTemplate.create({
        data: {
          slug,
          title: `${paper.title} — timed replay`,
          description:
            paper.verificationStatus === PaperVerification.VERIFIED
              ? 'Replay of a verified previous-year paper.'
              : 'Replay of an unverified paper reconstruction — not confirmed against the official copy.',
          examId: paper.examId,
          stageId: paper.stageId,
          draftConfig: config as Prisma.InputJsonValue,
          createdById: actor.id,
        },
      });
      const v = await tx.mockExamTemplateVersion.create({
        data: {
          templateId: t.id,
          versionNumber: 1,
          durationMinutes: duration,
          totalMarks: centiToDecimal(Math.round(marks) * paper.questions.length),
          shuffleQuestions: false,
          shuffleOptions: false,
          configSnapshot: config as Prisma.InputJsonValue,
          publishedById: actor.id,
          sections: {
            create: [
              {
                title: paper.title,
                sequence: 1,
                selectionMode: SelectionMode.FIXED,
                questionCount: paper.questions.length,
                marksPerQuestion: centiToDecimal(Math.round(marks)),
                negativeMarks: centiToDecimal(negative),
                questions: {
                  create: paper.questions.map((q, i) => ({
                    questionVersionId: q.question.publishedVersionId!,
                    position: i,
                  })),
                },
              },
            ],
          },
        },
      });
      await tx.mockExamTemplate.update({
        where: { id: t.id },
        data: { currentVersionId: v.id, status: PublishStatus.PUBLISHED },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'paper.replay_mock',
          entityType: 'PreviousYearPaper',
          entityId: id,
          metadata: { templateId: t.id },
          ctx,
        },
        tx,
      );
      return t;
    });
    return { templateId: result.id, slug };
  }

  async adminList(q: PaperQueryDto) {
    const where: Prisma.PreviousYearPaperWhereInput = {
      examId: q.examId,
      year: q.year,
      verificationStatus: q.verificationStatus,
      status: q.status,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.previousYearPaper.findMany({
        where,
        include: { _count: { select: { questions: true } } },
        orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.previousYearPaper.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async adminGet(id: string) {
    const p = await this.prisma.previousYearPaper.findUnique({
      where: { id },
      include: {
        questions: {
          orderBy: { questionNumber: 'asc' },
          include: {
            question: { select: { code: true, status: true, latestVersion: { select: { stem: true } } } },
          },
        },
      },
    });
    if (!p) throw AppError.notFound('Paper');
    return p;
  }

  // ───────── Public ─────────

  async publicList(q: PaperQueryDto) {
    const where: Prisma.PreviousYearPaperWhereInput = {
      status: PublishStatus.PUBLISHED,
      examId: q.examId,
      year: q.year,
      verificationStatus: q.verificationStatus,
      exam: { status: PublishStatus.PUBLISHED },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.previousYearPaper.findMany({
        where,
        include: { exam: { select: { name: true, slug: true } }, _count: { select: { questions: true } } },
        orderBy: [{ year: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.previousYearPaper.count({ where }),
    ]);
    return PageResult.of(
      rows.map((p) => this.publicSummary(p, p._count.questions)),
      total,
      q,
    );
  }

  /** Paper with numbered questions — no answers (practise it with mode PAPER or the replay mock). */
  async publicGet(id: string) {
    const p = await this.prisma.previousYearPaper.findFirst({
      where: { id, status: PublishStatus.PUBLISHED },
      include: {
        exam: { select: { name: true, slug: true } },
        questions: {
          orderBy: { questionNumber: 'asc' },
          where: { question: PUBLISHED_QUESTION },
          include: { question: { select: { publishedVersionId: true } } },
        },
      },
    });
    if (!p) throw AppError.notFound('Paper');
    const versions = await this.questions.loadVersions(
      p.questions.map((q) => q.question.publishedVersionId!),
    );
    const replay = await this.prisma.mockExamTemplate.findFirst({
      where: { slug: `paper-${p.year}-${p.id.slice(0, 8)}`, status: PublishStatus.PUBLISHED },
      select: { id: true },
    });
    return {
      ...this.publicSummary(p, p.questions.length),
      replayMockId: replay?.id ?? null,
      questions: p.questions.map((pq) => ({
        questionNumber: pq.questionNumber,
        section: pq.section,
        answerDisputed: pq.answerDisputed,
        disputeNote: pq.answerDisputed ? pq.disputeNote : null,
        ...toStudentView(versions.get(pq.question.publishedVersionId!)!),
      })),
    };
  }

  private publicSummary(
    p: {
      id: string;
      examId: string;
      year: number;
      title: string;
      heldOn: Date | null;
      durationMinutes: number | null;
      totalMarks: Prisma.Decimal | null;
      negativeMarking: Prisma.Decimal | null;
      verificationStatus: PaperVerification;
      answerKeyType: AnswerKeyType;
      sourceReference: string | null;
      exam?: { name: string; slug: string };
    },
    questionCount: number,
  ) {
    return {
      id: p.id,
      examId: p.examId,
      examName: p.exam?.name ?? null,
      year: p.year,
      title: p.title,
      heldOn: p.heldOn,
      durationMinutes: p.durationMinutes,
      totalMarks: decToNumber(p.totalMarks),
      negativeMarking: decToNumber(p.negativeMarking),
      verificationStatus: p.verificationStatus,
      answerKeyType: p.answerKeyType,
      sourceReference: p.sourceReference,
      questionCount,
      disclaimer:
        p.verificationStatus === PaperVerification.VERIFIED
          ? p.answerKeyType === AnswerKeyType.OFFICIAL
            ? 'Verified against the official paper; answers follow the official key.'
            : 'Questions verified against the official paper; answers are expert solutions, not an official key.'
          : 'Not yet verified against the official paper. Treat as a reconstruction.',
    };
  }

  // ───────── Topic frequency (what gets asked) ─────────

  /** How often each topic appears across the exam's papers (verified papers only by default). */
  async topicFrequency(examId: string, opts: { verifiedOnly?: boolean; years?: number } = {}) {
    const verifiedOnly = opts.verifiedOnly ?? true;
    const minYear = opts.years ? new Date().getUTCFullYear() - opts.years : 0;
    const rows = await this.prisma.$queryRaw<
      Array<{
        topicId: string;
        topicName: string;
        subjectName: string;
        appearances: bigint;
        papers: bigint;
        lastYear: number;
      }>
    >`
      SELECT t.id AS "topicId", t.name AS "topicName", s.name AS "subjectName",
             COUNT(*) AS appearances, COUNT(DISTINCT p.id) AS papers, MAX(p.year) AS "lastYear"
        FROM paper_questions pq
        JOIN previous_year_papers p ON p.id = pq."paperId"
        JOIN questions q ON q.id = pq."questionId"
        JOIN topics t ON t.id = q."topicId"
        JOIN chapters c ON c.id = t."chapterId"
        JOIN subjects s ON s.id = c."subjectId"
       WHERE p."examId" = ${examId}::uuid AND p.year >= ${minYear}
         AND (${verifiedOnly} = false OR p."verificationStatus" = 'VERIFIED')
       GROUP BY t.id, t.name, s.name
       ORDER BY appearances DESC`;
    const totalPapers = await this.prisma.previousYearPaper.count({
      where: {
        examId,
        year: { gte: minYear },
        ...(verifiedOnly ? { verificationStatus: PaperVerification.VERIFIED } : {}),
      },
    });
    const totalQuestions = rows.reduce((n, r) => n + Number(r.appearances), 0);
    return {
      examId,
      totalPapers,
      totalQuestions,
      topics: rows.map((r) => ({
        topicId: r.topicId,
        topicName: r.topicName,
        subjectName: r.subjectName,
        appearances: Number(r.appearances),
        papersWithTopic: Number(r.papers),
        coverage: totalPapers ? Math.round((Number(r.papers) / totalPapers) * 10000) / 100 : 0,
        share: totalQuestions ? Math.round((Number(r.appearances) / totalQuestions) * 10000) / 100 : 0,
        lastAskedYear: r.lastYear,
      })),
    };
  }

  /** Explicit admin action: set syllabus weights from past-paper frequency (normalised to 0.1–1.0). */
  async applyFrequencyWeights(versionId: string, actor: AuthUser, ctx: RequestContext) {
    const version = await this.prisma.syllabusVersion.findUnique({ where: { id: versionId } });
    if (!version) throw AppError.notFound('Syllabus version');
    const freq = await this.topicFrequency(version.examId);
    if (!freq.topics.length)
      throw AppError.badRequest('NO_PAPER_DATA', 'No verified past-paper data for this exam');
    const max = Math.max(...freq.topics.map((t) => t.appearances));
    await this.prisma.$transaction(async (tx) => {
      for (const t of freq.topics) {
        const weight = new Prisma.Decimal(Math.max(0.1, Math.round((t.appearances / max) * 1000) / 1000));
        await tx.examTopicMapping.upsert({
          where: { syllabusVersionId_topicId: { syllabusVersionId: versionId, topicId: t.topicId } },
          create: { examId: version.examId, syllabusVersionId: versionId, topicId: t.topicId, weight },
          update: { weight },
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'syllabus.weights.from_papers',
          entityType: 'SyllabusVersion',
          entityId: versionId,
          metadata: { topics: freq.topics.length, papers: freq.totalPapers },
          ctx,
        },
        tx,
      );
    });
    return { updated: freq.topics.length, basedOnPapers: freq.totalPapers };
  }

  private async get(id: string) {
    const p = await this.prisma.previousYearPaper.findUnique({ where: { id } });
    if (!p) throw AppError.notFound('Paper');
    return p;
  }
}
