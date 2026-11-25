import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { OtpChannel, OtpPurpose } from '@prisma/client';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import { generateOtp, hmacSha256, safeEqualHex } from '../../common/utils/crypto.util';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { REDIS } from '../../redis/redis.module';

const MAX_SENDS_PER_IDENTIFIER_PER_HOUR = 5;
const MAX_SENDS_PER_IP_PER_HOUR = 30;

export interface OtpRequestResult {
  /** Seconds until the client may request another code. */
  cooldownSeconds: number;
  expiresInSeconds: number;
  /** Only populated in development/test (EXPOSE_DEV_OTP) — never in production. */
  devCode?: string;
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectQueue(QUEUES.MESSAGING) private readonly messaging: Queue,
  ) {}

  private hash(identifier: string, purpose: OtpPurpose, code: string): string {
    // Binding identifier + purpose into the MAC prevents a code issued for one flow being replayed in another.
    return hmacSha256(this.cfg.auth.otpHmacSecret, `${identifier}|${purpose}|${code}`);
  }

  async issue(identifier: string, channel: OtpChannel, purpose: OtpPurpose, ip?: string, deliver = true): Promise<OtpRequestResult> {
    const cooldownKey = `otp:cooldown:${purpose}:${identifier}`;
    const ttl = await this.redis.ttl(cooldownKey);
    if (ttl > 0) {
      throw new AppError('OTP_COOLDOWN', `Please wait ${ttl} seconds before requesting another code`, HttpStatus.TOO_MANY_REQUESTS, {
        retryAfterSeconds: ttl,
      });
    }
    await this.bumpOrThrow(`otp:hourly:${identifier}`, MAX_SENDS_PER_IDENTIFIER_PER_HOUR, 'Too many codes requested for this account. Try again later.');
    if (ip) await this.bumpOrThrow(`otp:hourly-ip:${ip}`, MAX_SENDS_PER_IP_PER_HOUR, 'Too many codes requested from this network. Try again later.');

    const code = generateOtp(6);
    await this.prisma.$transaction([
      // Invalidate previous outstanding codes for the same flow.
      this.prisma.otpVerification.updateMany({
        where: { identifier, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      this.prisma.otpVerification.create({
        data: {
          identifier,
          channel,
          purpose,
          codeHash: this.hash(identifier, purpose, code),
          maxAttempts: this.cfg.auth.otpMaxAttempts,
          expiresAt: new Date(Date.now() + this.cfg.auth.otpTtlSeconds * 1000),
          ipAddress: ip,
        },
      }),
    ]);
    await this.redis.set(cooldownKey, '1', 'EX', this.cfg.auth.otpResendCooldownSeconds);

    if (deliver) {
      await this.messaging.add(
        JOBS.SEND_OTP,
        { identifier, channel, purpose, code },
        { removeOnComplete: true, removeOnFail: { age: 3600 }, attempts: 3 },
      );
    }
    return {
      cooldownSeconds: this.cfg.auth.otpResendCooldownSeconds,
      expiresInSeconds: this.cfg.auth.otpTtlSeconds,
      ...(this.cfg.auth.exposeDevOtp ? { devCode: code } : {}),
    };
  }

  /** Verifies and consumes a code. Attempts are counted before comparison to resist brute force. */
  async verify(identifier: string, purpose: OtpPurpose, code: string): Promise<void> {
    const otp = await this.prisma.otpVerification.findFirst({
      where: { identifier, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt <= new Date()) throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired');
    if (otp.attempts >= otp.maxAttempts) throw AppError.badRequest('OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Request a new code.');

    const bumped = await this.prisma.otpVerification.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: otp.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.count !== 1) throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired');

    if (!/^\d{6}$/.test(code) || !safeEqualHex(this.hash(identifier, purpose, code), otp.codeHash)) {
      const remaining = otp.maxAttempts - otp.attempts - 1;
      throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired', { remainingAttempts: Math.max(remaining, 0) });
    }
    const consumed = await this.prisma.otpVerification.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (consumed.count !== 1) throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired');
  }

  private async bumpOrThrow(key: string, max: number, message: string): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 3600);
    if (count > max) {
      const ttl = await this.redis.ttl(key);
      throw new AppError('OTP_RATE_LIMITED', message, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: ttl });
    }
  }
}
