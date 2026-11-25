import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { buildOpenApi, configureApp } from './bootstrap';
import { APP_CONFIG, AppConfig } from './config/configuration';
import { markShuttingDown } from './modules/health/health.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  const cfg = app.get<AppConfig>(APP_CONFIG);
  configureApp(app);

  if (cfg.env !== 'production' || process.env.SWAGGER_ENABLED === 'true') {
    SwaggerModule.setup('api/docs', app, buildOpenApi(app), { jsonDocumentUrl: 'api/docs-json' });
  }

  // Graceful shutdown: fail readiness first so the load balancer drains traffic, then close.
  const shutdown = (signal: string) => {
    markShuttingDown();
    NestLogger.log(`${signal} received, draining…`, 'Bootstrap');
    setTimeout(() => {
      app
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    }, Number(process.env.SHUTDOWN_DRAIN_MS ?? 5000));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await app.listen(cfg.port, '0.0.0.0');
  NestLogger.log(`API listening on :${cfg.port} (${cfg.env})`, 'Bootstrap');
}

void bootstrap();
