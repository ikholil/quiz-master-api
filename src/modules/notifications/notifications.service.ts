import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import { ClientPlatform, NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PageResult, PaginationQueryDto, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../audit/audit.service';

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels?: Array<keyof typeof NotificationChannel>;
  /** Suppresses duplicates with the same key for 48 hours (e.g. scheduled reminders). */
  dedupeKey?: string;
}

export interface BroadcastSegment {
  all?: boolean;
  examId?: string;
  planCode?: string;
  userIds?: string[];
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  async notify(userId: string, input: NotifyInput): Promise<string | null> {
    if (input.dedupeKey) {
      const fresh = await this.redis.set(`notif:dedupe:${input.dedupeKey}`, '1', 'EX', 48 * 3600, 'NX');
      if (fresh !== 'OK') return null;
    }
    const channels = (input.channels ?? ['IN_APP']).map((c) => NotificationChannel[c]);
    const n = await this.prisma.notification.create({
      data: {
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        channels,
        status: channels.every((c) => c === NotificationChannel.IN_APP)
          ? NotificationStatus.SENT
          : NotificationStatus.QUEUED,
        sentAt: channels.every((c) => c === NotificationChannel.IN_APP) ? new Date() : null,
      },
    });
    if (channels.some((c) => c !== NotificationChannel.IN_APP)) {
      await this.queue.add(JOBS.DELIVER_NOTIFICATION, { notificationId: n.id }, { jobId: `notif-${n.id}` });
    }
    return n.id;
  }

  async list(userId: string, q: PaginationQueryDto, unreadOnly: boolean) {
    const where: Prisma.NotificationWhereInput = { userId, readAt: unreadOnly ? null : undefined };
    const [items, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...pageArgs(q),
        select: { id: true, type: true, title: true, body: true, data: true, readAt: true, createdAt: true },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    const page = PageResult.of(items, total, q);
    return Object.assign(page, { unread });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({ where: { userId, readAt: null } }).then((count) => ({ count }));
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (!res.count) {
      const exists = await this.prisma.notification.count({ where: { id, userId } });
      if (!exists) throw AppError.notFound('Notification');
    }
    return { ok: true };
  }

  async markAllRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  async registerDevice(userId: string, token: string, platform: ClientPlatform) {
    // A token belongs to exactly one user (device sign-in switches ownership).
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastUsedAt: new Date() },
    });
    return { ok: true };
  }

  async removeDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { ok: true };
  }

  async broadcast(segment: BroadcastSegment, input: NotifyInput, actorId: string, ctx: RequestContext) {
    if (!segment.all && !segment.examId && !segment.planCode && !segment.userIds?.length) {
      throw AppError.badRequest('EMPTY_SEGMENT', 'Specify a target segment');
    }
    const job = await this.queue.add(JOBS.BROADCAST_NOTIFICATION, { segment, input });
    await this.audit.record({
      actorId,
      action: 'notification.broadcast',
      entityType: 'Notification',
      metadata: { segment, title: input.title, jobId: job.id },
      ctx,
    });
    return { queued: true, jobId: job.id };
  }

  /** Resolves a broadcast segment to user ids in batches (used by the worker). */
  async *segmentUsers(segment: BroadcastSegment, batchSize = 500): AsyncGenerator<string[]> {
    if (segment.userIds?.length) {
      for (let i = 0; i < segment.userIds.length; i += batchSize)
        yield segment.userIds.slice(i, i + batchSize);
      return;
    }
    const where: Prisma.UserWhereInput = {
      status: 'ACTIVE',
      deletedAt: null,
      profile: segment.examId ? { targetExamIds: { has: segment.examId } } : undefined,
      subscriptions: segment.planCode
        ? { some: { status: 'ACTIVE', plan: { code: segment.planCode } } }
        : undefined,
    };
    let cursor: string | undefined;
    for (;;) {
      const users = await this.prisma.user.findMany({
        where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!users.length) return;
      yield users.map((u) => u.id);
      cursor = users[users.length - 1].id;
    }
  }
}
