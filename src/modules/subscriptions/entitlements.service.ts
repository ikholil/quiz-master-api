import { Inject, Injectable } from '@nestjs/common';
import { EntitlementSource, Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../audit/audit.service';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';
import { ALL_FEATURES, FEATURES } from './features';

export interface ActiveEntitlement {
  featureKey: string;
  /** null = unlimited */
  limitValue: number | null;
  endsAt: string | null;
  sources: EntitlementSource[];
}

const CACHE_TTL = 60;

/**
 * Server-side source of truth for what a user may access. Client-reported subscription state is never trusted.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemConfigService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async getActive(userId: string): Promise<ActiveEntitlement[]> {
    const key = `ent:${userId}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return JSON.parse(cached) as ActiveEntitlement[];

    const now = new Date();
    const rows = await this.prisma.entitlement.findMany({
      where: { userId, revokedAt: null, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    });
    const merged = new Map<string, ActiveEntitlement>();
    for (const r of rows) {
      const cur = merged.get(r.featureKey);
      const endsAt = r.endsAt?.toISOString() ?? null;
      if (!cur) {
        merged.set(r.featureKey, { featureKey: r.featureKey, limitValue: r.limitValue, endsAt, sources: [r.source] });
        continue;
      }
      // Most generous wins: unlimited beats any limit; later expiry wins.
      cur.limitValue = cur.limitValue === null || r.limitValue === null ? null : Math.max(cur.limitValue, r.limitValue);
      cur.endsAt = cur.endsAt === null || endsAt === null ? null : cur.endsAt > endsAt ? cur.endsAt : endsAt;
      if (!cur.sources.includes(r.source)) cur.sources.push(r.source);
    }
    const list = [...merged.values()];
    // Cache no longer than the earliest expiry.
    const earliest = list.filter((e) => e.endsAt).map((e) => new Date(e.endsAt!).getTime() - now.getTime());
    const ttl = Math.max(1, Math.min(CACHE_TTL, ...earliest.map((ms) => Math.floor(ms / 1000))));
    await this.redis.set(key, JSON.stringify(list), 'EX', ttl).catch(() => undefined);
    return list;
  }

  async has(userId: string, feature: string): Promise<boolean> {
    return (await this.getActive(userId)).some((e) => e.featureKey === feature);
  }

  /** Daily quota for metered features. Returns null for unlimited. */
  async dailyLimit(userId: string, feature: string): Promise<number | null> {
    const ent = (await this.getActive(userId)).find((e) => e.featureKey === feature);
    if (ent) return ent.limitValue;
    switch (feature) {
      case FEATURES.AI_ASSISTANT:
        return this.cfg.ai.freeDailyMessages;
      case FEATURES.PRACTICE_QUESTIONS:
        return this.settings.get<number>(SETTINGS.FREE_PRACTICE_DAILY_QUESTIONS, 50);
      default:
        return 0;
    }
  }

  async assert(userId: string, feature: string): Promise<void> {
    if (!(await this.has(userId, feature))) throw AppError.paymentRequired(feature);
  }

  async invalidate(userId: string): Promise<void> {
    await this.redis.del(`ent:${userId}`).catch(() => undefined);
  }

  async grantFromPlan(tx: Tx, userId: string, subscriptionId: string, planId: string, startsAt: Date, endsAt: Date): Promise<void> {
    const features = await tx.planFeature.findMany({ where: { planId } });
    if (!features.length) return;
    await tx.entitlement.createMany({
      data: features.map((f) => ({
        userId,
        featureKey: f.featureKey,
        limitValue: f.limitValue,
        source: EntitlementSource.SUBSCRIPTION,
        sourceId: subscriptionId,
        startsAt,
        endsAt,
      })),
    });
  }

  async revokeBySource(tx: Tx, source: EntitlementSource, sourceId: string): Promise<void> {
    await tx.entitlement.updateMany({ where: { source, sourceId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async adminGrant(userId: string, dto: { featureKey: string; limitValue?: number | null; endsAt?: string; reason: string }, actorId: string, ctx: RequestContext) {
    if (!ALL_FEATURES.includes(dto.featureKey)) throw AppError.badRequest('UNKNOWN_FEATURE', 'Unknown feature key');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    const ent = await this.prisma.$transaction(async (tx) => {
      const created = await tx.entitlement.create({
        data: {
          userId,
          featureKey: dto.featureKey,
          limitValue: dto.limitValue ?? null,
          source: EntitlementSource.GRANT,
          endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        },
      });
      await this.audit.record({ actorId, action: 'entitlement.grant', entityType: 'Entitlement', entityId: created.id, after: dto, ctx }, tx);
      return created;
    });
    await this.invalidate(userId);
    return ent;
  }

  async adminRevoke(entitlementId: string, actorId: string, ctx: RequestContext) {
    const ent = await this.prisma.entitlement.findUnique({ where: { id: entitlementId } });
    if (!ent) throw AppError.notFound('Entitlement');
    await this.prisma.$transaction(async (tx) => {
      await tx.entitlement.update({ where: { id: entitlementId }, data: { revokedAt: new Date() } });
      await this.audit.record({ actorId, action: 'entitlement.revoke', entityType: 'Entitlement', entityId: entitlementId, before: ent, ctx }, tx);
    });
    await this.invalidate(ent.userId);
    return { ok: true };
  }

  listForUser(userId: string) {
    return this.prisma.entitlement.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  static toJson(v: unknown): Prisma.InputJsonValue {
    return v as Prisma.InputJsonValue;
  }
}
