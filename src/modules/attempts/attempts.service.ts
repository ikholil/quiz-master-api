import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AccessLevel,
  AttemptStatus,
  ClientPlatform,
  EvaluationStatus,
  Prisma,
  PublishStatus,
  QuestionType,
  ResultStatus,
  ResultVisibility,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { centiToDecimal, decToNumber, fromCenti, toCenti } from '../../common/utils/marks.util';
import { seededRandom, shuffle } from '../../common/utils/random.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { AuditService } from '../audit/audit.service';
import { QuestionSelector } from '../mock-exams/question-selector';
import { GamificationService } from '../gamification/gamification.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MANUAL_TYPES } from '../questions/question-content';
import { toAnswerKey, toScoringQuestion, toStudentView } from '../questions/question-views';
import { QuestionsService } from '../questions/questions.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';
import {
  AdminAttemptQueryDto,
  AttemptQueryDto,
  BatchAnswerItemDto,
  EvaluateAnswerDto,
  EvaluationQueueQueryDto,
  SaveAnswerDto,
} from './attempts.dto';
import { SCORING_VERSION, ScoringItem, scoreAttempt } from './scoring';

export interface RulesSnapshot {
  scoringVersion: string;
  templateId: string;
  templateVersionId: string;
  versionNumber: number;
  title: string;
  durationMinutes: number;
  totalMarks: number;
  passMarks: number | null;
  multiSelectPolicy: 'EXACT' | 'PARTIAL';
  allowNegativeTotal: boolean;
  resultVisibility: ResultVisibility;
  availableUntil: string | null;
  sections: Array<{
    id: string;
    title: string;
    sequence: number;
    questionCount: number;
    marksPerQuestion: number;
    negativeMarks: number;
  }>;
}

const MAX_TIME_PER_SAVE_MS = 30 * 60 * 1000;

@Injectable()
export class AttemptsService {
  private readonly logger = new Logger(AttemptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly selector: QuestionSelector,
    private readonly questions: QuestionsService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SystemConfigService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly gamification: GamificationService,
    @InjectQueue(QUEUES.ATTEMPTS) private readonly attemptsQueue: Queue,
    @InjectQueue(QUEUES.LEARNING) private readonly learningQueue: Queue,
  ) {}

  // ───────── Start / resume ─────────

  async start(user: AuthUser, templateId: string, platform: ClientPlatform = ClientPlatform.OTHER) {
    const template = await this.prisma.mockExamTemplate.findFirst({
      where: { id: templateId, status: PublishStatus.PUBLISHED, currentVersionId: { not: null } },
      include: {
        currentVersion: {
          include: {
            sections: {
              orderBy: { sequence: 'asc' },
              include: { questions: { include: { questionVersion: { select: { questionId: true } } } } },
            },
          },
        },
      },
    });
    if (!template) throw AppError.notFound('Mock exam');
    const version = template.currentVersion!;

    // Resume: one in-progress attempt per template version (also enforced by a partial unique index).
    const active = await this.prisma.examAttempt.findFirst({
      where: { userId: user.id, templateVersionId: version.id, status: AttemptStatus.IN_PROGRESS },
    });
    if (active) {
      if (active.expiresAt.getTime() + (await this.graceMs()) < Date.now()) {
        await this.finalize(active.id, true);
      } else {
        return this.getState(user.id, active.id);
      }
    }

    if (template.accessLevel === AccessLevel.PREMIUM)
      await this.entitlements.assert(user.id, FEATURES.MOCK_PREMIUM);
    const now = new Date();
    if (version.availableFrom && now < version.availableFrom)
      throw AppError.badRequest('EXAM_NOT_STARTED', 'This exam has not opened yet', {
        availableFrom: version.availableFrom,
      });
    if (version.availableUntil && now >= version.availableUntil)
      throw AppError.badRequest('EXAM_CLOSED', 'This exam window has closed');

    const used = await this.prisma.examAttempt.count({
      where: { userId: user.id, templateVersionId: version.id },
    });
    if (version.maxAttempts && used >= version.maxAttempts)
      throw AppError.conflict('MAX_ATTEMPTS_REACHED', 'You have used all attempts for this exam');

    const durationMs = version.durationMinutes * 60_000;
    const expiresAt = new Date(
      Math.min(now.getTime() + durationMs, version.availableUntil?.getTime() ?? Infinity),
    );
    const seed = randomBytes(16).toString('hex');
    const rand = seededRandom(seed);

    const rules: RulesSnapshot = {
      scoringVersion: SCORING_VERSION,
      templateId: template.id,
      templateVersionId: version.id,
      versionNumber: version.versionNumber,
      title: template.title,
      durationMinutes: version.durationMinutes,
      totalMarks: decToNumber(version.totalMarks)!,
      passMarks: decToNumber(version.passMarks),
      multiSelectPolicy: version.multiSelectPolicy,
      allowNegativeTotal: version.allowNegativeTotal,
      resultVisibility: version.resultVisibility,
      availableUntil: version.availableUntil?.toISOString() ?? null,
      sections: version.sections.map((s) => ({
        id: s.id,
        title: s.title,
        sequence: s.sequence,
        questionCount: s.questionCount,
        marksPerQuestion: decToNumber(s.marksPerQuestion)!,
        negativeMarks: decToNumber(s.negativeMarks)!,
      })),
    };

    let attemptId: string;
    try {
      attemptId = await this.prisma.$transaction(
        async (tx) => {
          const picked = new Set<string>();
          const items: Array<{
            sectionId: string;
            questionId: string;
            versionId: string;
            maxMarks: Prisma.Decimal;
            negativeMarks: Prisma.Decimal;
          }> = [];
          for (const section of version.sections) {
            const chosen = await this.selector.selectForSection(section, picked, rand, tx);
            const ordered = version.shuffleQuestions ? shuffle(chosen, rand) : chosen;
            for (const c of ordered) {
              picked.add(c.questionId);
              items.push({
                sectionId: section.id,
                questionId: c.questionId,
                versionId: c.versionId,
                maxMarks: section.marksPerQuestion,
                negativeMarks: section.negativeMarks,
              });
            }
          }
          const optionSets = await tx.questionOption.findMany({
            where: { versionId: { in: items.map((i) => i.versionId) } },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, versionId: true },
          });
          const optionsByVersion = new Map<string, string[]>();
          for (const o of optionSets)
            optionsByVersion.set(o.versionId, [...(optionsByVersion.get(o.versionId) ?? []), o.id]);

          const attempt = await tx.examAttempt.create({
            data: {
              userId: user.id,
              templateVersionId: version.id,
              attemptNumber: used + 1,
              rulesSnapshot: rules as unknown as Prisma.InputJsonValue,
              seed,
              startedAt: now,
              expiresAt,
              clientPlatform: platform,
            },
          });
          await tx.attemptAnswer.createMany({
            data: items.map((it, idx) => {
              const opts = optionsByVersion.get(it.versionId) ?? [];
              return {
                attemptId: attempt.id,
                sectionId: it.sectionId,
                questionId: it.questionId,
                questionVersionId: it.versionId,
                position: idx + 1,
                optionOrder: version.shuffleOptions ? shuffle(opts, rand) : opts,
                maxMarks: it.maxMarks,
                negativeMarks: it.negativeMarks,
              };
            }),
          });
          return attempt.id;
        },
        { timeout: 20000 },
      );
    } catch (err) {
      // Concurrent double-tap on "start": the partial unique index rejects the second insert.
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.examAttempt.findFirst({
          where: { userId: user.id, templateVersionId: version.id, status: AttemptStatus.IN_PROGRESS },
        });
        if (existing) return this.getState(user.id, existing.id);
      }
      throw err;
    }

    const grace = await this.graceMs();
    await this.attemptsQueue.add(
      JOBS.AUTO_SUBMIT_ATTEMPT,
      { attemptId },
      { jobId: `auto-submit-${attemptId}`, delay: Math.max(0, expiresAt.getTime() - Date.now() + grace) },
    );
    return this.getState(user.id, attemptId);
  }

  // ───────── State ─────────

  async getState(userId: string, attemptId: string) {
    let attempt = await this.ownedAttempt(userId, attemptId);
    if (
      attempt.status === AttemptStatus.IN_PROGRESS &&
      attempt.expiresAt.getTime() + (await this.graceMs()) < Date.now()
    ) {
      await this.finalize(attempt.id, true);
      attempt = await this.ownedAttempt(userId, attemptId);
    }
    const rules = attempt.rulesSnapshot as unknown as RulesSnapshot;
    const answers = await this.prisma.attemptAnswer.findMany({
      where: { attemptId },
      orderBy: { position: 'asc' },
    });
    const versions = await this.questions.loadVersions(answers.map((a) => a.questionVersionId));
    const now = new Date();
    return {
      id: attempt.id,
      templateId: rules.templateId,
      title: rules.title,
      status: attempt.status,
      attemptNumber: attempt.attemptNumber,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      serverTime: now,
      remainingSeconds:
        attempt.status === AttemptStatus.IN_PROGRESS
          ? Math.max(0, Math.floor((attempt.expiresAt.getTime() - now.getTime()) / 1000))
          : 0,
      durationMinutes: rules.durationMinutes,
      totalMarks: rules.totalMarks,
      sections: rules.sections.map((s) => ({
        id: s.id,
        title: s.title,
        sequence: s.sequence,
        questionCount: s.questionCount,
      })),
      questions: answers.map((a) => ({
        ...toStudentView(versions.get(a.questionVersionId)!, a.optionOrder),
        answerId: a.id,
        position: a.position,
        sectionId: a.sectionId,
        maxMarks: decToNumber(a.maxMarks)!,
        negativeMarks: decToNumber(a.negativeMarks)!,
        selectedOptionIds: a.selectedOptionIds,
        textAnswer: a.textAnswer,
        flagged: a.flagged,
      })),
      answeredCount: answers.filter((a) => a.answeredAt).length,
    };
  }

  // ───────── Answers ─────────

  async saveAnswer(userId: string, attemptId: string, answerId: string, dto: SaveAnswerDto) {
    const res = await this.saveAnswers(userId, attemptId, [{ answerId, ...dto }]);
    return res[0];
  }

  /** Saves one or many answers (offline sync). Only the owner may write, only while the attempt is open. */
  async saveAnswers(userId: string, attemptId: string, items: BatchAnswerItemDto[]) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status !== AttemptStatus.IN_PROGRESS)
      throw AppError.conflict('ATTEMPT_NOT_IN_PROGRESS', 'This attempt has already been submitted');
    if (Date.now() > attempt.expiresAt.getTime() + (await this.graceMs())) {
      await this.finalize(attemptId, true);
      throw AppError.conflict('ATTEMPT_EXPIRED', 'Time is over; the attempt was submitted automatically');
    }
    if (new Set(items.map((i) => i.answerId)).size !== items.length)
      throw AppError.badRequest('DUPLICATE_ANSWER', 'Each answer may appear once per request');

    const rows = await this.prisma.attemptAnswer.findMany({
      where: { attemptId, id: { in: items.map((i) => i.answerId) } },
      include: { questionVersion: { select: { question: { select: { type: true } } } } },
    });
    if (rows.length !== items.length)
      throw AppError.badRequest('INVALID_ANSWER_ID', 'One or more answers do not belong to this attempt');
    const byId = new Map(rows.map((r) => [r.id, r]));

    const updates = items.map((item) => {
      const row = byId.get(item.answerId)!;
      const type = row.questionVersion.question.type;
      const data: Prisma.AttemptAnswerUpdateInput = {};
      if (item.selectedOptionIds !== undefined) {
        if (type === QuestionType.SHORT_ANSWER || MANUAL_TYPES.includes(type))
          throw AppError.badRequest('INVALID_ANSWER', 'This question takes a text answer');
        const unique = [...new Set(item.selectedOptionIds)];
        if (unique.some((id) => !row.optionOrder.includes(id)))
          throw AppError.badRequest('INVALID_OPTION', 'Selected option does not belong to the question');
        if (type !== QuestionType.MULTIPLE_CHOICE && unique.length > 1)
          throw AppError.badRequest('INVALID_ANSWER', 'Only one option may be selected');
        data.selectedOptionIds = unique;
      }
      if (item.textAnswer !== undefined) {
        if (type !== QuestionType.SHORT_ANSWER && !MANUAL_TYPES.includes(type))
          throw AppError.badRequest('INVALID_ANSWER', 'This question takes option answers');
        data.textAnswer = item.textAnswer?.trim() ? item.textAnswer : null;
      }
      if (item.flagged !== undefined) data.flagged = item.flagged;
      if (item.timeSpentMs)
        data.timeSpentMs = { increment: Math.min(item.timeSpentMs, MAX_TIME_PER_SAVE_MS) };
      if (item.selectedOptionIds !== undefined || item.textAnswer !== undefined) {
        const answered = (data.selectedOptionIds as string[] | undefined)?.length || data.textAnswer;
        data.answeredAt = answered ? new Date() : null;
      }
      return { id: row.id, data };
    });

    // Conditional on the attempt still being open: a concurrent submit wins and these writes are rejected.
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.examAttempt.updateMany({
        where: { id: attemptId, status: AttemptStatus.IN_PROGRESS },
        data: { updatedAt: new Date() },
      });
      if (!open.count)
        throw AppError.conflict('ATTEMPT_NOT_IN_PROGRESS', 'This attempt has already been submitted');
      for (const u of updates) await tx.attemptAnswer.update({ where: { id: u.id }, data: u.data });
    });
    const saved = await this.prisma.attemptAnswer.findMany({
      where: { id: { in: updates.map((u) => u.id) } },
      select: { id: true, selectedOptionIds: true, textAnswer: true, flagged: true, answeredAt: true },
    });
    return saved.map((s) => ({
      answerId: s.id,
      selectedOptionIds: s.selectedOptionIds,
      textAnswer: s.textAnswer,
      flagged: s.flagged,
      answeredAt: s.answeredAt,
    }));
  }

  // ───────── Submit & evaluate ─────────

  async submit(userId: string, attemptId: string, idempotencyKey?: string) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS) {
      if (idempotencyKey) {
        const reused = await this.prisma.examAttempt.findFirst({
          where: { userId, submissionKey: idempotencyKey, id: { not: attemptId } },
        });
        if (reused)
          throw AppError.conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used for another attempt',
          );
      }
      await this.finalize(attemptId, false, idempotencyKey);
    }
    // Already submitted (retry / double tap): return the stored result without re-scoring.
    return this.getResult(userId, attemptId);
  }

  /**
   * Closes and scores an attempt exactly once. The status transition is a conditional update inside the
   * transaction, and AttemptResult.attemptId is unique, so concurrent submit/auto-submit cannot double-score.
   */
  async finalize(attemptId: string, auto: boolean, submissionKey?: string): Promise<boolean> {
    const done = await this.prisma.$transaction(
      async (tx) => {
        const attempt = await tx.examAttempt.findUnique({ where: { id: attemptId } });
        if (!attempt || attempt.status !== AttemptStatus.IN_PROGRESS) return false;
        const submittedAt = new Date(Math.min(Date.now(), attempt.expiresAt.getTime()));
        const closed = await tx.examAttempt.updateMany({
          where: { id: attemptId, status: AttemptStatus.IN_PROGRESS },
          data: {
            status: auto ? AttemptStatus.AUTO_SUBMITTED : AttemptStatus.SUBMITTED,
            submittedAt,
            submissionKey: submissionKey ?? null,
          },
        });
        if (closed.count !== 1) return false;
        await this.evaluate(tx, attemptId);
        return true;
      },
      { timeout: 20000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    if (done) {
      await this.attemptsQueue.remove(`auto-submit-${attemptId}`).catch(() => undefined);
      const attempt = await this.prisma.examAttempt.findUnique({
        where: { id: attemptId },
        include: { result: true },
      });
      if (attempt) {
        await this.learningQueue.add(
          JOBS.UPDATE_MASTERY,
          { source: 'attempt', id: attemptId, userId: attempt.userId },
          { jobId: `mastery-attempt-${attemptId}` },
        );
        await this.gamification.onAttemptFinalized(attemptId);
        const rules = attempt.rulesSnapshot as unknown as RulesSnapshot;
        await this.notifications.notify(attempt.userId, {
          type: 'attempt.submitted',
          title: auto ? 'সময় শেষ — পরীক্ষা জমা হয়েছে' : 'পরীক্ষা জমা হয়েছে',
          body: `${rules.title}: ${attempt.result ? `${decToNumber(attempt.result.obtainedMarks)}/${decToNumber(attempt.result.totalMarks)}` : 'result pending'}`,
          data: { attemptId },
        });
      }
    }
    return done;
  }

  /** Scores all answers of an attempt from immutable snapshots and writes/updates its result. */
  private async evaluate(tx: Tx, attemptId: string) {
    const attempt = await tx.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const rules = attempt.rulesSnapshot as unknown as RulesSnapshot;
    const answers = await tx.attemptAnswer.findMany({ where: { attemptId }, orderBy: { position: 'asc' } });
    const versions = await tx.questionVersion.findMany({
      where: { id: { in: answers.map((a) => a.questionVersionId) } },
      include: {
        options: { orderBy: { sortOrder: 'asc' } },
        explanation: true,
        question: { include: { passage: true, source: true } },
      },
    });
    const vById = new Map(versions.map((v) => [v.id, v]));

    const items: ScoringItem[] = answers.map((a) => {
      const q = toScoringQuestion(vById.get(a.questionVersionId)!);
      return {
        id: a.id,
        sectionId: a.sectionId,
        ...q,
        maxMarksCenti: toCenti(a.maxMarks),
        negativeCenti: toCenti(a.negativeMarks),
        selectedOptionIds: a.selectedOptionIds,
        textAnswer: a.textAnswer,
        manualAwardCenti:
          a.evaluationStatus === EvaluationStatus.MANUAL_EVALUATED ? toCenti(a.awardedMarks) : null,
      };
    });
    const score = scoreAttempt(
      items,
      {
        multiSelectPolicy: rules.multiSelectPolicy,
        allowNegativeTotal: rules.allowNegativeTotal,
        passMarksCenti: rules.passMarks === null ? null : toCenti(rules.passMarks),
      },
      rules.sections.map((s) => s.id),
    );

    for (const s of score.items) {
      const status =
        s.outcome === 'PENDING_MANUAL'
          ? EvaluationStatus.MANUAL_PENDING
          : s.outcome === 'MANUAL'
            ? EvaluationStatus.MANUAL_EVALUATED
            : EvaluationStatus.AUTO_EVALUATED;
      await tx.attemptAnswer.update({
        where: { id: s.id },
        data: {
          isCorrect: s.isCorrect,
          awardedMarks: s.awardedCenti === null ? null : centiToDecimal(s.awardedCenti),
          evaluationStatus: status,
        },
      });
    }

    const titles = new Map(rules.sections.map((s) => [s.id, s.title]));
    const sectionBreakdown = score.sections.map((s) => ({
      sectionId: s.sectionId,
      title: titles.get(s.sectionId) ?? '',
      maxMarks: fromCenti(s.maxCenti),
      obtainedMarks: fromCenti(s.obtainedCenti),
      correct: s.correct,
      partial: s.partial,
      wrong: s.wrong,
      skipped: s.skipped,
      pending: s.pending,
    }));
    const end = attempt.submittedAt ?? new Date();
    const data = {
      status: score.pending ? ResultStatus.PROVISIONAL : ResultStatus.FINAL,
      totalMarks: centiToDecimal(score.totalCenti),
      obtainedMarks: centiToDecimal(score.obtainedCenti),
      correctCount: score.correct,
      wrongCount: score.wrong,
      skippedCount: score.skipped,
      pendingCount: score.pending,
      accuracy: new Prisma.Decimal(score.accuracy.toFixed(2)),
      passed: score.passed,
      sectionBreakdown: sectionBreakdown as unknown as Prisma.InputJsonValue,
      scoringVersion: rules.scoringVersion ?? SCORING_VERSION,
      timeTakenSeconds: Math.max(
        0,
        Math.round(
          (Math.min(end.getTime(), attempt.expiresAt.getTime()) - attempt.startedAt.getTime()) / 1000,
        ),
      ),
      evaluatedAt: new Date(),
      finalizedAt: score.pending ? null : new Date(),
    };
    await tx.attemptResult.upsert({
      where: { attemptId },
      create: { attemptId, templateVersionId: attempt.templateVersionId, userId: attempt.userId, ...data },
      update: data,
    });
    await tx.examAttempt.update({
      where: { id: attemptId },
      data: { status: score.pending ? AttemptStatus.PENDING_MANUAL_REVIEW : AttemptStatus.EVALUATED },
    });
  }

  // ───────── Results & review ─────────

  async getResult(userId: string, attemptId: string) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS)
      throw AppError.conflict('ATTEMPT_NOT_SUBMITTED', 'Submit the attempt to see the result');
    const rules = attempt.rulesSnapshot as unknown as RulesSnapshot;
    this.assertResultVisible(rules);
    const result = await this.prisma.attemptResult.findUnique({ where: { attemptId } });
    if (!result) throw AppError.notFound('Result');

    const [higher, participants, lower] = await this.prisma.$transaction([
      this.prisma.attemptResult.count({
        where: {
          templateVersionId: result.templateVersionId,
          status: ResultStatus.FINAL,
          obtainedMarks: { gt: result.obtainedMarks },
        },
      }),
      this.prisma.attemptResult.count({
        where: { templateVersionId: result.templateVersionId, status: ResultStatus.FINAL },
      }),
      this.prisma.attemptResult.count({
        where: {
          templateVersionId: result.templateVersionId,
          status: ResultStatus.FINAL,
          obtainedMarks: { lt: result.obtainedMarks },
        },
      }),
    ]);
    const final = result.status === ResultStatus.FINAL;
    return {
      attemptId,
      attemptStatus: attempt.status,
      status: result.status,
      totalMarks: decToNumber(result.totalMarks)!,
      obtainedMarks: decToNumber(result.obtainedMarks)!,
      correctCount: result.correctCount,
      wrongCount: result.wrongCount,
      skippedCount: result.skippedCount,
      pendingCount: result.pendingCount,
      accuracy: decToNumber(result.accuracy)!,
      passed: result.passed,
      timeTakenSeconds: result.timeTakenSeconds,
      sections: result.sectionBreakdown as unknown[],
      rank: final ? higher + 1 : null,
      percentile: final && participants ? Math.round((lower / participants) * 10000) / 100 : null,
      participants,
      scoringVersion: result.scoringVersion,
      evaluatedAt: result.evaluatedAt,
    };
  }

  /** Detailed answer review with explanations — never available while the attempt is in progress. */
  async review(userId: string, attemptId: string) {
    const attempt = await this.ownedAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.IN_PROGRESS)
      throw AppError.forbidden('Answers are hidden until the attempt is submitted', 'ATTEMPT_NOT_SUBMITTED');
    this.assertResultVisible(attempt.rulesSnapshot as unknown as RulesSnapshot);
    const answers = await this.prisma.attemptAnswer.findMany({
      where: { attemptId },
      orderBy: { position: 'asc' },
    });
    const versions = await this.questions.loadVersions(answers.map((a) => a.questionVersionId));
    return answers.map((a) => {
      const v = versions.get(a.questionVersionId)!;
      const key = toAnswerKey(v);
      return {
        ...toStudentView(v, a.optionOrder),
        answerId: a.id,
        position: a.position,
        sectionId: a.sectionId,
        maxMarks: decToNumber(a.maxMarks)!,
        negativeMarks: decToNumber(a.negativeMarks)!,
        selectedOptionIds: a.selectedOptionIds,
        textAnswer: a.textAnswer,
        flagged: a.flagged,
        correctOptionIds: key.correctOptionIds,
        acceptedAnswers: key.acceptedAnswers,
        explanation: key.explanation,
        explanationBn: key.explanationBn,
        isCorrect: a.isCorrect,
        awardedMarks: decToNumber(a.awardedMarks),
        evaluationStatus: a.evaluationStatus,
        evaluatorComment: a.evaluatorComment,
      };
    });
  }

  async history(userId: string, q: AttemptQueryDto) {
    const where: Prisma.ExamAttemptWhereInput = {
      userId,
      status: q.status,
      templateVersion: q.templateId ? { templateId: q.templateId } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.examAttempt.findMany({
        where,
        include: { result: true },
        orderBy: { startedAt: q.sortOrder },
        ...pageArgs(q),
      }),
      this.prisma.examAttempt.count({ where }),
    ]);
    return PageResult.of(
      rows.map((a) => {
        const rules = a.rulesSnapshot as unknown as RulesSnapshot;
        const visible = this.resultVisible(rules);
        return {
          id: a.id,
          templateId: rules.templateId,
          title: rules.title,
          status: a.status,
          attemptNumber: a.attemptNumber,
          startedAt: a.startedAt,
          submittedAt: a.submittedAt,
          obtainedMarks: visible && a.result ? decToNumber(a.result.obtainedMarks) : null,
          totalMarks: rules.totalMarks,
          accuracy: visible && a.result ? decToNumber(a.result.accuracy) : null,
        };
      }),
      total,
      q,
    );
  }

  // ───────── Manual evaluation (admin) ─────────

  async evaluationQueue(q: EvaluationQueueQueryDto) {
    const where: Prisma.AttemptAnswerWhereInput = {
      evaluationStatus: EvaluationStatus.MANUAL_PENDING,
      attempt: q.templateId ? { templateVersion: { templateId: q.templateId } } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attemptAnswer.findMany({
        where,
        include: {
          questionVersion: {
            select: { stem: true, rubric: true, question: { select: { type: true, code: true } } },
          },
          attempt: { select: { submittedAt: true } },
        },
        orderBy: { attempt: { submittedAt: 'asc' } },
        ...pageArgs(q),
      }),
      this.prisma.attemptAnswer.count({ where }),
    ]);
    // Evaluators see the answer, not the student's identity (blind marking).
    return PageResult.of(
      rows.map((r) => ({
        answerId: r.id,
        attemptId: r.attemptId,
        questionCode: r.questionVersion.question.code,
        type: r.questionVersion.question.type,
        stem: r.questionVersion.stem,
        rubric: r.questionVersion.rubric,
        textAnswer: r.textAnswer,
        maxMarks: decToNumber(r.maxMarks),
        submittedAt: r.attempt.submittedAt,
      })),
      total,
      q,
    );
  }

  async evaluateAnswer(answerId: string, dto: EvaluateAnswerDto, evaluator: AuthUser, ctx: RequestContext) {
    const answer = await this.prisma.attemptAnswer.findUnique({
      where: { id: answerId },
      include: { attempt: true },
    });
    if (!answer) throw AppError.notFound('Answer');
    if (answer.attempt.userId === evaluator.id)
      throw AppError.forbidden('You cannot evaluate your own attempt', 'SELF_EVALUATION_FORBIDDEN');
    if (
      !([EvaluationStatus.MANUAL_PENDING, EvaluationStatus.MANUAL_EVALUATED] as EvaluationStatus[]).includes(
        answer.evaluationStatus,
      )
    ) {
      throw AppError.badRequest('NOT_MANUALLY_GRADED', 'This answer is graded automatically');
    }
    const max = toCenti(answer.maxMarks);
    const awarded = toCenti(dto.awardedMarks);
    if (awarded < 0 || awarded > max) {
      throw new AppError(
        'IMPOSSIBLE_MARKS',
        `Awarded marks must be between 0 and ${fromCenti(max)}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const before = { awardedMarks: decToNumber(answer.awardedMarks), status: answer.evaluationStatus };
    await this.prisma.$transaction(async (tx) => {
      await tx.attemptAnswer.update({
        where: { id: answerId },
        data: {
          awardedMarks: centiToDecimal(awarded),
          evaluationStatus: EvaluationStatus.MANUAL_EVALUATED,
          evaluatorId: evaluator.id,
          evaluatorComment: dto.comment,
          evaluatedAt: new Date(),
        },
      });
      await this.evaluate(tx, answer.attemptId);
      await this.audit.record(
        {
          actorId: evaluator.id,
          action: 'attempt.answer.evaluate',
          entityType: 'AttemptAnswer',
          entityId: answerId,
          before,
          after: dto,
          ctx,
        },
        tx,
      );
    });
    const result = await this.prisma.attemptResult.findUnique({ where: { attemptId: answer.attemptId } });
    if (result?.status === ResultStatus.FINAL && before.status === EvaluationStatus.MANUAL_PENDING) {
      await this.notifications.notify(answer.attempt.userId, {
        type: 'attempt.evaluated',
        title: 'আপনার ফলাফল প্রকাশিত হয়েছে',
        body: 'Written answers have been evaluated. Your final result is ready.',
        data: { attemptId: answer.attemptId },
        channels: ['IN_APP', 'PUSH'],
        dedupeKey: `evaluated:${answer.attemptId}`,
      });
    }
    return { answerId, awardedMarks: fromCenti(awarded), resultStatus: result?.status };
  }

  async adminList(q: AdminAttemptQueryDto) {
    const where: Prisma.ExamAttemptWhereInput = {
      userId: q.userId,
      status: q.status,
      templateVersion: q.templateId ? { templateId: q.templateId } : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.examAttempt.findMany({
        where,
        include: { result: true },
        orderBy: { startedAt: q.sortOrder },
        ...pageArgs(q),
      }),
      this.prisma.examAttempt.count({ where }),
    ]);
    return PageResult.of(
      items.map(({ seed: _seed, ...a }) => a),
      total,
      q,
    );
  }

  async adminGet(id: string) {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id },
      include: { result: true, answers: { orderBy: { position: 'asc' } } },
    });
    if (!attempt) throw AppError.notFound('Attempt');
    return attempt;
  }

  /** Scheduled sweep for attempts whose delayed auto-submit job was lost (e.g. Redis flush). */
  async sweepExpired(): Promise<number> {
    const grace = await this.graceMs();
    const due = await this.prisma.examAttempt.findMany({
      where: { status: AttemptStatus.IN_PROGRESS, expiresAt: { lt: new Date(Date.now() - grace) } },
      select: { id: true },
      take: 200,
    });
    let n = 0;
    for (const a of due)
      if (
        await this.finalize(a.id, true).catch(
          (e: Error) => (this.logger.error(`Auto-submit ${a.id} failed: ${e.message}`), false),
        )
      )
        n++;
    return n;
  }

  // ───────── Helpers ─────────

  private async ownedAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.examAttempt.findUnique({ where: { id: attemptId } });
    // Same error for "missing" and "not yours" so attempt ids cannot be probed.
    if (!attempt || attempt.userId !== userId) throw AppError.notFound('Attempt');
    return attempt;
  }

  private resultVisible(rules: RulesSnapshot): boolean {
    if (rules.resultVisibility !== ResultVisibility.AFTER_WINDOW || !rules.availableUntil) return true;
    return new Date() >= new Date(rules.availableUntil);
  }

  private assertResultVisible(rules: RulesSnapshot) {
    if (!this.resultVisible(rules)) {
      throw AppError.forbidden(
        'Results are published after the exam window closes',
        'RESULT_NOT_YET_PUBLISHED',
      );
    }
  }

  private async graceMs(): Promise<number> {
    return (await this.settings.get<number>(SETTINGS.ATTEMPT_SUBMIT_GRACE_SECONDS, 30)) * 1000;
  }
}
