import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ClientPlatform } from '@prisma/client';
import type Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import { randomToken, sha256 } from '../../common/utils/crypto.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';
import { AuditService } from '../audit/audit.service';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  typ: 'access';
}

export interface DeviceInfo {
  platform?: ClientPlatform;
  deviceId?: string;
  deviceName?: string;
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
}

/** Grace window in which re-presenting a just-rotated refresh token is treated as a client retry, not theft. */
const REUSE_GRACE_MS = 15_000;
const SESSION_CACHE_TTL = 60;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async createSession(userId: string, device: DeviceInfo, ctx: RequestContext, isAdmin: boolean): Promise<IssuedTokens> {
    const ttlDays = isAdmin ? this.cfg.auth.adminRefreshTtlDays : this.cfg.auth.refreshTtlDays;
    const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
    const refreshToken = randomToken();

    const session = await this.prisma.session.create({
      data: {
        userId,
        platform: device.platform ?? ClientPlatform.OTHER,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        ipAddress: ctx.ip,
        userAgent: ctx.userAgent,
        expiresAt,
        refreshTokens: { create: { tokenHash: sha256(refreshToken), expiresAt } },
      },
    });
    await this.redis.set(`sess:${session.id}`, '1', 'EX', SESSION_CACHE_TTL).catch(() => undefined);
    return this.issue(userId, session.id, refreshToken, expiresAt);
  }

  /** Refresh token rotation with reuse detection: a replayed token revokes the whole session. */
  async rotate(refreshToken: string, ctx: RequestContext): Promise<IssuedTokens & { userId: string }> {
    const tokenHash = sha256(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash }, include: { session: true } });
    if (!record) throw AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

    const { session } = record;
    if (record.revokedAt || record.usedAt) {
      const withinGrace = record.usedAt && Date.now() - record.usedAt.getTime() < REUSE_GRACE_MS && !record.revokedAt;
      if (!withinGrace) {
        await this.revokeSession(session.id, 'refresh_token_reuse');
        await this.audit.record({ actorId: session.userId, action: 'auth.refresh.reuse_detected', entityType: 'Session', entityId: session.id, ctx });
        this.logger.warn(`Refresh token reuse detected for session ${session.id}`);
        throw AppError.unauthorized('Refresh token was already used; session revoked', 'REFRESH_TOKEN_REUSED');
      }
      throw AppError.unauthorized('Refresh token was already used', 'REFRESH_TOKEN_ALREADY_USED');
    }
    if (record.expiresAt <= new Date() || session.revokedAt || session.expiresAt <= new Date()) {
      throw AppError.unauthorized('Session expired, please sign in again', 'SESSION_EXPIRED');
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId }, select: { status: true } });
    if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') {
      await this.revokeSession(session.id, 'user_inactive');
      throw AppError.unauthorized('Account is not active', 'ACCOUNT_INACTIVE');
    }

    const next = randomToken();
    await this.prisma.$transaction(async (tx) => {
      // Conditional update guards against two concurrent rotations of the same token.
      const marked = await tx.refreshToken.updateMany({ where: { id: record.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } });
      if (marked.count !== 1) throw AppError.unauthorized('Refresh token was already used', 'REFRESH_TOKEN_ALREADY_USED');
      const created = await tx.refreshToken.create({ data: { sessionId: session.id, tokenHash: sha256(next), expiresAt: session.expiresAt } });
      await tx.refreshToken.update({ where: { id: record.id }, data: { replacedById: created.id } });
      await tx.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), ipAddress: ctx.ip ?? session.ipAddress } });
    });
    const tokens = await this.issue(session.userId, session.id, next, session.expiresAt);
    return { ...tokens, userId: session.userId };
  }

  async isSessionActive(sessionId: string): Promise<boolean> {
    const cached = await this.redis.get(`sess:${sessionId}`).catch(() => null);
    if (cached !== null) return cached === '1';
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true, user: { select: { status: true } } },
    });
    const active =
      !!session && !session.revokedAt && session.expiresAt > new Date() && (session.user.status === 'ACTIVE' || session.user.status === 'PENDING_VERIFICATION');
    await this.redis.set(`sess:${sessionId}`, active ? '1' : '0', 'EX', SESSION_CACHE_TTL).catch(() => undefined);
    return active;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } }),
      this.prisma.refreshToken.updateMany({ where: { sessionId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.redis.set(`sess:${sessionId}`, '0', 'EX', this.cfg.auth.accessTtlSeconds + 60).catch(() => undefined);
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, id: exceptSessionId ? { not: exceptSessionId } : undefined },
      select: { id: true },
    });
    for (const s of sessions) await this.revokeSession(s.id, reason);
    return sessions.length;
  }

  listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, platform: true, deviceName: true, ipAddress: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    });
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    const claims = this.jwt.verify<AccessTokenClaims>(token, { secret: this.cfg.auth.accessSecret, algorithms: ['HS256'] });
    if (claims.typ !== 'access') throw new Error('wrong token type');
    return claims;
  }

  private async issue(userId: string, sessionId: string, refreshToken: string, refreshExpiresAt: Date): Promise<IssuedTokens> {
    const claims: AccessTokenClaims = { sub: userId, sid: sessionId, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.cfg.auth.accessSecret,
      expiresIn: this.cfg.auth.accessTtlSeconds,
      algorithm: 'HS256',
    });
    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.cfg.auth.accessTtlSeconds * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      sessionId,
    };
  }
}
