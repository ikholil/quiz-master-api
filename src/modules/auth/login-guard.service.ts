import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import { sha256 } from '../../common/utils/crypto.util';
import { REDIS } from '../../redis/redis.module';

/** Per-identifier failed login counter with temporary lockout (brute-force protection for password logins). */
@Injectable()
export class LoginGuardService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private key(identifier: string) {
    return `authfail:${sha256(identifier)}`;
  }

  async assertNotLocked(identifier: string): Promise<void> {
    const key = this.key(identifier);
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count >= this.cfg.auth.loginMaxFailures) {
      const ttl = await this.redis.ttl(key);
      throw new AppError(
        'ACCOUNT_TEMPORARILY_LOCKED',
        'Too many failed sign-in attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        {
          retryAfterSeconds: Math.max(ttl, 1),
        },
      );
    }
  }

  async recordFailure(identifier: string): Promise<void> {
    const key = this.key(identifier);
    const count = await this.redis.incr(key);
    if (count === 1 || count === this.cfg.auth.loginMaxFailures) {
      await this.redis.expire(key, this.cfg.auth.loginLockMinutes * 60);
    }
  }

  async reset(identifier: string): Promise<void> {
    await this.redis.del(this.key(identifier));
  }
}
