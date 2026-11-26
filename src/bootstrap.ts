import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { APP_CONFIG, AppConfig } from './config/configuration';
import type { ValidationError } from 'class-validator';
import { AppError } from './common/errors/app-error';

function flattenValidationError(e: ValidationError, parent = ''): { field: string; errors: string[] }[] {
  const field = parent ? `${parent}.${e.property}` : e.property;
  const own = e.constraints ? [{ field, errors: Object.values(e.constraints) }] : [];
  return [...own, ...(e.children ?? []).flatMap((c) => flattenValidationError(c, field))];
}

/** Shared HTTP configuration used by main.ts, OpenAPI generation and integration tests. */
export function configureApp(app: INestApplication): void {
  const cfg = app.get<AppConfig>(APP_CONFIG);
  const express = app as NestExpressApplication;

  if (cfg.trustProxy) express.set('trust proxy', 1);
  express.disable('x-powered-by');

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(compression());
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      // Native Android clients send no Origin header; browsers must match the allow-list exactly.
      if (!origin || cfg.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id', 'Accept-Language'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
      exceptionFactory: (errors) => {
        const details = errors.flatMap((e) => flattenValidationError(e));
        return AppError.badRequest('VALIDATION_FAILED', 'Request validation failed', details);
      },
    }),
  );
  app.enableShutdownHooks();
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Quiz Master API')
    .setDescription(
      [
        'REST API for the Bangladesh competitive examination preparation platform (BCS, bank, NTRCA, admission and more).',
        '',
        '**Clients:** Kotlin Android student app and Next.js administration dashboard.',
        '',
        '**Envelope:** every JSON response is `{ success, data, meta }`; errors are `{ success: false, error: { code, message, details }, meta }`.',
        'Clients should switch on `error.code` (stable) rather than `message` (human readable).',
        '',
        '**Route groups:** `/api/v1/public/*` (no auth), `/api/v1/*` (authenticated student), `/api/v1/admin/*` (staff with permissions).',
        '',
        '**Auth:** short-lived bearer access tokens + rotating opaque refresh tokens (`POST /auth/refresh`).',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addServer('/', 'Current host')
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey: string, methodKey: string) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}
