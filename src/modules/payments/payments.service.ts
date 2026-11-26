import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Payment, PaymentPurpose, PaymentStatus, PaymentTransactionType, Prisma, PublishStatus, RefundStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { CoursesService } from '../courses/courses.module';
import { NotificationsService } from '../notifications/notifications.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdminPaymentQueryDto, InitiatePaymentDto, RefundDto } from './payments.dto';
import { InvalidWebhookError, PaymentProvider, sanitizePayload } from './providers/payment-provider';
import { SandboxPaymentProvider } from './providers/sandbox.provider';
import { SslCommerzProvider } from './providers/sslcommerz.provider';

const PENDING_EXPIRY_MS = 3 * 86_400_000;

export function newMerchantTxnId(): string {
  return `QM${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly courses: CoursesService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS) redis: Redis,
    @InjectQueue(QUEUES.PAYMENTS) private readonly queue: Queue,
  ) {
    const p = cfg.payments;
    if (cfg.env !== 'production') this.register(new SandboxPaymentProvider(p.sandboxWebhookSecret, redis, cfg.publicBaseUrl));
    this.register(new SslCommerzProvider(p.sslcommerz.storeId, p.sslcommerz.storePassword, p.sslcommerz.sandbox));
  }

  register(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }

  availableProviders() {
    return [...this.providers.values()].filter((p) => p.isConfigured()).map((p) => ({ name: p.name, isDefault: p.name === this.cfg.payments.defaultProvider }));
  }

  private provider(name: string): PaymentProvider {
    const p = this.providers.get(name);
    if (!p || !p.isConfigured()) throw AppError.badRequest('PAYMENT_PROVIDER_UNAVAILABLE', `Payment provider "${name}" is not available`);
    return p;
  }

  /** Amount and currency always come from the server-side catalogue, never from the client. */
  async initiate(user: AuthUser, dto: InitiatePaymentDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } } });
      if (existing) {
        if (existing.referenceId !== dto.referenceId || existing.purpose !== dto.purpose) {
          throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different purchase');
        }
        return this.view(existing);
      }
    }
    const { amountMinor, currency, productName } = await this.price(dto.purpose, dto.referenceId);
    if (amountMinor <= 0) throw AppError.badRequest('FREE_ITEM', 'This item is free; no payment is needed');
    const provider = this.provider(dto.provider ?? this.cfg.payments.defaultProvider);
    const profile = await this.prisma.user.findUnique({ where: { id: user.id }, include: { profile: true } });

    const payment = await this.prisma.payment.create({
      data: {
        userId: user.id,
        purpose: dto.purpose,
        referenceId: dto.referenceId,
        provider: provider.name,
        merchantTxnId: newMerchantTxnId(),
        amountMinor,
        currency,
        idempotencyKey,
        transactions: { create: { type: PaymentTransactionType.INITIATE, status: PaymentStatus.INITIATED, amountMinor } },
      },
    });

    try {
      const ipnUrl = `${this.cfg.publicBaseUrl}/api/v1/payments/webhooks/${provider.name}`;
      const result = await provider.initiate(payment, {
        customer: { name: profile?.profile?.fullName ?? 'Student', email: profile?.email, phone: profile?.phone?.replace('+88', '') },
        productName,
        successUrl: `${this.cfg.payments.successRedirectUrl}?paymentId=${payment.id}`,
        failUrl: `${this.cfg.payments.failRedirectUrl}?paymentId=${payment.id}`,
        cancelUrl: `${this.cfg.payments.failRedirectUrl}?paymentId=${payment.id}&cancelled=1`,
        ipnUrl,
      });
      const updated = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PENDING,
          metadata: { redirectUrl: result.redirectUrl, sessionRef: result.providerRef ?? null } as Prisma.InputJsonValue,
          transactions: { create: { type: PaymentTransactionType.INITIATE, status: PaymentStatus.PENDING, payload: sanitizePayload(result.raw ?? {}) as Prisma.InputJsonValue } },
        },
      });
      return this.view(updated);
    } catch (err) {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED, failureReason: (err as Error).message.slice(0, 300) } });
      this.logger.error(`Payment initiation ${payment.id} failed: ${(err as Error).message}`);
      throw new AppError('PAYMENT_INITIATION_FAILED', 'Could not start the payment. Please try again.', HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Webhook entry point: verifies authenticity, records the event once (unique provider+eventId) and queues
   * confirmation. Duplicate deliveries are acknowledged without re-processing.
   */
  async receiveWebhook(providerName: string, headers: Record<string, string | string[] | undefined>, rawBody: Buffer | undefined, body: Record<string, unknown>) {
    const provider = this.provider(providerName);
    let event;
    try {
      event = await provider.parseWebhook(headers, rawBody ?? Buffer.from(JSON.stringify(body)), body);
    } catch (err) {
      if (err instanceof InvalidWebhookError) {
        this.logger.warn(`Rejected ${providerName} webhook: ${err.message}`);
        throw AppError.unauthorized('Invalid webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
      }
      throw err;
    }
    const payment = await this.prisma.payment.findUnique({ where: { merchantTxnId: event.merchantTxnId } });
    if (!payment || payment.provider !== providerName) throw AppError.notFound('Payment');
    try {
      await this.prisma.paymentWebhookEvent.create({
        data: { provider: providerName, eventId: event.eventId, paymentId: payment.id, payload: sanitizePayload(event.raw) as Prisma.InputJsonValue },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { received: true, duplicate: true };
      throw err;
    }
    await this.queue.add(JOBS.PROCESS_WEBHOOK, { paymentId: payment.id, provider: providerName, eventId: event.eventId }, { jobId: `webhook:${providerName}:${event.eventId}` });
    return { received: true, duplicate: false };
  }

  /**
   * Confirms a payment with the provider and fulfils it exactly once. The PENDING→SUCCEEDED transition is a
   * conditional update in the same transaction as the subscription/enrolment grant.
   */
  async confirm(paymentId: string, source: 'webhook' | 'client' | 'reconcile'): Promise<Payment> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw AppError.notFound('Payment');
    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.INITIATED) return payment;
    const provider = this.provider(payment.provider);
    const result = await provider.verify(payment);

    if (result.status === 'PENDING') {
      await this.prisma.paymentTransaction.create({ data: { paymentId, type: PaymentTransactionType.VERIFY, status: PaymentStatus.PENDING, payload: { source } } });
      return payment;
    }

    const amountOk = result.amountMinor === payment.amountMinor && (result.currency ?? payment.currency) === payment.currency;
    if (result.status === 'SUCCEEDED' && !amountOk) {
      this.logger.error(`Amount mismatch for payment ${paymentId}: expected ${payment.amountMinor}, provider reported ${result.amountMinor}`);
    }
    const success = result.status === 'SUCCEEDED' && amountOk;

    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] } },
        data: success
          ? { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), providerRef: result.providerRef ?? payment.providerRef, metadata: { ...((payment.metadata as object) ?? {}), ...sanitizePayload(result.raw ?? {}), bank_tran_id: (result.raw as { bank_tran_id?: string } | undefined)?.bank_tran_id } as Prisma.InputJsonValue }
          : { status: PaymentStatus.FAILED, failureReason: result.status === 'SUCCEEDED' ? 'AMOUNT_MISMATCH' : 'PROVIDER_DECLINED' },
      });
      await tx.paymentTransaction.create({
        data: { paymentId, type: source === 'webhook' ? PaymentTransactionType.WEBHOOK : source === 'reconcile' ? PaymentTransactionType.RECONCILE : PaymentTransactionType.VERIFY, status: success ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED, amountMinor: result.amountMinor, payload: sanitizePayload(result.raw ?? {}) as Prisma.InputJsonValue },
      });
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (res.count === 1 && success) await this.fulfil(tx, fresh);
      return fresh;
    });

    await this.prisma.paymentWebhookEvent.updateMany({ where: { paymentId, processedAt: null }, data: { processedAt: new Date() } });
    if (updated.status === PaymentStatus.SUCCEEDED) {
      await this.entitlements.invalidate(updated.userId);
      await this.notifications.notify(updated.userId, {
        type: 'payment.succeeded',
        title: 'পেমেন্ট সফল হয়েছে',
        body: `Payment of ৳${(updated.amountMinor / 100).toFixed(2)} received. Your access is active.`,
        data: { paymentId: updated.id, purpose: updated.purpose },
        channels: ['IN_APP', 'PUSH'],
        dedupeKey: `payment:${updated.id}`,
      });
    }
    return updated;
  }

  private async fulfil(tx: Tx, payment: Payment) {
    if (payment.purpose === PaymentPurpose.SUBSCRIPTION) await this.subscriptions.activateFromPayment(tx, payment);
    else await this.courses.fulfilFromPayment(tx, payment);
  }

  async get(userId: string, id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.userId !== userId) throw AppError.notFound('Payment');
    return this.view(p);
  }

  /** Called by the client after returning from the gateway; status is re-verified server-side. */
  async verifyForUser(userId: string, id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p || p.userId !== userId) throw AppError.notFound('Payment');
    return this.view(await this.confirm(id, 'client'));
  }

  async mine(userId: string, q: { page: number; pageSize: number }) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.payment.count({ where: { userId } }),
    ]);
    return PageResult.of(rows.map((r) => this.view(r)), total, q);
  }

  /** Scheduled: re-verify stale pending payments (missed webhooks) and expire abandoned ones. */
  async reconcile(): Promise<{ checked: number; expired: number }> {
    const now = Date.now();
    const stale = await this.prisma.payment.findMany({
      where: { status: PaymentStatus.PENDING, createdAt: { lt: new Date(now - 10 * 60_000), gt: new Date(now - PENDING_EXPIRY_MS) } },
      take: 200,
    });
    for (const p of stale) await this.confirm(p.id, 'reconcile').catch((e: Error) => this.logger.warn(`Reconcile ${p.id}: ${e.message}`));
    const expired = await this.prisma.payment.updateMany({
      where: { status: { in: [PaymentStatus.PENDING, PaymentStatus.INITIATED] }, createdAt: { lte: new Date(now - PENDING_EXPIRY_MS) } },
      data: { status: PaymentStatus.CANCELLED, failureReason: 'EXPIRED' },
    });
    return { checked: stale.length, expired: expired.count };
  }

  async refund(paymentId: string, dto: RefundDto, actor: AuthUser, ctx: RequestContext) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw AppError.notFound('Payment');
    if (!([PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] as PaymentStatus[]).includes(payment.status)) {
      throw AppError.conflict('NOT_REFUNDABLE', 'Only successful payments can be refunded');
    }
    const amount = dto.amountMinor ?? payment.amountMinor - payment.refundedMinor;
    if (amount <= 0 || payment.refundedMinor + amount > payment.amountMinor) throw AppError.badRequest('INVALID_REFUND_AMOUNT', 'Refund exceeds the refundable amount');
    const provider = this.provider(payment.provider);
    if (!provider.refund) throw AppError.badRequest('REFUND_UNSUPPORTED', 'This provider does not support API refunds');

    const refund = await this.prisma.refund.create({ data: { paymentId, amountMinor: amount, reason: dto.reason, requestedById: actor.id, status: RefundStatus.PROCESSING } });
    try {
      const res = await provider.refund(payment, amount, dto.reason);
      const full = payment.refundedMinor + amount === payment.amountMinor;
      await this.prisma.$transaction(async (tx) => {
        await tx.refund.update({ where: { id: refund.id }, data: { status: res.status === 'COMPLETED' ? RefundStatus.COMPLETED : RefundStatus.PROCESSING, providerRef: res.providerRef, processedAt: new Date() } });
        await tx.payment.update({ where: { id: paymentId }, data: { refundedMinor: { increment: amount }, status: full ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED } });
        await tx.paymentTransaction.create({ data: { paymentId, type: PaymentTransactionType.REFUND, status: full ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED, amountMinor: amount } });
        if (full && !dto.keepAccess) {
          if (payment.purpose === PaymentPurpose.SUBSCRIPTION) await this.subscriptions.revokeForPayment(tx, paymentId);
          else await this.courses.revokeForPayment(tx, paymentId);
        }
        await this.audit.record({ actorId: actor.id, action: 'payment.refund', entityType: 'Payment', entityId: paymentId, after: { amount, reason: dto.reason, full }, ctx }, tx);
      });
      await this.entitlements.invalidate(payment.userId);
      return this.prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    } catch (err) {
      await this.prisma.refund.update({ where: { id: refund.id }, data: { status: RefundStatus.FAILED } });
      throw new AppError('REFUND_FAILED', `Refund failed: ${(err as Error).message.slice(0, 200)}`, HttpStatus.BAD_GATEWAY);
    }
  }

  async adminList(q: AdminPaymentQueryDto) {
    const where: Prisma.PaymentWhereInput = { status: q.status, userId: q.userId, provider: q.provider, purpose: q.purpose, merchantTxnId: q.merchantTxnId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where, orderBy: { createdAt: q.sortOrder }, ...pageArgs(q) }),
      this.prisma.payment.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async adminGet(id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id }, include: { transactions: { orderBy: { createdAt: 'asc' } }, refunds: true } });
    if (!p) throw AppError.notFound('Payment');
    return p;
  }

  private async price(purpose: PaymentPurpose, referenceId: string) {
    if (purpose === PaymentPurpose.SUBSCRIPTION) {
      const plan = await this.prisma.subscriptionPlan.findFirst({ where: { id: referenceId, isActive: true } });
      if (!plan) throw AppError.notFound('Plan');
      return { amountMinor: plan.priceMinor, currency: plan.currency, productName: `Subscription: ${plan.name}` };
    }
    const course = await this.prisma.course.findFirst({ where: { id: referenceId, status: PublishStatus.PUBLISHED } });
    if (!course) throw AppError.notFound('Course');
    return { amountMinor: course.priceMinor, currency: course.currency, productName: `Course: ${course.title}` };
  }

  private view(p: Payment) {
    const meta = (p.metadata ?? {}) as { redirectUrl?: string };
    return {
      id: p.id,
      purpose: p.purpose,
      referenceId: p.referenceId,
      provider: p.provider,
      merchantTxnId: p.merchantTxnId,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      redirectUrl: p.status === PaymentStatus.PENDING ? meta.redirectUrl ?? null : null,
      paidAt: p.paidAt,
      refundedMinor: p.refundedMinor,
      createdAt: p.createdAt,
    };
  }
}
