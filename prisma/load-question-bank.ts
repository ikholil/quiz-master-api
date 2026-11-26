/**
 * Loads the original practice question bank.
 *
 *   npm run bank:load                     # questions go to the review queue (production default)
 *   npm run bank:load -- --published      # publish immediately + create practice mocks (dev/staging)
 *
 * Idempotent: questions are keyed by a content hash, so re-running only adds what is missing.
 */
import { PrismaClient } from '@prisma/client';
import { loadQuestionBank } from './question-bank/loader';

const prisma = new PrismaClient();
const published = process.argv.includes('--published');

loadQuestionBank(prisma, {
  status: published ? 'published' : 'review',
  withMocks: !process.argv.includes('--no-mocks'),
  log: (m) => console.log(m),
})
  .then((r) => console.log(JSON.stringify(r)))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
