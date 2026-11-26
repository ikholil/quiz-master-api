import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ContentStatus, Difficulty, Prisma, QuestionType, UserStatus } from '@prisma/client';
import type Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { hashPassword } from '../src/common/utils/crypto.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS } from '../src/redis/redis.module';
import { RbacService } from '../src/modules/rbac/rbac.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const redis = app.get<Redis>(REDIS);
  return { app, prisma, redis, http: () => request(app.getHttpServer()) };
}

export async function resetDatabase(ctx: TestContext): Promise<void> {
  const tables = await ctx.prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await ctx.prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await ctx.redis.flushdb();
  await ctx.app.get(RbacService).syncSystemRoles();
}

let phoneSeq = 10_000_000;
export function nextPhone(): string {
  phoneSeq += 1;
  return `0171${String(phoneSeq).slice(-7)}`;
}

/** Signs up/in a student through the real OTP flow (dev OTP is exposed in test env). */
export async function studentLogin(ctx: TestContext, phone = nextPhone()) {
  const req = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: phone, purpose: 'LOGIN' }).expect(200);
  const code = req.body.data.devCode as string;
  const res = await ctx.http().post('/api/v1/auth/otp/verify').send({ identifier: phone, code, platform: 'ANDROID' }).expect(200);
  return { token: res.body.data.accessToken as string, refreshToken: res.body.data.refreshToken as string, userId: res.body.data.user.id as string, phone };
}

/** Creates a staff account with the given roles and signs in to the admin dashboard with a password. */
export async function staffLogin(ctx: TestContext, email: string, roles: string[]) {
  const password = 'StaffPass123';
  const user = await ctx.prisma.user.create({
    data: { email, emailVerifiedAt: new Date(), passwordHash: await hashPassword(password), status: UserStatus.ACTIVE, profile: { create: { fullName: email } } },
  });
  for (const key of roles) {
    const role = await ctx.prisma.role.findUniqueOrThrow({ where: { key } });
    await ctx.prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const res = await ctx.http().post('/api/v1/auth/login').send({ identifier: email, password, platform: 'ADMIN_WEB' }).expect(200);
  return { token: res.body.data.accessToken as string, userId: user.id };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Directly inserts a published exam with subject/topic and N published single-choice questions (A correct). */
export async function seedPublishedBank(ctx: TestContext, n: number, opts: { type?: QuestionType } = {}) {
  const p = ctx.prisma;
  const suffix = Math.random().toString(36).slice(2, 8);
  const category = await p.examCategory.create({ data: { slug: `cat-${suffix}`, name: 'Cat' } });
  const exam = await p.exam.create({ data: { slug: `exam-${suffix}`, name: 'Exam', categoryId: category.id, status: 'PUBLISHED' } });
  const subject = await p.subject.create({ data: { slug: `subj-${suffix}`, name: 'Subject' } });
  const chapter = await p.chapter.create({ data: { subjectId: subject.id, slug: 'ch', name: 'Chapter' } });
  const topic = await p.topic.create({ data: { chapterId: chapter.id, slug: 'tp', name: 'Topic' } });
  const syllabus = await p.syllabusVersion.create({ data: { examId: exam.id, label: 'v1', status: 'PUBLISHED', isCurrent: true } });
  await p.examTopicMapping.create({ data: { examId: exam.id, syllabusVersionId: syllabus.id, topicId: topic.id, weight: new Prisma.Decimal(0.8) } });
  const questions: Array<{ id: string; versionId: string; correctOptionId: string; wrongOptionId: string }> = [];
  for (let i = 0; i < n; i++) {
    const q = await p.question.create({
      data: { code: `T-${suffix}-${i}`, type: opts.type ?? QuestionType.SINGLE_CHOICE, difficulty: Difficulty.MEDIUM, subjectId: subject.id, topicId: topic.id, status: ContentStatus.PUBLISHED, isDemo: true },
    });
    const v = await p.questionVersion.create({
      data: {
        questionId: q.id,
        versionNumber: 1,
        stem: `Question ${i}`,
        status: ContentStatus.PUBLISHED,
        options: { create: ['A', 'B', 'C', 'D'].map((key, j) => ({ key, text: `Opt ${key}`, isCorrect: j === 0, sortOrder: j })) },
        explanation: { create: { content: `Because A (${i})` } },
      },
      include: { options: true },
    });
    await p.question.update({ where: { id: q.id }, data: { latestVersionId: v.id, publishedVersionId: v.id } });
    await p.examQuestionMapping.create({ data: { examId: exam.id, questionId: q.id } });
    questions.push({ id: q.id, versionId: v.id, correctOptionId: v.options.find((o) => o.isCorrect)!.id, wrongOptionId: v.options.find((o) => !o.isCorrect)!.id });
  }
  return { exam, subject, topic, questions };
}
