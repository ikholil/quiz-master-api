import { Controller, Get, HttpStatus, Inject, Module, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Public } from '../../common/decorators/auth.decorators';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { REDIS } from '../../redis/redis.module';
import { FilesService } from '../files/files.service';

let shuttingDown = false;
export function markShuttingDown(): void {
  shuttingDown = true;
}

async function timed<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly files: FilesService,
  ) {}

  /** Liveness: the process is running and the event loop responds. */
  @Public()
  @RawResponse()
  @Get('live')
  live() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: dependencies are reachable; returns 503 while draining during shutdown. */
  @Public()
  @RawResponse()
  @Get('ready')
  async ready(@Res() res: Response) {
    const [database, redis, storage] = await Promise.all([
      timed(() => this.prisma.$queryRaw`SELECT 1`),
      timed(() => this.redis.ping()),
      timed(async () => {
        if (!(await this.files.healthy())) throw new Error('storage unavailable');
      }),
    ]);
    const ok = !shuttingDown && database.ok && redis.ok && storage.ok;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: ok ? 'ok' : shuttingDown ? 'draining' : 'degraded',
      checks: { database, redis, storage },
    });
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
