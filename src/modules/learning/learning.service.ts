import { Injectable, Logger } from '@nestjs/common';
import { AccessLevel, Difficulty, PublishStatus, RevisionItemType } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { SyllabusService } from '../syllabus/syllabus.service';
import {
  AnswerEvent,
  DAY_MS,
  MasteryState,
  TopicPriorityInput,
  applyAnswers,
  emptyMastery,
  rankTopics,
  sm2,
} from './engine';

export interface LearningAnswer {
  questionId: string;
  topicId: string | null;
  difficulty: Difficulty;
  correct: boolean;
  responseMs?: number | null;
  answeredAt: Date;
}

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syllabus: SyllabusService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Folds graded answers into topic mastery, question statistics and the spaced-repetition schedule.
   * Only objectively graded answers are passed in (skipped / pending-manual answers carry no signal).
   */
  async recordAnswers(userId: string, answers: LearningAnswer[]): Promise<void> {
    if (!answers.length) return;
    const sorted = [...answers].sort((a, b) => a.answeredAt.getTime() - b.answeredAt.getTime());
    const byTopic = new Map<string, LearningAnswer[]>();
    for (const a of sorted) if (a.topicId) byTopic.set(a.topicId, [...(byTopic.get(a.topicId) ?? []), a]);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const [topicId, list] of byTopic) {
        const existing = await tx.topicMastery.findUnique({ where: { userId_topicId: { userId, topicId } } });
        const prev: MasteryState = existing
          ? {
              totalAnswered: existing.totalAnswered,
              totalCorrect: existing.totalCorrect,
              recentAccuracy: existing.recentAccuracy,
              avgResponseMs: existing.avgResponseMs,
              masteryScore: existing.masteryScore,
            }
          : emptyMastery();
        const next = applyAnswers(
          prev,
          list.map<AnswerEvent>((a) => ({
            correct: a.correct,
            difficulty: a.difficulty,
            responseMs: a.responseMs,
          })),
        );
        const lastAt = list[list.length - 1].answeredAt;
        await tx.topicMastery.upsert({
          where: { userId_topicId: { userId, topicId } },
          create: { userId, topicId, ...next, lastPracticedAt: lastAt },
          update: { ...next, lastPracticedAt: lastAt },
        });

        // Topic-level revision: quality derived from this batch's accuracy.
        const accuracy = list.filter((a) => a.correct).length / list.length;
        const itemKey = `TOPIC:${topicId}`;
        const sched = await tx.revisionSchedule.findUnique({
          where: { userId_itemKey: { userId, itemKey } },
        });
        const state = sm2(
          sched ?? { easeFactor: 2.5, intervalDays: 0, repetitions: 0, lapses: 0 },
          Math.round(accuracy * 5),
          now,
        );
        await tx.revisionSchedule.upsert({
          where: { userId_itemKey: { userId, itemKey } },
          create: {
            userId,
            itemType: RevisionItemType.TOPIC,
            itemKey,
            topicId,
            ...state,
            lastReviewedAt: now,
            lastQuality: Math.round(accuracy * 5),
          },
          update: { ...state, lastReviewedAt: now, lastQuality: Math.round(accuracy * 5) },
        });
      }

      for (const a of sorted) {
        await tx.question.update({
          where: { id: a.questionId },
          data: { timesAnswered: { increment: 1 }, timesCorrect: { increment: a.correct ? 1 : 0 } },
        });
        // Wrong answers enter the question revision queue (due tomorrow); correct re-answers advance it.
        const itemKey = `QUESTION:${a.questionId}`;
        const sched = await tx.revisionSchedule.findUnique({
          where: { userId_itemKey: { userId, itemKey } },
        });
        if (!a.correct || sched) {
          const state = sm2(
            sched ?? { easeFactor: 2.5, intervalDays: 0, repetitions: 0, lapses: 0 },
            a.correct ? 4 : 1,
            now,
          );
          await tx.revisionSchedule.upsert({
            where: { userId_itemKey: { userId, itemKey } },
            create: {
              userId,
              itemType: RevisionItemType.QUESTION,
              itemKey,
              questionId: a.questionId,
              topicId: a.topicId,
              ...state,
              lastReviewedAt: now,
              lastQuality: a.correct ? 4 : 1,
            },
            update: { ...state, lastReviewedAt: now, lastQuality: a.correct ? 4 : 1 },
          });
        }
      }
    });
  }

  /** Background job: derive learning signals from a scored exam attempt. */
  async processAttempt(attemptId: string): Promise<number> {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      include: {
        answers: {
          include: {
            questionVersion: {
              select: { question: { select: { topicId: true, difficulty: true, type: true } } },
            },
          },
        },
      },
    });
    if (!attempt) return 0;
    const graded = attempt.answers.filter((a) => a.isCorrect !== null);
    await this.recordAnswers(
      attempt.userId,
      graded.map((a) => ({
        questionId: a.questionId,
        topicId: a.questionVersion.question.topicId,
        difficulty: a.questionVersion.question.difficulty,
        correct: !!a.isCorrect,
        responseMs: a.timeSpentMs || null,
        answeredAt: a.answeredAt ?? attempt.submittedAt ?? new Date(),
      })),
    );
    return graded.length;
  }

  // ───────── Recommendations ─────────

  async priorities(userId: string, examId: string, now = new Date()) {
    const weights = await this.syllabus.currentTopicWeights(examId);
    if (!weights.size) throw AppError.notFound('Syllabus', { examId });
    const topicIds = [...weights.keys()];
    const [topics, mastery, due, prereqs] = await Promise.all([
      this.prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }),
      this.prisma.topicMastery.findMany({ where: { userId, topicId: { in: topicIds } } }),
      this.prisma.revisionSchedule.findMany({
        where: { userId, itemType: RevisionItemType.TOPIC, topicId: { in: topicIds }, dueAt: { lte: now } },
        select: { topicId: true },
      }),
      this.prisma.topicRelationship.findMany({
        where: { toTopicId: { in: topicIds }, type: 'PREREQUISITE' },
      }),
    ]);
    const mById = new Map(mastery.map((m) => [m.topicId, m]));
    const dueSet = new Set(due.map((d) => d.topicId));
    const inputs: TopicPriorityInput[] = topics.map((t) => {
      const m = mById.get(t.id);
      const weakPrereqs = prereqs.filter(
        (p) => p.toTopicId === t.id && (mById.get(p.fromTopicId)?.masteryScore ?? 0) < 0.4,
      ).length;
      return {
        topicId: t.id,
        topicName: t.name,
        examWeight: weights.get(t.id) ?? 0.5,
        mastery: m
          ? {
              totalAnswered: m.totalAnswered,
              totalCorrect: m.totalCorrect,
              recentAccuracy: m.recentAccuracy,
              avgResponseMs: m.avgResponseMs,
              masteryScore: m.masteryScore,
            }
          : null,
        lastPracticedAt: m?.lastPracticedAt ?? null,
        revisionDue: dueSet.has(t.id),
        weakPrerequisites: weakPrereqs,
      };
    });
    return rankTopics(inputs, now);
  }

  async recommendations(userId: string, examId: string) {
    const ranked = await this.priorities(userId, examId);
    const mastery = await this.prisma.topicMastery.findMany({
      where: {
        userId,
        topicId: { in: ranked.map((r) => r.topicId) },
        totalAnswered: { gte: 3 },
        masteryScore: { lt: 0.5 },
      },
      include: { topic: { select: { name: true } } },
      orderBy: { masteryScore: 'asc' },
      take: 10,
    });
    const mock = await this.recommendMock(userId, examId);
    const coverage =
      ranked.filter((r) => !r.factors.find((f) => f.key === 'not_started' && f.value > 0)).length /
      Math.max(1, ranked.length);
    return {
      examId,
      syllabusCoverage: Math.round(coverage * 10000) / 100,
      nextTopics: ranked.slice(0, 10),
      weakTopics: mastery.map((m) => ({
        topicId: m.topicId,
        topicName: m.topic.name,
        masteryScore: m.masteryScore,
        totalAnswered: m.totalAnswered,
        recentAccuracy: m.recentAccuracy,
      })),
      mockExam: mock,
    };
  }

  /** Recommends a published mock for the exam the user has not attempted recently and can access. */
  async recommendMock(userId: string, examId: string) {
    const premium = await this.entitlements.has(userId, FEATURES.MOCK_PREMIUM);
    const templates = await this.prisma.mockExamTemplate.findMany({
      where: {
        examId,
        status: PublishStatus.PUBLISHED,
        currentVersionId: { not: null },
        accessLevel: premium ? undefined : AccessLevel.FREE,
      },
      include: {
        currentVersion: {
          select: { id: true, durationMinutes: true, availableUntil: true, availableFrom: true },
        },
      },
    });
    const now = new Date();
    const open = templates.filter(
      (t) =>
        (!t.currentVersion!.availableUntil || t.currentVersion!.availableUntil > now) &&
        (!t.currentVersion!.availableFrom || t.currentVersion!.availableFrom <= now),
    );
    if (!open.length) return null;
    const attempts = await this.prisma.examAttempt.groupBy({
      by: ['templateVersionId'],
      where: { userId, templateVersionId: { in: open.map((t) => t.currentVersion!.id) } },
      _max: { startedAt: true },
    });
    const last = new Map(attempts.map((a) => [a.templateVersionId, a._max.startedAt?.getTime() ?? 0]));
    const best = [...open].sort(
      (a, b) =>
        (last.get(a.currentVersion!.id) ?? 0) - (last.get(b.currentVersion!.id) ?? 0) ||
        a.slug.localeCompare(b.slug),
    )[0];
    const lastAt = last.get(best.currentVersion!.id);
    return {
      id: best.id,
      title: best.title,
      durationMinutes: best.currentVersion!.durationMinutes,
      reason: lastAt
        ? `Last attempted ${Math.floor((now.getTime() - lastAt) / DAY_MS)} day(s) ago`
        : 'Not attempted yet',
    };
  }

  async masteryOverview(userId: string, examId?: string) {
    const weights = examId ? await this.syllabus.currentTopicWeights(examId) : null;
    const rows = await this.prisma.topicMastery.findMany({
      where: { userId, topicId: weights ? { in: [...weights.keys()] } : undefined },
      include: {
        topic: {
          select: {
            name: true,
            nameBn: true,
            chapter: { select: { subject: { select: { id: true, name: true } } } },
          },
        },
      },
      orderBy: { masteryScore: 'asc' },
    });
    const bySubject = new Map<
      string,
      { subjectId: string; subjectName: string; topics: number; avgMastery: number }
    >();
    for (const r of rows) {
      const s = r.topic.chapter.subject;
      const cur = bySubject.get(s.id) ?? { subjectId: s.id, subjectName: s.name, topics: 0, avgMastery: 0 };
      cur.avgMastery = (cur.avgMastery * cur.topics + r.masteryScore) / (cur.topics + 1);
      cur.topics += 1;
      bySubject.set(s.id, cur);
    }
    return {
      topics: rows.map((r) => ({
        topicId: r.topicId,
        topicName: r.topic.name,
        topicNameBn: r.topic.nameBn,
        subjectId: r.topic.chapter.subject.id,
        masteryScore: r.masteryScore,
        recentAccuracy: r.recentAccuracy,
        totalAnswered: r.totalAnswered,
        totalCorrect: r.totalCorrect,
        avgResponseMs: r.avgResponseMs,
        lastPracticedAt: r.lastPracticedAt,
      })),
      subjects: [...bySubject.values()].map((s) => ({
        ...s,
        avgMastery: Math.round(s.avgMastery * 10000) / 10000,
      })),
      mappedTopicCount: weights?.size ?? null,
    };
  }

  /** Topic ids with the lowest mastery (or untouched) for weak-topic practice sets. */
  async weakestTopics(userId: string, examId: string, limit = 5): Promise<string[]> {
    const ranked = await this.priorities(userId, examId);
    return ranked
      .filter((r) =>
        r.factors.some(
          (f) => (f.key === 'weakness' && f.value >= 0.5) || (f.key === 'not_started' && f.value > 0),
        ),
      )
      .slice(0, limit)
      .map((r) => r.topicId);
  }
}
