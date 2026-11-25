import { Injectable, Logger } from '@nestjs/common';
import { EntitlementSource, Payment, Prisma, SubscriptionStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { addDays } from '../../common/utils/date.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EntitlementsService } from './entitlements.service';
import { CreatePlanDto, UpdatePlanDto } from './subscriptions.dto';

type PlanWithFeatures = Prisma.SubscriptionPlanGetPayload<{ include: { features: true } }>;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  static planView(p: PlanWithFeatures) {
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      nameBn: p.nameBn,
      description: p.description,
      priceMinor: p.priceMinor,
      currency: p.currency,
      durationDays: p.durationDays,
      isActive: p.isActive,
      features: p.features.map((f) => ({ featureKey: f.featureKey, limitValue: f.limitValue })),
    };
  }

  async listPlans(includeInactive = false) {
    const plans = await this.prisma.subscriptionPlan.findMany({
      where: includeInactive ? {} : { isActive: true },
      include: { features: true },
      orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
    });
    return plans.map(SubscriptionsService.planView);
  }

  async createPlan(dto: CreatePlanDto, actorId: string, ctx: RequestContext) {
    const plan = await this.prisma.$transaction(async (tx) => {
      const created = await tx.subscriptionPlan.create({
        data: {
          code: dto.code,
          name: dto.name,
          nameBn: dto.nameBn,
          description: dto.description,
          priceMinor: dto.priceMinor,
          durationDays: dto.durationDays,
          sortOrder: dto.sortOrder ?? 0,
          features: { create: dto.features.map((f) => ({ featureKey: f.featureKey, limitValue: f.limitValue ?? null })) },
        },
        include: { features: true },
      });
      await this.audit.record({ actorId, action: 'plan.create', entityType: 'SubscriptionPlan', entityId: created.id, after: dto, ctx }, tx);
      return created;
    });
    return SubscriptionsService.planView(plan);
  }

  /** Plan edits apply to future purchases only; existing entitlements keep the terms they were bought with. */
  async updatePlan(id: string, dto: UpdatePlanDto, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.subscriptionPlan.findUnique({ where: { id }, include: { features: true } });
    if (!before) throw AppError.notFound('Plan');
    const plan = await this.prisma.$transaction(async (tx) => {
      if (dto.features) {
        await tx.planFeature.deleteMany({ where: { planId: id } });
        await tx.planFeature.createMany({ data: dto.features.map((f) => ({ planId: id, featureKey: f.featureKey, limitValue: f.limitValue ?? null })) });
      }
      const { features: _f, ...rest } = dto;
      const updated = await tx.subscriptionPlan.update({ where: { id }, data: rest, include: { features: true } });
      await this.audit.record({ actorId, action: 'plan.update', entityType: 'SubscriptionPlan', entityId: id, before, after: dto, ctx }, tx);
      return updated;
    });
    return SubscriptionsService.planView(plan);
  }

  async mySubscriptions(userId: string) {
    const subs = await this.prisma.userSubscription.findMany({
      where: { userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return subs.map((s) => ({
      id: s.id,
      status: s.status,
      planId: s.planId,
      planCode: s.plan.code,
      planName: s.plan.name,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      cancelledAt: s.cancelledAt,
    }));
  }

  /**
   * Activates (or renews) a subscription for a verified payment. Must be called inside the payment
   * transaction so payment status and access change atomically. Idempotent per payment (unique paymentId).
   */
  async activateFromPayment(tx: Tx, payment: Payment): Promise<{ subscriptionId: string }> {
    const existing = await tx.userSubscription.findUnique({ where: { paymentId: payment.id } });
    if (existing) return { subscriptionId: existing.id };

    const plan = await tx.subscriptionPlan.findUnique({ where: { id: payment.referenceId } });
    if (!plan) throw AppError.notFound('Plan');
    const now = new Date();
    // Renewal: extend from the end of the latest active subscription of the same plan.
    const current = await tx.userSubscription.findFirst({
      where: { userId: payment.userId, planId: plan.id, status: SubscriptionStatus.ACTIVE, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });
    const startsAt = current?.endsAt ?? now;
    const endsAt = addDays(startsAt, plan.durationDays);
    const sub = await tx.userSubscription.create({
      data: {
        userId: payment.userId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        startsAt,
        endsAt,
        paymentId: payment.id,
        renewedFromId: current?.id,
      },
    });
    await this.entitlements.grantFromPlan(tx, payment.userId, sub.id, plan.id, startsAt, endsAt);
    return { subscriptionId: sub.id };
  }

  /** Revokes access granted by a payment (full refund / chargeback). */
  async revokeForPayment(tx: Tx, paymentId: string): Promise<void> {
    const sub = await tx.userSubscription.findUnique({ where: { paymentId } });
    if (!sub) return;
    await tx.userSubscription.update({ where: { id: sub.id }, data: { status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() } });
    await this.entitlements.revokeBySource(tx, EntitlementSource.SUBSCRIPTION, sub.id);
  }

  /** Cancels auto-continuation; access remains until endsAt (no partial refunds by default). */
  async cancel(userId: string, subscriptionId: string, ctx: RequestContext) {
    const sub = await this.prisma.userSubscription.findFirst({ where: { id: subscriptionId, userId } });
    if (!sub) throw AppError.notFound('Subscription');
    if (sub.status !== SubscriptionStatus.ACTIVE) throw AppError.badRequest('SUBSCRIPTION_NOT_ACTIVE', 'Subscription is not active');
    await this.prisma.userSubscription.update({ where: { id: sub.id }, data: { cancelledAt: new Date() } });
    await this.audit.record({ actorId: userId, action: 'subscription.cancel', entityType: 'UserSubscription', entityId: sub.id, ctx });
    return { id: sub.id, status: sub.status, endsAt: sub.endsAt };
  }

  /** Scheduled: mark lapsed subscriptions EXPIRED and revoke their entitlements. */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.prisma.userSubscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, endsAt: { lte: now } },
      select: { id: true, userId: true },
      take: 500,
    });
    for (const s of due) {
      await this.prisma.$transaction(async (tx) => {
        const res = await tx.userSubscription.updateMany({ where: { id: s.id, status: SubscriptionStatus.ACTIVE }, data: { status: SubscriptionStatus.EXPIRED } });
        if (res.count) await this.entitlements.revokeBySource(tx, EntitlementSource.SUBSCRIPTION, s.id);
      });
      await this.entitlements.invalidate(s.userId);
    }
    if (due.length) this.logger.log(`Expired ${due.length} subscriptions`);
    return due.length;
  }

  /** Scheduled: remind users whose subscription ends within 3 days and has no queued renewal. */
  async sendRenewalReminders(now = new Date()): Promise<number> {
    const soon = await this.prisma.userSubscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, endsAt: { gt: now, lte: addDays(now, 3) } },
      include: { plan: true },
      take: 1000,
    });
    let sent = 0;
    for (const s of soon) {
      const renewed = await this.prisma.userSubscription.count({ where: { renewedFromId: s.id } });
      if (renewed) continue;
      await this.notifications.notify(s.userId, {
        type: 'subscription.expiring',
        title: 'আপনার সাবস্ক্রিপশন শীঘ্রই শেষ হবে',
        body: `${s.plan.name} plan expires on ${s.endsAt!.toISOString().slice(0, 10)}. Renew to keep premium access.`,
        data: { subscriptionId: s.id, planId: s.planId },
        channels: ['IN_APP', 'PUSH'],
        dedupeKey: `renewal:${s.id}:${s.endsAt!.toISOString().slice(0, 10)}`,
      });
      sent++;
    }
    return sent;
  }

  async adminList(userId?: string, status?: SubscriptionStatus) {
    return this.prisma.userSubscription.findMany({
      where: { userId, status },
      include: { plan: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
}
