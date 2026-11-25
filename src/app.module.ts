import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { AppConfigModule } from './config/config.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { ErrorReporter } from './common/monitoring/error-reporter';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AttemptsModule } from './modules/attempts/attempts.module';
import { AuditModule } from './modules/audit/audit.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { CommunityModule } from './modules/community/community.module';
import { CoursesModule } from './modules/courses/courses.module';
import { ExamsModule } from './modules/exams/exams.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { LearningModule } from './modules/learning/learning.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { MockExamsModule } from './modules/mock-exams/mock-exams.module';
import { ModerationModule } from './modules/moderation/moderation.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PracticeModule } from './modules/practice/practice.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RevisionModule } from './modules/revision/revision.module';
import { StudyPlansModule } from './modules/study-plans/study-plans.module';
import { EntitlementGuard } from './modules/subscriptions/entitlement.guard';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SupportModule } from './modules/support/support.module';
import { SyllabusModule } from './modules/syllabus/syllabus.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({
        pinoHttp: {
          level: cfg.logLevel,
          genReqId: (req: IncomingMessage) => {
            const incoming = req.headers['x-request-id'];
            return typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
          },
          customProps: (req: IncomingMessage) => ({ userId: (req as IncomingMessage & { user?: { id: string } }).user?.id }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-signature"]',
              'req.body.password',
              'req.body.newPassword',
              'req.body.currentPassword',
              'req.body.code',
              'req.body.refreshToken',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          serializers: {
            req: (req: { id: string; method: string; url: string; remoteAddress?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url?.replace(/(token|signature)=[^&]+/gi, '$1=[REDACTED]'),
              remoteAddress: req.remoteAddress,
            }),
          },
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/api/v1/health') ?? false },
          transport: cfg.env === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, RedisThrottlerStorage],
      useFactory: (cfg: AppConfig, storage: RedisThrottlerStorage) => ({
        throttlers: [{ name: 'default', ttl: cfg.rateLimit.ttlSeconds * 1000, limit: cfg.rateLimit.limit }],
        storage,
      }),
      extraProviders: [RedisThrottlerStorage],
    }),
    AuditModule,
    RbacModule,
    SystemConfigModule,
    FilesModule,
    AuthModule,
    UsersModule,
    NotificationsModule,
    SubscriptionsModule,
    ExamsModule,
    SyllabusModule,
    QuestionsModule,
    PracticeModule,
    MockExamsModule,
    AttemptsModule,
    LearningModule,
    StudyPlansModule,
    RevisionModule,
    MaterialsModule,
    AiModule,
    KnowledgeModule,
    CoursesModule,
    PaymentsModule,
    CommunityModule,
    ModerationModule,
    SupportModule,
    AnalyticsModule,
    MaintenanceModule,
    HealthModule,
  ],
  providers: [
    ErrorReporter,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // Guard order matters: rate limit → authenticate → authorise → entitlement.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: PermissionsGuard },
    { provide: APP_GUARD, useExisting: EntitlementGuard },
  ],
})
export class AppModule {}
