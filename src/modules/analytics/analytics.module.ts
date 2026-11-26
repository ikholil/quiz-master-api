import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Controller, Get, Injectable, Logger, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AttemptStatus, PaymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Job } from 'bullmq';
import { AdminOnly, Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { addDays, dhakaDate, dhakaDayStartUtc, parseIsoDate, toIsoDate } from '../../common/utils/date.util';
import { decToNumber } from '../../common/utils/marks.util';
import type { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import {
  QuestionAnalyticsModule,
  QuestionAnalyticsService,
} from '../question-analytics/question-analytics.module';

class StudentAnalyticsQuery {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(365) days?: number;
}
class AdminAnalyticsQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

export const METRICS = [
  'users.new',
  'users.active',
  'attempts.submitted',
  'practice.answers',
  'payments.revenue_minor',
  'payments.count',
  'ai.messages',
  'ai.cost_micros',
] as const;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Student dashboard: scores over time, subject accuracy, practice volume, study streak. */
  async student(userId: string, q: StudentAnalyticsQuery) {
    const since = new Date(Date.now() - (q.days ?? 90) * 86_400_000);
    const results = await this.prisma.attemptResult.findMany({
      where: {
        userId,
        evaluatedAt: { gte: since },
        attempt: { templateVersion: q.examId ? { template: { examId: q.examId } } : undefined },
      },
      orderBy: { evaluatedAt: 'asc' },
      select: {
        attemptId: true,
        obtainedMarks: true,
        totalMarks: true,
        accuracy: true,
        evaluatedAt: true,
        status: true,
      },
    });
    const subjectRows = await this.prisma.$queryRaw<
      Array<{ subjectId: string; name: string; answered: bigint; correct: bigint }>
    >`
      SELECT s.id AS "subjectId", s.name, COUNT(*) AS answered, COUNT(*) FILTER (WHERE x.correct) AS correct FROM (
        SELECT pa."questionId", pa."isCorrect" AS correct FROM practice_answers pa JOIN practice_sessions ps ON ps.id = pa."sessionId"
         WHERE ps."userId" = ${userId}::uuid AND pa."answeredAt" >= ${since} AND pa."isCorrect" IS NOT NULL
        UNION ALL
        SELECT aa."questionId", aa."isCorrect" FROM attempt_answers aa JOIN exam_attempts ea ON ea.id = aa."attemptId"
         WHERE ea."userId" = ${userId}::uuid AND ea."submittedAt" >= ${since} AND aa."isCorrect" IS NOT NULL
      ) x JOIN questions q ON q.id = x."questionId" JOIN subjects s ON s.id = q."subjectId"
      GROUP BY s.id, s.name ORDER BY s.name`;
    const practiceByDay = await this.prisma.$queryRaw<
      Array<{ day: Date; answered: bigint; correct: bigint }>
    >`
      SELECT date_trunc('day', pa."answeredAt" + interval '6 hours')::date AS day, COUNT(*) AS answered, COUNT(*) FILTER (WHERE pa."isCorrect") AS correct
        FROM practice_answers pa JOIN practice_sessions ps ON ps.id = pa."sessionId"
       WHERE ps."userId" = ${userId}::uuid AND pa."answeredAt" >= ${since}
       GROUP BY 1 ORDER BY 1`;
    const activeDays = new Set(practiceByDay.map((d) => toIsoDate(d.day)));
    results.forEach((r) => activeDays.add(toIsoDate(dhakaDate(r.evaluatedAt))));
    let streak = 0;
    let cursor = dhakaDate();
    if (!activeDays.has(toIsoDate(cursor))) cursor = addDays(cursor, -1);
    while (activeDays.has(toIsoDate(cursor))) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    const finals = results.filter((r) => r.status === 'FINAL');
    return {
      attempts: {
        count: results.length,
        averagePercent: finals.length
          ? Math.round(
              (finals.reduce(
                (s, r) => s + (decToNumber(r.obtainedMarks)! / decToNumber(r.totalMarks)!) * 100,
                0,
              ) /
                finals.length) *
                100,
            ) / 100
          : null,
        trend: results.map((r) => ({
          attemptId: r.attemptId,
          date: r.evaluatedAt,
          obtained: decToNumber(r.obtainedMarks),
          total: decToNumber(r.totalMarks),
          accuracy: decToNumber(r.accuracy),
        })),
      },
      subjects: subjectRows.map((s) => ({
        subjectId: s.subjectId,
        name: s.name,
        answered: Number(s.answered),
        accuracy: Number(s.answered) ? Math.round((Number(s.correct) / Number(s.answered)) * 10000) / 100 : 0,
      })),
      practice: practiceByDay.map((d) => ({
        date: toIsoDate(d.day),
        answered: Number(d.answered),
        correct: Number(d.correct),
      })),
      streakDays: streak,
      activeDays: activeDays.size,
    };
  }

  /** Admin dashboard from pre-aggregated daily metrics plus a few live counters. */
  async admin(q: AdminAnalyticsQuery) {
    const to = q.to ? parseIsoDate(q.to) : dhakaDate();
    const from = q.from ? parseIsoDate(q.from) : addDays(to, -29);
    const rows = await this.prisma.analyticsDailyMetric.findMany({
      where: { date: { gte: from, lte: to }, dimension: 'all' },
      orderBy: { date: 'asc' },
    });
    const series: Record<string, Array<{ date: string; value: number }>> = {};
    for (const r of rows) (series[r.metric] ??= []).push({ date: toIsoDate(r.date), value: r.value });
    const [totalUsers, activeSubs, pendingEvaluations, openReports, openTickets, pendingReview] =
      await Promise.all([
        this.prisma.user.count({ where: { deletedAt: null } }),
        this.prisma.userSubscription.count({ where: { status: 'ACTIVE' } }),
        this.prisma.attemptAnswer.count({ where: { evaluationStatus: 'MANUAL_PENDING' } }),
        this.prisma.contentReport.count({ where: { status: 'OPEN' } }),
        this.prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'AWAITING_SUPPORT'] } } }),
        this.prisma.question.count({ where: { latestVersion: { status: 'IN_REVIEW' }, deletedAt: null } }),
      ]);
    return {
      from: toIsoDate(from),
      to: toIsoDate(to),
      totals: {
        totalUsers,
        activeSubscriptions: activeSubs,
        pendingEvaluations,
        openReports,
        openTickets,
        questionsAwaitingReview: pendingReview,
      },
      series,
    };
  }

  /** Scheduled: aggregates one Dhaka calendar day (default: yesterday). Idempotent upserts. */
  async aggregateDay(day = addDays(dhakaDate(), -1)): Promise<Record<string, number>> {
    const start = dhakaDayStartUtc(day);
    const end = dhakaDayStartUtc(addDays(day, 1));
    const range = { gte: start, lt: end };
    const [newUsers, active, attempts, practice, revenue, ai, aiCost] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: range } }),
      this.prisma.session.groupBy({ by: ['userId'], where: { lastSeenAt: range } }).then((r) => r.length),
      this.prisma.examAttempt.count({
        where: { submittedAt: range, status: { not: AttemptStatus.IN_PROGRESS } },
      }),
      this.prisma.practiceAnswer.count({ where: { answeredAt: range } }),
      this.prisma.payment.aggregate({
        where: { paidAt: range, status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.aiMessage.count({ where: { createdAt: range, role: 'USER' } }),
      this.prisma.aiUsageRecord.aggregate({
        where: { createdAt: range },
        _sum: { estimatedCostMicros: true },
      }),
    ]);
    const values: Record<(typeof METRICS)[number], number> = {
      'users.new': newUsers,
      'users.active': active,
      'attempts.submitted': attempts,
      'practice.answers': practice,
      'payments.revenue_minor': revenue._sum.amountMinor ?? 0,
      'payments.count': revenue._count._all,
      'ai.messages': ai,
      'ai.cost_micros': aiCost._sum.estimatedCostMicros ?? 0,
    };
    for (const [metric, value] of Object.entries(values)) {
      await this.prisma.analyticsDailyMetric.upsert({
        where: { date_metric_dimension: { date: day, metric, dimension: 'all' } },
        create: { date: day, metric, value },
        update: { value },
      });
    }
    this.logger.log(`Aggregated analytics for ${toIsoDate(day)}`);
    return values;
  }
}

@ApiTags('Analytics')
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Authenticated()
  @Get('analytics/me')
  me(@CurrentUser() u: AuthUser, @Query() q: StudentAnalyticsQuery) {
    return this.analytics.student(u.id, q);
  }

  @Get('admin/analytics/overview')
  @AdminOnly(PERMISSIONS.ANALYTICS_READ)
  admin(@Query() q: AdminAnalyticsQuery) {
    return this.analytics.admin(q);
  }
}

@Processor(QUEUES.ANALYTICS, { concurrency: 1 })
export class AnalyticsProcessor extends WorkerHost {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly items: QuestionAnalyticsService,
  ) {
    super();
  }
  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.ITEM_ANALYSIS) return this.items.run();
    if (job.name === JOBS.AGGREGATE_DAILY)
      return this.analytics.aggregateDay(job.data?.date ? parseIsoDate(job.data.date as string) : undefined);
    return undefined;
  }
}

@Module({
  imports: [QuestionAnalyticsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ...workers(AnalyticsProcessor)],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
