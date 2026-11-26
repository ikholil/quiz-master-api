import { Injectable } from '@nestjs/common';
import {
  Difficulty,
  PracticeMode,
  PracticeStatus,
  Prisma,
  QuestionType,
  RevisionItemType,
} from '@prisma/client';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { dhakaDate, dhakaDayStartUtc } from '../../common/utils/date.util';
import { sample, shuffle } from '../../common/utils/random.util';
import { PrismaService } from '../../prisma/prisma.service';
import { scoreItem } from '../attempts/scoring';
import { LearningService } from '../learning/learning.service';
import { AUTO_GRADED_TYPES } from '../questions/question-content';
import { toAnswerKey, toScoringQuestion, toStudentView } from '../questions/question-views';
import { PUBLISHED_QUESTION, QuestionsService } from '../questions/questions.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { CreatePracticeDto, PracticeAnswerDto } from './practice.dto';

const RECENT_DAYS = 7;

@Injectable()
export class PracticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
    private readonly learning: LearningService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async create(userId: string, dto: CreatePracticeDto) {
    const quota = await this.remainingQuota(userId);
    if (quota !== null && quota <= 0) throw AppError.paymentRequired(FEATURES.PRACTICE_QUESTIONS);
    const count = quota === null ? dto.questionCount : Math.min(dto.questionCount, quota);

    const filters: Prisma.QuestionWhereInput[] = [PUBLISHED_QUESTION, { type: { in: AUTO_GRADED_TYPES } }];
    if (dto.difficulty) filters.push({ difficulty: dto.difficulty });
    let topicIds = dto.topicIds ?? [];

    switch (dto.mode) {
      case PracticeMode.TOPIC:
        if (!topicIds.length)
          throw AppError.badRequest('TOPICS_REQUIRED', 'topicIds are required for TOPIC practice');
        break;
      case PracticeMode.SUBJECT:
        if (!dto.subjectId)
          throw AppError.badRequest('SUBJECT_REQUIRED', 'subjectId is required for SUBJECT practice');
        filters.push({ subjectId: dto.subjectId });
        break;
      case PracticeMode.EXAM:
        if (!dto.examId) throw AppError.badRequest('EXAM_REQUIRED', 'examId is required for EXAM practice');
        filters.push({ examMappings: { some: { examId: dto.examId } } });
        break;
      case PracticeMode.WEAK_TOPICS:
        if (!dto.examId)
          throw AppError.badRequest('EXAM_REQUIRED', 'examId is required for WEAK_TOPICS practice');
        topicIds = await this.learning.weakestTopics(userId, dto.examId, 5);
        if (!topicIds.length)
          throw AppError.badRequest('NO_WEAK_TOPICS', 'No weak topics found yet — practise more first');
        break;
      case PracticeMode.WRONG_ANSWERS: {
        const items = await this.prisma.revisionSchedule.findMany({
          where: { userId, itemType: RevisionItemType.QUESTION, questionId: { not: null } },
          orderBy: { dueAt: 'asc' },
          take: 500,
          select: { questionId: true },
        });
        if (!items.length)
          throw AppError.badRequest('NO_WRONG_ANSWERS', 'You have no wrong answers to revise');
        filters.push({ id: { in: items.map((i) => i.questionId!) } });
        break;
      }
      case PracticeMode.MIXED:
        if (dto.examId) filters.push({ examMappings: { some: { examId: dto.examId } } });
        if (dto.subjectId) filters.push({ subjectId: dto.subjectId });
        break;
    }
    if (topicIds.length)
      filters.push({
        OR: [{ topicId: { in: topicIds } }, { topics: { some: { topicId: { in: topicIds } } } }],
      });

    const pool = await this.prisma.question.findMany({
      where: { AND: filters },
      select: { id: true, publishedVersionId: true },
      take: 3000,
    });
    if (!pool.length) throw AppError.badRequest('NO_QUESTIONS', 'No published questions match these filters');

    // Prefer questions not seen in the last week; top up with seen ones if the pool is small.
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
    const seen = new Set(
      (
        await this.prisma.practiceAnswer.findMany({
          where: { session: { userId, startedAt: { gte: since } } },
          select: { questionId: true },
        })
      ).map((r) => r.questionId),
    );
    const fresh = pool.filter((q) => !seen.has(q.id));
    const chosen = [
      ...sample(fresh, Math.min(count, fresh.length)),
      ...sample(
        pool.filter((q) => seen.has(q.id)),
        Math.max(0, count - fresh.length),
      ),
    ];
    const options = await this.prisma.questionOption.findMany({
      where: { versionId: { in: chosen.map((c) => c.publishedVersionId!) } },
      select: { id: true, versionId: true },
      orderBy: { sortOrder: 'asc' },
    });
    const byVersion = new Map<string, string[]>();
    for (const o of options) byVersion.set(o.versionId, [...(byVersion.get(o.versionId) ?? []), o.id]);

    const session = await this.prisma.practiceSession.create({
      data: {
        userId,
        mode: dto.mode,
        filters: {
          examId: dto.examId,
          subjectId: dto.subjectId,
          topicIds,
          difficulty: dto.difficulty,
        } as Prisma.InputJsonValue,
        instantFeedback: dto.instantFeedback ?? true,
        questionCount: chosen.length,
        answers: {
          create: shuffle(chosen).map((q, i) => ({
            questionId: q.id,
            questionVersionId: q.publishedVersionId!,
            position: i + 1,
            optionOrder: shuffle(byVersion.get(q.publishedVersionId!) ?? []),
          })),
        },
      },
    });
    return this.get(userId, session.id);
  }

  async get(userId: string, sessionId: string) {
    const session = await this.owned(userId, sessionId);
    const answers = await this.prisma.practiceAnswer.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
    });
    const versions = await this.questions.loadVersions(answers.map((a) => a.questionVersionId));
    const reveal = session.instantFeedback || session.status !== PracticeStatus.IN_PROGRESS;
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      instantFeedback: session.instantFeedback,
      questionCount: session.questionCount,
      answeredCount: session.answeredCount,
      correctCount: session.correctCount,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      questions: answers.map((a) => {
        const v = versions.get(a.questionVersionId)!;
        const answered = !!a.answeredAt;
        return {
          ...toStudentView(v, a.optionOrder),
          practiceAnswerId: a.id,
          position: a.position,
          answered,
          selectedOptionIds: a.selectedOptionIds,
          textAnswer: a.textAnswer,
          isCorrect: answered && reveal ? a.isCorrect : null,
          answerKey: answered && reveal ? toAnswerKey(v) : null,
        };
      }),
    };
  }

  /** Each practice item can be answered once; feedback (if enabled) is returned immediately. */
  async answer(userId: string, sessionId: string, practiceAnswerId: string, dto: PracticeAnswerDto) {
    const session = await this.owned(userId, sessionId);
    if (session.status !== PracticeStatus.IN_PROGRESS)
      throw AppError.conflict('PRACTICE_CLOSED', 'This practice session is finished');
    const row = await this.prisma.practiceAnswer.findFirst({ where: { id: practiceAnswerId, sessionId } });
    if (!row) throw AppError.notFound('Practice question');
    if (row.answeredAt) throw AppError.conflict('ALREADY_ANSWERED', 'This question was already answered');

    const v = (await this.questions.loadVersions([row.questionVersionId])).get(row.questionVersionId)!;
    const type = v.question.type;
    const selected = [...new Set(dto.selectedOptionIds ?? [])];
    if (selected.some((id) => !row.optionOrder.includes(id)))
      throw AppError.badRequest('INVALID_OPTION', 'Selected option does not belong to the question');
    if (type !== QuestionType.MULTIPLE_CHOICE && selected.length > 1)
      throw AppError.badRequest('INVALID_ANSWER', 'Only one option may be selected');
    if (type === QuestionType.SHORT_ANSWER ? !dto.textAnswer?.trim() : !selected.length)
      throw AppError.badRequest('EMPTY_ANSWER', 'Provide an answer');

    const s = scoreItem(
      {
        id: row.id,
        sectionId: 'practice',
        ...toScoringQuestion(v),
        maxMarksCenti: 100,
        negativeCenti: 0,
        selectedOptionIds: selected,
        textAnswer: dto.textAnswer ?? null,
        manualAwardCenti: null,
      },
      'EXACT',
    );
    const isCorrect = s.outcome === 'CORRECT';
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.practiceAnswer.updateMany({
        where: { id: row.id, answeredAt: null },
        data: {
          selectedOptionIds: selected,
          textAnswer: dto.textAnswer ?? null,
          isCorrect,
          timeSpentMs: dto.timeSpentMs,
          answeredAt: now,
        },
      });
      if (!res.count) throw AppError.conflict('ALREADY_ANSWERED', 'This question was already answered');
      return tx.practiceSession.update({
        where: { id: sessionId },
        data: { answeredCount: { increment: 1 }, correctCount: { increment: isCorrect ? 1 : 0 } },
      });
    });

    await this.learning.recordAnswers(userId, [
      {
        questionId: v.questionId,
        topicId: v.question.topicId,
        difficulty: v.question.difficulty,
        correct: isCorrect,
        responseMs: dto.timeSpentMs,
        answeredAt: now,
      },
    ]);
    if (updated.answeredCount >= updated.questionCount) await this.complete(userId, sessionId);

    return {
      practiceAnswerId: row.id,
      isCorrect: session.instantFeedback ? isCorrect : null,
      answerKey: session.instantFeedback ? toAnswerKey(v) : null,
      answeredCount: updated.answeredCount,
      remaining: updated.questionCount - updated.answeredCount,
    };
  }

  async complete(userId: string, sessionId: string) {
    const session = await this.owned(userId, sessionId);
    if (session.status === PracticeStatus.IN_PROGRESS) {
      await this.prisma.practiceSession.updateMany({
        where: { id: sessionId, status: PracticeStatus.IN_PROGRESS },
        data: { status: PracticeStatus.COMPLETED, completedAt: new Date() },
      });
    }
    const fresh = await this.owned(userId, sessionId);
    const answers = await this.prisma.practiceAnswer.findMany({
      where: { sessionId },
      select: { timeSpentMs: true, answeredAt: true },
    });
    return {
      id: fresh.id,
      status: fresh.status,
      questionCount: fresh.questionCount,
      answeredCount: fresh.answeredCount,
      correctCount: fresh.correctCount,
      accuracy: fresh.answeredCount
        ? Math.round((fresh.correctCount / fresh.answeredCount) * 10000) / 100
        : 0,
      totalTimeMs: answers.reduce((n, a) => n + (a.timeSpentMs ?? 0), 0),
    };
  }

  async history(userId: string, q: PaginationQueryDto) {
    const where = { userId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.practiceSession.findMany({ where, orderBy: { startedAt: q.sortOrder }, ...pageArgs(q) }),
      this.prisma.practiceSession.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  /** Remaining questions today under the user's practice entitlement (null = unlimited). */
  async remainingQuota(userId: string): Promise<number | null> {
    const limit = await this.entitlements.dailyLimit(userId, FEATURES.PRACTICE_QUESTIONS);
    if (limit === null) return null;
    const dayStart = dhakaDayStartUtc(dhakaDate());
    const used = await this.prisma.practiceAnswer.count({
      where: { session: { userId, startedAt: { gte: dayStart } } },
    });
    return Math.max(0, limit - used);
  }

  private async owned(userId: string, id: string) {
    const s = await this.prisma.practiceSession.findUnique({ where: { id } });
    if (!s || s.userId !== userId) throw AppError.notFound('Practice session');
    return s;
  }
}

export { Difficulty };
