import { Injectable, Logger } from '@nestjs/common';
import {
  ContentStatus,
  Prisma,
  RevisionItemType,
  StudyPlanStatus,
  StudyTaskStatus,
  StudyTaskType,
} from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { addDays, daysBetween, dhakaDate, parseIsoDate, toIsoDate } from '../../common/utils/date.util';
import { PrismaService } from '../../prisma/prisma.service';
import { CarryOverTask, generateDailyPlan } from '../learning/engine';
import { LearningService } from '../learning/learning.service';
import {
  CreateStudyPlanDto,
  RescheduleTaskDto,
  TaskRangeQueryDto,
  UpdateStudyPlanDto,
} from './study-plans.dto';

const RECOVERY_WINDOW_DAYS = 3;

@Injectable()
export class StudyPlansService {
  private readonly logger = new Logger(StudyPlansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly learning: LearningService,
  ) {}

  async create(userId: string, dto: CreateStudyPlanDto) {
    const exam = await this.prisma.exam.findFirst({ where: { id: dto.examId, status: 'PUBLISHED' } });
    if (!exam) throw AppError.notFound('Exam');
    const existing = await this.prisma.studyPlan.findFirst({
      where: { userId, examId: dto.examId, status: { in: [StudyPlanStatus.ACTIVE, StudyPlanStatus.PAUSED] } },
    });
    if (existing)
      throw AppError.conflict('PLAN_EXISTS', 'You already have a plan for this exam', {
        planId: existing.id,
      });
    const today = dhakaDate();
    const target = dto.targetDate ? parseIsoDate(dto.targetDate) : null;
    if (target && target <= today)
      throw AppError.badRequest('INVALID_TARGET_DATE', 'Target date must be in the future');
    const plan = await this.prisma.studyPlan.create({
      data: {
        userId,
        examId: dto.examId,
        title: dto.title ?? `${exam.name} preparation`,
        startDate: today,
        targetDate: target,
        dailyMinutes: dto.dailyMinutes ?? 60,
        studyDays: dto.studyDays ?? [0, 1, 2, 3, 4, 5, 6],
      },
    });
    await this.ensureDay(plan.id, today);
    return this.get(userId, plan.id);
  }

  list(userId: string) {
    return this.prisma.studyPlan.findMany({
      where: { userId, status: { not: StudyPlanStatus.ARCHIVED } },
      orderBy: { createdAt: 'desc' },
      include: { exam: { select: { name: true, slug: true } } },
    });
  }

  async get(userId: string, planId: string) {
    const plan = await this.owned(userId, planId);
    return { ...plan, progress: await this.progress(userId, planId) };
  }

  async update(userId: string, planId: string, dto: UpdateStudyPlanDto) {
    const plan = await this.owned(userId, planId);
    const data: Prisma.StudyPlanUpdateInput = {
      title: dto.title,
      dailyMinutes: dto.dailyMinutes,
      studyDays: dto.studyDays,
      status: dto.status,
      targetDate: dto.targetDate ? parseIsoDate(dto.targetDate) : undefined,
    };
    const updated = await this.prisma.studyPlan.update({ where: { id: plan.id }, data });
    // Regenerate today's untouched tasks when the daily budget changes.
    if (dto.dailyMinutes && dto.dailyMinutes !== plan.dailyMinutes)
      await this.regenerateDay(plan.id, dhakaDate());
    return updated;
  }

  /** Today's tasks; generated on first access if the nightly job has not run yet. */
  async today(userId: string, planId: string) {
    const plan = await this.owned(userId, planId);
    const today = dhakaDate();
    if (plan.status === StudyPlanStatus.ACTIVE) await this.ensureDay(plan.id, today);
    return this.prisma.studyPlanTask.findMany({
      where: { planId, scheduledDate: today },
      orderBy: [{ status: 'asc' }, { priorityScore: 'desc' }],
      include: { topic: { select: { name: true, nameBn: true } } },
    });
  }

  async tasks(userId: string, planId: string, q: TaskRangeQueryDto) {
    await this.owned(userId, planId);
    const from = q.from ? parseIsoDate(q.from) : addDays(dhakaDate(), -7);
    const to = q.to ? parseIsoDate(q.to) : addDays(dhakaDate(), 7);
    if (daysBetween(from, to) > 92) throw AppError.badRequest('RANGE_TOO_LARGE', 'Query at most 92 days');
    return this.prisma.studyPlanTask.findMany({
      where: { planId, scheduledDate: { gte: from, lte: to } },
      orderBy: [{ scheduledDate: 'asc' }, { priorityScore: 'desc' }],
    });
  }

  async setTaskStatus(userId: string, taskId: string, status: 'COMPLETED' | 'SKIPPED') {
    const task = await this.ownedTask(userId, taskId);
    if (task.status !== StudyTaskStatus.PENDING && task.status !== StudyTaskStatus.MISSED)
      throw AppError.conflict('TASK_CLOSED', `Task is already ${task.status}`);
    return this.prisma.studyPlanTask.update({
      where: { id: taskId },
      data: { status, completedAt: status === 'COMPLETED' ? new Date() : null },
    });
  }

  async reschedule(userId: string, taskId: string, dto: RescheduleTaskDto) {
    const task = await this.ownedTask(userId, taskId);
    if (task.status === StudyTaskStatus.COMPLETED)
      throw AppError.conflict('TASK_CLOSED', 'Completed tasks cannot be moved');
    const date = parseIsoDate(dto.date);
    if (date < dhakaDate()) throw AppError.badRequest('INVALID_DATE', 'Cannot reschedule into the past');
    return this.prisma.$transaction(async (tx) => {
      await tx.studyPlanTask.update({ where: { id: taskId }, data: { status: StudyTaskStatus.RESCHEDULED } });
      const { id: _id, createdAt: _c, updatedAt: _u, completedAt: _d, reason, ...rest } = task;
      return tx.studyPlanTask.create({
        data: {
          ...rest,
          reason: reason as Prisma.InputJsonValue,
          scheduledDate: date,
          status: StudyTaskStatus.PENDING,
          rescheduledFromId: taskId,
        },
      });
    });
  }

  async progress(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } });
    const [counts, mapped, mastery] = await Promise.all([
      this.prisma.studyPlanTask.groupBy({ by: ['status'], where: { planId }, _count: { _all: true } }),
      this.prisma.examTopicMapping.findMany({
        where: { examId: plan.examId, syllabusVersion: { isCurrent: true } },
        select: { topicId: true },
      }),
      this.prisma.topicMastery.findMany({ where: { userId } }),
    ]);
    const by = Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<
      Record<StudyTaskStatus, number>
    >;
    const done = by.COMPLETED ?? 0;
    const closed = done + (by.SKIPPED ?? 0) + (by.MISSED ?? 0);
    const mappedIds = new Set(mapped.map((m) => m.topicId));
    const relevant = mastery.filter((m) => mappedIds.has(m.topicId));

    // Streak: consecutive days (ending today/yesterday) with at least one completed task.
    const days = await this.prisma.studyPlanTask.findMany({
      where: { planId, status: StudyTaskStatus.COMPLETED },
      select: { scheduledDate: true },
      distinct: ['scheduledDate'],
      orderBy: { scheduledDate: 'desc' },
      take: 400,
    });
    let streak = 0;
    let cursor = dhakaDate();
    const set = new Set(days.map((d) => toIsoDate(d.scheduledDate)));
    if (!set.has(toIsoDate(cursor))) cursor = addDays(cursor, -1);
    while (set.has(toIsoDate(cursor))) {
      streak++;
      cursor = addDays(cursor, -1);
    }
    return {
      tasks: by,
      completionRate: closed ? Math.round((done / closed) * 10000) / 100 : 0,
      streakDays: streak,
      syllabusCoverage: mappedIds.size ? Math.round((relevant.length / mappedIds.size) * 10000) / 100 : 0,
      averageMastery: relevant.length
        ? Math.round((relevant.reduce((s, m) => s + m.masteryScore, 0) / relevant.length) * 10000) / 10000
        : 0,
      daysToTarget: plan.targetDate ? Math.max(0, daysBetween(dhakaDate(), plan.targetDate)) : null,
    };
  }

  // ───────── Generation ─────────

  /** Creates the day's tasks once (idempotent per plan/day). */
  async ensureDay(planId: string, date: Date): Promise<number> {
    const plan = await this.prisma.studyPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.status !== StudyPlanStatus.ACTIVE) return 0;
    if (!plan.studyDays.includes(date.getUTCDay())) return 0;
    if (plan.lastGeneratedFor && plan.lastGeneratedFor.getTime() >= date.getTime()) return 0;
    const existing = await this.prisma.studyPlanTask.count({ where: { planId, scheduledDate: date } });
    if (existing) {
      await this.prisma.studyPlan.update({ where: { id: planId }, data: { lastGeneratedFor: date } });
      return 0;
    }
    return this.generate(plan.id, plan.userId, plan.examId, plan.dailyMinutes, date);
  }

  private async regenerateDay(planId: string, date: Date) {
    const plan = await this.prisma.studyPlan.findUniqueOrThrow({ where: { id: planId } });
    const touched = await this.prisma.studyPlanTask.count({
      where: { planId, scheduledDate: date, status: { not: StudyTaskStatus.PENDING } },
    });
    if (touched) return;
    await this.prisma.studyPlanTask.deleteMany({
      where: { planId, scheduledDate: date, status: StudyTaskStatus.PENDING, rescheduledFromId: null },
    });
    await this.prisma.studyPlan.update({ where: { id: planId }, data: { lastGeneratedFor: null } });
    await this.generate(planId, plan.userId, plan.examId, plan.dailyMinutes, date);
  }

  private async generate(
    planId: string,
    userId: string,
    examId: string,
    dailyMinutes: number,
    date: Date,
  ): Promise<number> {
    const now = new Date();
    // Missed-task recovery: pending tasks from earlier days become MISSED and are offered again.
    await this.prisma.studyPlanTask.updateMany({
      where: { planId, scheduledDate: { lt: date }, status: StudyTaskStatus.PENDING },
      data: { status: StudyTaskStatus.MISSED },
    });
    const missed = await this.prisma.studyPlanTask.findMany({
      where: {
        planId,
        status: StudyTaskStatus.MISSED,
        scheduledDate: { gte: addDays(date, -RECOVERY_WINDOW_DAYS), lt: date },
        type: { not: StudyTaskType.MOCK_EXAM },
      },
      orderBy: { scheduledDate: 'asc' },
    });

    const priorities = await this.learning.priorities(userId, examId, now).catch(() => []);
    const [dueRevision, dueFlash, lastAttempt, mock] = await Promise.all([
      this.prisma.revisionSchedule.count({
        where: {
          userId,
          dueAt: { lte: now },
          itemType: { in: [RevisionItemType.TOPIC, RevisionItemType.QUESTION] },
        },
      }),
      this.prisma.revisionSchedule.count({
        where: { userId, dueAt: { lte: now }, itemType: RevisionItemType.FLASHCARD },
      }),
      this.prisma.examAttempt.findFirst({
        where: { userId, templateVersion: { template: { examId } } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      this.learning.recommendMock(userId, examId),
    ]);
    const topTopicIds = priorities.slice(0, 5).map((p) => p.topicId);
    const materials = await this.prisma.learningMaterial.findMany({
      where: { topicId: { in: topTopicIds }, status: ContentStatus.PUBLISHED, accessLevel: 'FREE' },
      select: { id: true, title: true, topicId: true, estimatedMinutes: true },
    });

    const planned = generateDailyPlan({
      availableMinutes: dailyMinutes,
      priorities,
      dueRevisionCount: dueRevision,
      dueFlashcardCount: dueFlash,
      carryOver: missed.map<CarryOverTask>((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        topicId: m.topicId,
        mockTemplateId: m.mockTemplateId,
        materialId: m.materialId,
        estimatedMinutes: m.estimatedMinutes,
      })),
      mockCandidate: mock ? { id: mock.id, title: mock.title, durationMinutes: mock.durationMinutes } : null,
      daysSinceLastMock: lastAttempt
        ? Math.floor((now.getTime() - lastAttempt.startedAt.getTime()) / 86_400_000)
        : null,
      materials: new Map(
        materials
          .filter((m) => m.topicId)
          .map((m) => [m.topicId!, { id: m.id, title: m.title, estimatedMinutes: m.estimatedMinutes }]),
      ),
    });

    const recoveredIds = missed
      .filter((m) =>
        planned.some((p) => p.reason.recovery && p.title === m.title && (p.topicId ?? null) === m.topicId),
      )
      .map((m) => m.id);
    await this.prisma.$transaction(async (tx) => {
      // Re-check inside the transaction so concurrent "today" calls cannot double-generate.
      const locked = await tx.studyPlan.updateMany({
        where: { id: planId, OR: [{ lastGeneratedFor: null }, { lastGeneratedFor: { lt: date } }] },
        data: { lastGeneratedFor: date },
      });
      if (!locked.count) return;
      if (recoveredIds.length)
        await tx.studyPlanTask.updateMany({
          where: { id: { in: recoveredIds } },
          data: { status: StudyTaskStatus.RESCHEDULED },
        });
      await tx.studyPlanTask.createMany({
        data: planned.map((p) => ({
          planId,
          scheduledDate: date,
          type: p.type,
          title: p.title,
          topicId: p.topicId,
          mockTemplateId: p.mockTemplateId,
          materialId: p.materialId,
          estimatedMinutes: p.estimatedMinutes,
          priorityScore: p.priorityScore,
          reason: p.reason as unknown as Prisma.InputJsonValue,
        })),
      });
    });
    return planned.length;
  }

  /** Nightly job: generate today's tasks for every active plan (batched). */
  async generateForAllActive(): Promise<number> {
    const today = dhakaDate();
    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const plans = await this.prisma.studyPlan.findMany({
        where: {
          status: StudyPlanStatus.ACTIVE,
          OR: [{ lastGeneratedFor: null }, { lastGeneratedFor: { lt: today } }],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!plans.length) break;
      for (const p of plans)
        total += await this.ensureDay(p.id, today).catch(
          (e: Error) => (this.logger.warn(`Plan ${p.id}: ${e.message}`), 0),
        );
      cursor = plans[plans.length - 1].id;
    }
    return total;
  }

  private async owned(userId: string, planId: string) {
    const plan = await this.prisma.studyPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.userId !== userId) throw AppError.notFound('Study plan');
    return plan;
  }

  private async ownedTask(userId: string, taskId: string) {
    const task = await this.prisma.studyPlanTask.findUnique({
      where: { id: taskId },
      include: { plan: { select: { userId: true } } },
    });
    if (!task || task.plan.userId !== userId) throw AppError.notFound('Task');
    const { plan: _p, ...rest } = task;
    return rest;
  }
}
