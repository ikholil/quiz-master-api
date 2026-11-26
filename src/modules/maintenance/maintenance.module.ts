import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, Module } from '@nestjs/common';
import { DataExportStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { ExamCalendarModule, ExamCalendarService } from '../exam-calendar/exam-calendar.module';
import { FilesService } from '../files/files.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  /** Removes expired security artefacts and stale exports (data minimisation). */
  async run() {
    const now = Date.now();
    const [otps, tokens, sessions] = await Promise.all([
      this.prisma.otpVerification.deleteMany({ where: { createdAt: { lt: new Date(now - 86_400_000) } } }),
      this.prisma.refreshToken.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { lt: new Date(now - 30 * 86_400_000) } }],
        },
      }),
      this.prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: new Date(now - 30 * 86_400_000) } },
            { revokedAt: { lt: new Date(now - 90 * 86_400_000) } },
          ],
        },
      }),
    ]);
    const exports = await this.prisma.dataExportRequest.findMany({
      where: { status: DataExportStatus.READY, expiresAt: { lt: new Date() } },
    });
    for (const e of exports) {
      if (e.fileId) {
        const file = await this.prisma.storedFile.findUnique({ where: { id: e.fileId } });
        if (file)
          await this.files
            .remove(file.id, {
              id: file.ownerId ?? '',
              sessionId: '',
              roles: [],
              permissions: ['files.manage'],
            })
            .catch(() => undefined);
      }
      await this.prisma.dataExportRequest.update({
        where: { id: e.id },
        data: { status: DataExportStatus.EXPIRED, fileId: null },
      });
    }
    const result = {
      otps: otps.count,
      refreshTokens: tokens.count,
      sessions: sessions.count,
      exports: exports.length,
    };
    this.logger.log(`Cleanup: ${JSON.stringify(result)}`);
    return result;
  }
}

@Processor(QUEUES.MAINTENANCE, { concurrency: 2 })
export class MaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly users: UsersService,
    private readonly subscriptions: SubscriptionsService,
    private readonly cleanup: CleanupService,
    private readonly calendar: ExamCalendarService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOBS.DATA_EXPORT:
        return this.users.buildDataExport(job.data.requestId as string);
      case JOBS.EXPIRE_SUBSCRIPTIONS:
        return this.subscriptions.expireDue();
      case JOBS.RENEWAL_REMINDERS:
        return this.subscriptions.sendRenewalReminders();
      case JOBS.EXAM_EVENT_REMINDERS:
        return this.calendar.sendReminders();
      case JOBS.CLEANUP:
        return this.cleanup.run();
      default:
        return undefined;
    }
  }
}

@Module({
  imports: [UsersModule, ExamCalendarModule],
  providers: [CleanupService, ...workers(MaintenanceProcessor)],
  exports: [CleanupService],
})
export class MaintenanceModule {}
