import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    (this as unknown as PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>).$on('warn', (e) =>
      this.logger.warn(e.message),
    );
    (this as unknown as PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>).$on('error', (e) =>
      this.logger.error(e.message),
    );
  }

  async onModuleInit(): Promise<void> {
    // Connection is lazy; this only validates connectivity at boot when DB is reachable.
    await this.$connect().catch((err: Error) =>
      this.logger.error(`Database connection failed: ${err.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Serializable transactions with bounded retry for critical multi-record operations. */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, retries = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15000,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt < retries && (code === 'P2034' || code === '40001')) continue;
        throw err;
      }
    }
  }
}
