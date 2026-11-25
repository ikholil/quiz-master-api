import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queue.constants';
import { SchedulerService } from './scheduler.service';

const queueRegistrations = Object.values(QUEUES).map((name) =>
  BullModule.registerQueue({ name, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
);

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => {
        const url = new URL(cfg.redisUrl);
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
            tls: url.protocol === 'rediss:' ? {} : undefined,
            maxRetriesPerRequest: null,
          },
          prefix: `${cfg.appName}:${cfg.env}`,
        };
      },
    }),
    ...queueRegistrations,
  ],
  providers: [SchedulerService],
  exports: [BullModule],
})
export class QueueModule {}
