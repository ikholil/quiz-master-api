import { execSync } from 'node:child_process';

/** Applies migrations to the integration-test database once per run. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://quiz:quiz@localhost:5432/quiz_master_test?schema=public';
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
