import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { JOBS, QUEUES } from './queue.constants';

/**
 * Registers repeatable (cron) jobs. Job schedulers are idempotent upserts, so every instance can run this
 * safely; BullMQ guarantees each tick is processed once. Times are in Asia/Dhaka.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @InjectQueue(QUEUES.LEARNING) private readonly learning: Queue,
    @InjectQueue(QUEUES.ANALYTICS) private readonly analytics: Queue,
    @InjectQueue(QUEUES.PAYMENTS) private readonly payments: Queue,
    @InjectQueue(QUEUES.ATTEMPTS) private readonly attempts: Queue,
    @InjectQueue(QUEUES.MAINTENANCE) private readonly maintenance: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.schedulersEnabled) return;
    const tz = 'Asia/Dhaka';
    const schedules: Array<[Queue, string, string]> = [
      [this.learning, JOBS.GENERATE_DAILY_PLANS, '5 0 * * *'],
      [this.learning, JOBS.REVISION_REMINDERS, '0 8 * * *'],
      [this.analytics, JOBS.AGGREGATE_DAILY, '30 0 * * *'],
      [this.payments, JOBS.RECONCILE_PAYMENTS, '*/15 * * * *'],
      [this.attempts, JOBS.SWEEP_EXPIRED_ATTEMPTS, '* * * * *'],
      [this.maintenance, JOBS.EXPIRE_SUBSCRIPTIONS, '*/10 * * * *'],
      [this.maintenance, JOBS.RENEWAL_REMINDERS, '0 10 * * *'],
      [this.maintenance, JOBS.CLEANUP, '15 3 * * *'],
      [this.analytics, JOBS.ITEM_ANALYSIS, '45 1 * * *'],
      [this.maintenance, JOBS.EXAM_EVENT_REMINDERS, '0 9 * * *'],
    ];
    try {
      for (const [queue, name, pattern] of schedules) {
        await queue.upsertJobScheduler(`cron-${name}`, { pattern, tz }, { name, data: {} });
      }
      this.logger.log(`Registered ${schedules.length} scheduled jobs`);
    } catch (err) {
      this.logger.error(`Failed to register schedules: ${(err as Error).message}`);
    }
  }
}
