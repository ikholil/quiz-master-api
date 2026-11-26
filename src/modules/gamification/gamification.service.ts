import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PublishStatus, QuestionType } from '@prisma/client';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { addDays, dhakaDate, dhakaDayStartUtc, toIsoDate } from '../../common/utils/date.util';
import { decToNumber } from '../../common/utils/marks.util';
import { PrismaService } from '../../prisma/prisma.service';
import { scoreItem } from '../attempts/scoring';
import { NotificationsService } from '../notifications/notifications.service';
import { toAnswerKey, toScoringQuestion, toStudentView } from '../questions/question-views';
import { PUBLISHED_QUESTION, QuestionsService } from '../questions/questions.service';
import { ACHIEVEMENTS, AchievementContext, XP, levelForXp, xpForLevel } from './rules';

export interface Activity {
  answered: number;
  correct: number;
}

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Awards XP idempotently (unique userId+reason+refId), updates streak/level/counters and unlocks achievements.
   * Safe to call more than once for the same event.
   */
  async award(
    userId: string,
    reason: string,
    refId: string,
    amount: number,
    activity: Activity = { answered: 0, correct: 0 },
    extra: Partial<AchievementContext> = {},
  ) {
    if (amount <= 0) return { awarded: 0 };
    try {
      await this.prisma.xpEvent.create({ data: { userId, reason, refId, amount } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { awarded: 0 };
      throw err;
    }
    const today = dhakaDate();
    const stats = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.userStats.upsert({ where: { userId }, create: { userId }, update: {} });
      const last = cur.lastActiveDate ? toIsoDate(cur.lastActiveDate) : null;
      const streak =
        last === toIsoDate(today)
          ? cur.currentStreak
          : last === toIsoDate(addDays(today, -1))
            ? cur.currentStreak + 1
            : 1;
      const xp = cur.xp + amount;
      return tx.userStats.update({
        where: { userId },
        data: {
          xp,
          level: levelForXp(xp),
          currentStreak: streak,
          longestStreak: Math.max(cur.longestStreak, streak),
          lastActiveDate: today,
          questionsAnswered: { increment: activity.answered },
          correctAnswers: { increment: activity.correct },
        },
      });
    });
    if (stats.currentStreak > 1 && stats.currentStreak % 7 === 0) {
      await this.award(
        userId,
        'streak-bonus',
        `${stats.currentStreak}:${toIsoDate(today)}`,
        XP.STREAK_WEEK_BONUS,
      );
    }
    const unlocked = await this.checkAchievements(userId, stats, extra);
    return { awarded: amount, level: stats.level, streak: stats.currentStreak, unlocked };
  }

  onPracticeAnswer(userId: string, practiceAnswerId: string, correct: boolean) {
    return this.award(
      userId,
      'practice-answer',
      practiceAnswerId,
      correct ? XP.PRACTICE_CORRECT : XP.PRACTICE_ATTEMPT,
      { answered: 1, correct: correct ? 1 : 0 },
    ).catch((e: Error) => this.logger.warn(`XP failed: ${e.message}`));
  }

  async onAttemptFinalized(attemptId: string) {
    const a = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      include: { result: true },
    });
    if (!a?.result) return;
    const answered = a.result.correctCount + a.result.wrongCount;
    const pct = decToNumber(a.result.totalMarks)
      ? decToNumber(a.result.obtainedMarks)! / decToNumber(a.result.totalMarks)!
      : 0;
    const totalQ = answered + a.result.skippedCount + a.result.pendingCount;
    await this.award(
      a.userId,
      'mock-attempt',
      attemptId,
      XP.MOCK_COMPLETED + a.result.correctCount,
      { answered, correct: a.result.correctCount },
      { mockCompleted: true, mockPercent: pct, mockQuestions: totalQ },
    ).catch((e: Error) => this.logger.warn(`XP failed: ${e.message}`));
  }

  private async checkAchievements(
    userId: string,
    stats: Prisma.UserStatsGetPayload<object>,
    extra: Partial<AchievementContext>,
  ) {
    const owned = new Set(
      (
        await this.prisma.userAchievement.findMany({ where: { userId }, select: { achievementKey: true } })
      ).map((a) => a.achievementKey),
    );
    const [mocks, dailyCorrect] = await Promise.all([
      this.prisma.attemptResult.count({ where: { userId, status: 'FINAL' } }),
      this.prisma.dailyChallengeAnswer.count({ where: { userId, isCorrect: true } }),
    ]);
    const ctx: AchievementContext = {
      stats,
      mocksCompleted: mocks,
      dailyChallengesCorrect: dailyCorrect,
      ...extra,
    };
    const unlocked: string[] = [];
    for (const a of ACHIEVEMENTS) {
      if (owned.has(a.key) || !a.check(ctx)) continue;
      try {
        await this.prisma.userAchievement.create({ data: { userId, achievementKey: a.key } });
        unlocked.push(a.key);
        await this.notifications.notify(userId, {
          type: 'achievement.unlocked',
          title: `🏅 ${a.nameBn}`,
          body: `${a.name}: ${a.description}`,
          data: { achievement: a.key },
          channels: ['IN_APP', 'PUSH'],
        });
      } catch {
        /* concurrent unlock — already owned */
      }
    }
    return unlocked;
  }

  async profile(userId: string) {
    const stats = (await this.prisma.userStats.findUnique({ where: { userId } })) ?? {
      xp: 0,
      level: 1,
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: null,
      questionsAnswered: 0,
      correctAnswers: 0,
    };
    const owned = await this.prisma.userAchievement.findMany({ where: { userId } });
    const ownedMap = new Map(owned.map((o) => [o.achievementKey, o.earnedAt]));
    const today = dhakaDate();
    const streakAlive =
      stats.lastActiveDate && toIsoDate(stats.lastActiveDate) >= toIsoDate(addDays(today, -1));
    return {
      xp: stats.xp,
      level: stats.level,
      currentLevelXp: xpForLevel(stats.level),
      nextLevelXp: xpForLevel(stats.level + 1),
      currentStreak: streakAlive ? stats.currentStreak : 0,
      longestStreak: stats.longestStreak,
      questionsAnswered: stats.questionsAnswered,
      accuracy: stats.questionsAnswered
        ? Math.round((stats.correctAnswers / stats.questionsAnswered) * 10000) / 100
        : 0,
      achievements: ACHIEVEMENTS.map((a) => ({
        key: a.key,
        name: a.name,
        nameBn: a.nameBn,
        description: a.description,
        icon: a.icon,
        earnedAt: ownedMap.get(a.key) ?? null,
      })),
    };
  }

  // ───────── Daily challenge ─────────

  /** Same question for every student each Dhaka day, chosen deterministically from the published bank. */
  async challengeFor(date = dhakaDate()) {
    const existing = await this.prisma.dailyChallenge.findUnique({ where: { date } });
    if (existing) return existing;
    const seed = toIsoDate(date);
    const [pick] = await this.prisma.$queryRaw<Array<{ id: string; publishedVersionId: string }>>`
      SELECT id, "publishedVersionId" FROM questions
       WHERE status = 'PUBLISHED' AND "deletedAt" IS NULL AND "publishedVersionId" IS NOT NULL
         AND type IN ('SINGLE_CHOICE', 'TRUE_FALSE') AND difficulty IN ('MEDIUM', 'HARD')
         AND id NOT IN (SELECT "questionId" FROM daily_challenges WHERE date > ${addDays(date, -365)})
       ORDER BY md5(id::text || ${seed}) LIMIT 1`;
    if (!pick) throw AppError.notFound('Daily challenge');
    try {
      return await this.prisma.dailyChallenge.create({
        data: { date, questionId: pick.id, questionVersionId: pick.publishedVersionId },
      });
    } catch {
      return this.prisma.dailyChallenge.findUniqueOrThrow({ where: { date } });
    }
  }

  async today(userId: string) {
    const ch = await this.challengeFor();
    const v = (await this.questions.loadVersions([ch.questionVersionId])).get(ch.questionVersionId)!;
    const mine = await this.prisma.dailyChallengeAnswer.findUnique({
      where: { userId_date: { userId, date: ch.date } },
    });
    const [total, correct] = await Promise.all([
      this.prisma.dailyChallengeAnswer.count({ where: { date: ch.date } }),
      this.prisma.dailyChallengeAnswer.count({ where: { date: ch.date, isCorrect: true } }),
    ]);
    return {
      date: toIsoDate(ch.date),
      question: toStudentView(v),
      answered: !!mine,
      isCorrect: mine?.isCorrect ?? null,
      selectedOptionIds: mine?.selectedOptionIds ?? [],
      // The key is revealed only after the student has answered.
      answerKey: mine ? toAnswerKey(v) : null,
      stats: mine
        ? { participants: total, correctPercent: total ? Math.round((correct / total) * 10000) / 100 : 0 }
        : null,
    };
  }

  async answerToday(userId: string, selectedOptionIds: string[], timeSpentMs?: number) {
    const ch = await this.challengeFor();
    const v = (await this.questions.loadVersions([ch.questionVersionId])).get(ch.questionVersionId)!;
    const ids = [...new Set(selectedOptionIds)];
    if (ids.length !== 1 || !v.options.some((o) => o.id === ids[0]))
      throw AppError.badRequest('INVALID_OPTION', 'Select exactly one option of today’s question');
    const s = scoreItem(
      {
        id: 'daily',
        sectionId: 'daily',
        ...toScoringQuestion(v),
        maxMarksCenti: 100,
        negativeCenti: 0,
        selectedOptionIds: ids,
        textAnswer: null,
        manualAwardCenti: null,
      },
      'EXACT',
    );
    const isCorrect = s.outcome === 'CORRECT';
    try {
      await this.prisma.dailyChallengeAnswer.create({
        data: { userId, date: ch.date, selectedOptionIds: ids, isCorrect, timeSpentMs },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        throw AppError.conflict('ALREADY_ANSWERED', 'You already answered today’s challenge');
      throw err;
    }
    await this.award(
      userId,
      'daily-challenge',
      toIsoDate(ch.date),
      isCorrect ? XP.DAILY_CORRECT : XP.DAILY_ATTEMPT,
      { answered: 1, correct: isCorrect ? 1 : 0 },
    );
    return this.today(userId);
  }

  // ───────── Leaderboards ─────────

  async xpLeaderboard(userId: string, period: 'week' | 'month' | 'all', limit = 50) {
    const since =
      period === 'all' ? new Date(0) : dhakaDayStartUtc(addDays(dhakaDate(), period === 'week' ? -6 : -29));
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; xp: bigint; rank: bigint }>>`
      SELECT "userId", SUM(amount) AS xp, RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
        FROM xp_events WHERE "createdAt" >= ${since}
       GROUP BY "userId" ORDER BY xp DESC, "userId" LIMIT ${limit}`;
    const [me] = await this.prisma.$queryRaw<Array<{ xp: bigint; rank: bigint }>>`
      SELECT xp, rank FROM (SELECT "userId", SUM(amount) AS xp, RANK() OVER (ORDER BY SUM(amount) DESC) AS rank FROM xp_events WHERE "createdAt" >= ${since} GROUP BY "userId") r
       WHERE r."userId" = ${userId}::uuid`;
    return {
      period,
      entries: await this.withNames(
        rows.map((r) => ({ userId: r.userId, value: Number(r.xp), rank: Number(r.rank) })),
      ),
      me: me ? { value: Number(me.xp), rank: Number(me.rank) } : null,
    };
  }

  /** Best final score per student on the template's current version; ties broken by time taken. */
  async mockLeaderboard(userId: string, templateId: string, limit = 50) {
    const t = await this.prisma.mockExamTemplate.findFirst({
      where: { id: templateId, status: PublishStatus.PUBLISHED },
      select: { currentVersionId: true, title: true },
    });
    if (!t?.currentVersionId) throw AppError.notFound('Mock exam');
    const ranked = await this.prisma.$queryRaw<
      Array<{ userId: string; score: number; time: number; rank: bigint }>
    >`
      WITH best AS (
        SELECT DISTINCT ON ("userId") "userId", "obtainedMarks"::float AS score, "timeTakenSeconds" AS time
          FROM attempt_results WHERE "templateVersionId" = ${t.currentVersionId}::uuid AND status = 'FINAL'
         ORDER BY "userId", "obtainedMarks" DESC, "timeTakenSeconds" ASC)
      SELECT "userId", score, time, RANK() OVER (ORDER BY score DESC, time ASC) AS rank FROM best ORDER BY rank LIMIT 100000`;
    const top = ranked.slice(0, limit);
    const me = ranked.find((r) => r.userId === userId);
    return {
      templateId,
      title: t.title,
      participants: ranked.length,
      entries: await this.withNames(
        top.map((r) => ({
          userId: r.userId,
          value: Number(r.score),
          rank: Number(r.rank),
          timeTakenSeconds: r.time,
        })),
      ),
      me: me ? { value: Number(me.score), rank: Number(me.rank), timeTakenSeconds: me.time } : null,
    };
  }

  async dailyLeaderboard(limit = 50) {
    const ch = await this.challengeFor();
    const rows = await this.prisma.dailyChallengeAnswer.findMany({
      where: { date: ch.date, isCorrect: true },
      orderBy: [{ timeSpentMs: { sort: 'asc', nulls: 'last' } }, { answeredAt: 'asc' }],
      take: limit,
    });
    return {
      date: toIsoDate(ch.date),
      entries: await this.withNames(
        rows.map((r, i) => ({ userId: r.userId, value: r.timeSpentMs ?? 0, rank: i + 1 })),
      ),
    };
  }

  /** Public display: chosen display name or first name only — never phone/email. */
  private async withNames<T extends { userId: string }>(rows: T[]) {
    const profiles = await this.prisma.profile.findMany({
      where: { userId: { in: rows.map((r) => r.userId) } },
      select: { userId: true, displayName: true, fullName: true, avatarFileId: true },
    });
    const byId = new Map(profiles.map((p) => [p.userId, p]));
    return rows.map(({ userId, ...rest }) => {
      const p = byId.get(userId);
      return {
        ...rest,
        userId,
        displayName: p?.displayName ?? p?.fullName?.split(' ')[0] ?? 'Student',
        avatarFileId: p?.avatarFileId ?? null,
      };
    });
  }

  // ───────── Bookmarks ─────────

  async bookmark(userId: string, questionId: string, note?: string, folder = 'default') {
    const q = await this.prisma.question.findFirst({ where: { id: questionId, ...PUBLISHED_QUESTION } });
    if (!q) throw AppError.notFound('Question');
    return this.prisma.questionBookmark.upsert({
      where: { userId_questionId: { userId, questionId } },
      create: { userId, questionId, note, folder },
      update: { note, folder },
    });
  }

  async unbookmark(userId: string, questionId: string) {
    await this.prisma.questionBookmark.deleteMany({ where: { userId, questionId } });
    return { ok: true };
  }

  async bookmarks(userId: string, q: { page: number; pageSize: number; folder?: string }) {
    const where: Prisma.QuestionBookmarkWhereInput = {
      userId,
      folder: q.folder,
      question: PUBLISHED_QUESTION,
    };
    const [rows, total, folders] = await this.prisma.$transaction([
      this.prisma.questionBookmark.findMany({
        where,
        include: { question: { select: { publishedVersionId: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.questionBookmark.count({ where }),
      this.prisma.questionBookmark.groupBy({
        by: ['folder'],
        where: { userId },
        _count: { _all: true },
        orderBy: { folder: 'asc' },
      }),
    ]);
    const versions = await this.questions.loadVersions(rows.map((r) => r.question.publishedVersionId!));
    const page = PageResult.of(
      rows.map((r) => ({
        note: r.note,
        folder: r.folder,
        bookmarkedAt: r.createdAt,
        question: toStudentView(versions.get(r.question.publishedVersionId!)!),
      })),
      total,
      q,
    );
    return Object.assign(page, {
      folders: folders.map((f) => ({ folder: f.folder, count: (f._count as { _all: number })._all })),
    });
  }

  static readonly ALLOWED_TYPES = [QuestionType.SINGLE_CHOICE, QuestionType.TRUE_FALSE];
}
