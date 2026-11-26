/**
 * Writes openapi/openapi.json — the API contract consumed by the Kotlin Android and Next.js clients
 * (e.g. openapi-generator `kotlin` / `typescript-fetch`, or openapi-typescript).
 * Run with `npm run openapi:generate` (requires the compiled build so Swagger CLI-plugin metadata is present).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  process.env.WORKERS_ENABLED = 'false';
  process.env.SCHEDULERS_ENABLED = 'false';
  // Connections are not needed to build the document; failures to connect are tolerated.
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/openapi';
  const { AppModule } = await import('../src/app.module');
  const { buildOpenApi, configureApp } = await import('../src/bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false });
  configureApp(app);
  const doc = buildOpenApi(app);
  const out = resolve(process.cwd(), 'openapi');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'openapi.json'), JSON.stringify(doc, null, 2) + '\n');
  const ops = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`Wrote openapi/openapi.json (${Object.keys(doc.paths).length} paths, ${ops} operations)`);
  await app.close().catch(() => undefined);
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
