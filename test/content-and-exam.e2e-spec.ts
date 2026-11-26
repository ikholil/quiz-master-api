import { TestContext, auth, createTestApp, resetDatabase, seedPublishedBank, staffLogin, studentLogin } from './helpers';
import { AttemptsService } from '../src/modules/attempts/attempts.service';

describe('Question bank workflow & examination engine (integration)', () => {
  let ctx: TestContext;
  let admin: { token: string; userId: string };
  let editor: { token: string; userId: string };
  let reviewer: { token: string; userId: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx);
    admin = await staffLogin(ctx, 'admin@test.local', ['ADMIN']);
    editor = await staffLogin(ctx, 'editor@test.local', ['CONTENT_EDITOR']);
    reviewer = await staffLogin(ctx, 'reviewer@test.local', ['CONTENT_REVIEWER']);
  });
  afterAll(async () => ctx.app.close());

  describe('examination catalog', () => {
    it('lets admins define a new exam type purely through data', async () => {
      const cat = await ctx.http().post('/api/v1/admin/exam-categories').set(auth(admin.token)).send({ slug: 'nursing', name: 'Nursing recruitment' }).expect(201);
      const exam = await ctx.http().post('/api/v1/admin/exams').set(auth(admin.token)).send({ slug: 'nursing-officer', name: 'Senior staff nurse', categoryId: cat.body.data.id, eligibility: { minAge: 18 } }).expect(201);
      const blocked = await ctx.http().patch(`/api/v1/admin/exams/${exam.body.data.id}`).set(auth(admin.token)).send({ status: 'PUBLISHED' }).expect(400);
      expect(blocked.body.error.code).toBe('EXAM_INCOMPLETE');
      await ctx.http().put(`/api/v1/admin/exams/${exam.body.data.id}/stages`).set(auth(admin.token)).send({ name: 'MCQ', sequence: 1, totalMarks: 100, durationMinutes: 90, negativeMarking: 0.25 }).expect(200);
      await ctx.http().patch(`/api/v1/admin/exams/${exam.body.data.id}`).set(auth(admin.token)).send({ status: 'PUBLISHED' }).expect(200);
      const pub = await ctx.http().get('/api/v1/public/exams/nursing-officer').expect(200);
      expect(pub.body.data.stages[0]).toMatchObject({ name: 'MCQ', totalMarks: 100, negativeMarking: 0.25 });
    });
  });

  describe('content approval', () => {
    let subjectId: string;
    let questionId: string;

    beforeAll(async () => {
      const s = await ctx.http().post('/api/v1/admin/subjects').set(auth(admin.token)).send({ slug: 'science', name: 'General science' }).expect(201);
      subjectId = s.body.data.id;
    });

    it('rejects invalid question content', async () => {
      const res = await ctx.http().post('/api/v1/admin/questions').set(auth(editor.token)).send({
        type: 'SINGLE_CHOICE',
        subjectId,
        content: { stem: 'Two correct?', options: [{ key: 'A', text: 'x', isCorrect: true }, { key: 'B', text: 'y', isCorrect: true }] },
      }).expect(422);
      expect(res.body.error.code).toBe('INVALID_QUESTION_CONTENT');
    });

    it('moves a question from draft to published with a distinct reviewer', async () => {
      const created = await ctx.http().post('/api/v1/admin/questions').set(auth(editor.token)).send({
        type: 'SINGLE_CHOICE',
        subjectId,
        tags: ['physics'],
        content: { stem: 'Water boils at sea level at?', options: [{ key: 'A', text: '100 °C', isCorrect: true }, { key: 'B', text: '50 °C', isCorrect: false }], explanation: { content: 'At 1 atm water boils at 100 °C.' } },
      }).expect(201);
      questionId = created.body.data.id;
      expect(created.body.data.status).toBe('DRAFT');

      // Unpublished questions are invisible to students.
      await ctx.http().get(`/api/v1/public/questions/${questionId}`).expect(404);

      const cannotPublish = await ctx.http().post(`/api/v1/admin/questions/${questionId}/publish`).set(auth(reviewer.token)).expect(409);
      expect(cannotPublish.body.error.code).toBe('NOT_APPROVED');

      await ctx.http().post(`/api/v1/admin/questions/${questionId}/submit`).set(auth(editor.token)).expect(200);
      // Editors lack review permission entirely.
      await ctx.http().post(`/api/v1/admin/questions/${questionId}/review`).set(auth(editor.token)).send({ decision: 'APPROVED' }).expect(403);
      await ctx.http().post(`/api/v1/admin/questions/${questionId}/review`).set(auth(reviewer.token)).send({ decision: 'APPROVED', comments: 'ok' }).expect(200);
      const published = await ctx.http().post(`/api/v1/admin/questions/${questionId}/publish`).set(auth(reviewer.token)).expect(200);
      expect(published.body.data.status).toBe('PUBLISHED');

      const pub = await ctx.http().get(`/api/v1/public/questions/${questionId}`).expect(200);
      expect(JSON.stringify(pub.body)).not.toMatch(/isCorrect|explanation|Because|1 atm/);
    });

    it('blocks self-review (four-eyes principle)', async () => {
      const both = await staffLogin(ctx, 'both@test.local', ['CONTENT_EDITOR', 'CONTENT_REVIEWER']);
      const q = await ctx.http().post('/api/v1/admin/questions').set(auth(both.token)).send({
        type: 'TRUE_FALSE',
        subjectId,
        content: { stem: 'The sun is a star.', options: [{ key: 'A', text: 'True', isCorrect: true }, { key: 'B', text: 'False', isCorrect: false }] },
      }).expect(201);
      await ctx.http().post(`/api/v1/admin/questions/${q.body.data.id}/submit`).set(auth(both.token)).expect(200);
      const res = await ctx.http().post(`/api/v1/admin/questions/${q.body.data.id}/review`).set(auth(both.token)).send({ decision: 'APPROVED' }).expect(403);
      expect(res.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
    });

    it('creates a new version when a published question is corrected, keeping the published one live', async () => {
      await ctx.http().patch(`/api/v1/admin/questions/${questionId}`).set(auth(editor.token)).send({
        content: { stem: 'Water boils at sea level at (corrected)?', options: [{ key: 'A', text: '100 °C', isCorrect: true }, { key: 'B', text: '90 °C', isCorrect: false }] },
        changeNote: 'Improve distractor',
      }).expect(200);
      const versions = await ctx.http().get(`/api/v1/admin/questions/${questionId}/versions`).set(auth(editor.token)).expect(200);
      expect(versions.body.data.map((v: { versionNumber: number; status: string }) => [v.versionNumber, v.status])).toEqual([
        [2, 'DRAFT'],
        [1, 'PUBLISHED'],
      ]);
      const pub = await ctx.http().get(`/api/v1/public/questions/${questionId}`).expect(200);
      expect(pub.body.data.stem).toBe('Water boils at sea level at?');
    });
  });

  describe('mock examination engine', () => {
    let bank: Awaited<ReturnType<typeof seedPublishedBank>>;
    let templateId: string;

    beforeAll(async () => {
      bank = await seedPublishedBank(ctx, 12);
      const t = await ctx.http().post('/api/v1/admin/mock-exams').set(auth(editor.token)).send({
        slug: 'engine-test',
        title: 'Engine test mock',
        examId: bank.exam.id,
        config: {
          durationMinutes: 30,
          passMarks: 5,
          shuffleQuestions: true,
          shuffleOptions: true,
          sections: [{ title: 'Main', subjectId: bank.subject.id, selectionMode: 'RANDOM', questionCount: 10, marksPerQuestion: 1, negativeMarks: 0.25 }],
        },
      }).expect(201);
      templateId = t.body.data.id;
      await ctx.http().post(`/api/v1/admin/mock-exams/${templateId}/publish`).set(auth(editor.token)).expect(200);
    });

    it('refuses to publish when the pool is too small', async () => {
      const t = await ctx.http().post('/api/v1/admin/mock-exams').set(auth(editor.token)).send({
        slug: 'too-big',
        title: 'Too big',
        examId: bank.exam.id,
        config: { durationMinutes: 10, sections: [{ title: 'X', subjectId: bank.subject.id, selectionMode: 'RANDOM', questionCount: 50, marksPerQuestion: 1, negativeMarks: 0 }] },
      }).expect(201);
      const res = await ctx.http().post(`/api/v1/admin/mock-exams/${t.body.data.id}/publish`).set(auth(editor.token)).expect(422);
      expect(res.body.error.code).toBe('MOCK_NOT_PUBLISHABLE');
    });

    it('runs a full attempt: hidden answers, server timing, negative marking, idempotent submission', async () => {
      const s = await studentLogin(ctx);
      const start = await ctx.http().post(`/api/v1/mock-exams/${templateId}/attempts`).set(auth(s.token)).send({ platform: 'ANDROID' }).expect(201);
      const attempt = start.body.data;
      expect(attempt.questions).toHaveLength(10);
      expect(attempt.remainingSeconds).toBeGreaterThan(1700);
      expect(new Date(attempt.expiresAt).getTime() - new Date(attempt.startedAt).getTime()).toBe(30 * 60_000);
      expect(JSON.stringify(attempt)).not.toMatch(/isCorrect|correctOptionIds|explanation|Because A/);

      // Starting again resumes the same attempt.
      const again = await ctx.http().post(`/api/v1/mock-exams/${templateId}/attempts`).set(auth(s.token)).send({}).expect(201);
      expect(again.body.data.id).toBe(attempt.id);

      // Answer 6 correctly, 3 wrongly, skip 1  → 6 − 0.75 = 5.25
      const byQ = new Map(bank.questions.map((q) => [q.id, q]));
      const answers = attempt.questions.slice(0, 9).map((q: { answerId: string; questionId: string }, i: number) => ({
        answerId: q.answerId,
        selectedOptionIds: [i < 6 ? byQ.get(q.questionId)!.correctOptionId : byQ.get(q.questionId)!.wrongOptionId],
        timeSpentMs: 15000,
      }));
      await ctx.http().put(`/api/v1/attempts/${attempt.id}/answers`).set(auth(s.token)).send({ answers }).expect(200);

      // Invalid option ids / foreign answers are rejected.
      const foreign = await ctx.http().put(`/api/v1/attempts/${attempt.id}/answers/${attempt.questions[9].answerId}`).set(auth(s.token)).send({ selectedOptionIds: [bank.questions[0].correctOptionId] });
      if (attempt.questions[9].questionId !== bank.questions[0].id) expect(foreign.status).toBe(400);
      await ctx.http().put(`/api/v1/attempts/${attempt.id}/answers/${attempt.questions[9].answerId}`).set(auth(s.token)).send({ selectedOptionIds: [] }).expect(200);

      // Another student cannot touch this attempt.
      const other = await studentLogin(ctx);
      await ctx.http().get(`/api/v1/attempts/${attempt.id}`).set(auth(other.token)).expect(404);
      await ctx.http().get(`/api/v1/attempts/${attempt.id}/review`).set(auth(s.token)).expect(403);

      // Concurrent double submit → one evaluation.
      const [r1, r2] = await Promise.all([
        ctx.http().post(`/api/v1/attempts/${attempt.id}/submit`).set(auth(s.token)).set('Idempotency-Key', 'submit-key-0001'),
        ctx.http().post(`/api/v1/attempts/${attempt.id}/submit`).set(auth(s.token)).set('Idempotency-Key', 'submit-key-0001'),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(r1.body.data).toMatchObject({ obtainedMarks: 5.25, totalMarks: 10, correctCount: 6, wrongCount: 3, skippedCount: 1, passed: true, status: 'FINAL' });
      expect(r2.body.data.obtainedMarks).toBe(5.25);
      expect(await ctx.prisma.attemptResult.count({ where: { attemptId: attempt.id } })).toBe(1);

      // Answers are frozen after submission.
      const late = await ctx.http().put(`/api/v1/attempts/${attempt.id}/answers/${attempt.questions[9].answerId}`).set(auth(s.token)).send({ selectedOptionIds: [] }).expect(409);
      expect(late.body.error.code).toBe('ATTEMPT_NOT_IN_PROGRESS');

      // Review now includes the answer key and explanations.
      const review = await ctx.http().get(`/api/v1/attempts/${attempt.id}/review`).set(auth(s.token)).expect(200);
      expect(review.body.data[0].correctOptionIds).toHaveLength(1);
      expect(review.body.data[0].explanation).toMatch(/Because A/);
    });

    it('preserves original rules and question versions after later edits (no silent rescoring)', async () => {
      const s = await studentLogin(ctx);
      const start = await ctx.http().post(`/api/v1/mock-exams/${templateId}/attempts`).set(auth(s.token)).send({}).expect(201);
      const att = start.body.data;
      const first = att.questions[0];
      const correct = bank.questions.find((q) => q.id === first.questionId)!;
      await ctx.http().put(`/api/v1/attempts/${att.id}/answers/${first.answerId}`).set(auth(s.token)).send({ selectedOptionIds: [correct.correctOptionId] }).expect(200);

      // Admin changes the template (heavier negative marking) and republishes.
      await ctx.http().patch(`/api/v1/admin/mock-exams/${templateId}`).set(auth(editor.token)).send({
        config: { durationMinutes: 5, sections: [{ title: 'Main', subjectId: bank.subject.id, selectionMode: 'RANDOM', questionCount: 10, marksPerQuestion: 2, negativeMarks: 1 }] },
      }).expect(200);
      await ctx.http().post(`/api/v1/admin/mock-exams/${templateId}/publish`).set(auth(editor.token)).expect(200);

      // The correct answer key of that question is "changed" by publishing a new version where B is correct.
      const v = await ctx.prisma.questionVersion.findUniqueOrThrow({ where: { id: correct.versionId }, include: { options: true } });
      const v2 = await ctx.prisma.questionVersion.create({
        data: { questionId: correct.id, versionNumber: 2, stem: v.stem, status: 'PUBLISHED', options: { create: v.options.map((o, i) => ({ key: o.key, text: o.text, isCorrect: i === 1, sortOrder: i })) } },
      });
      await ctx.prisma.question.update({ where: { id: correct.id }, data: { publishedVersionId: v2.id, latestVersionId: v2.id } });

      const res = await ctx.http().post(`/api/v1/attempts/${att.id}/submit`).set(auth(s.token)).expect(200);
      expect(res.body.data).toMatchObject({ totalMarks: 10, obtainedMarks: 1, correctCount: 1 });
      const stored = await ctx.prisma.examAttempt.findUniqueOrThrow({ where: { id: att.id } });
      expect((stored.rulesSnapshot as { durationMinutes: number }).durationMinutes).toBe(30);
    });

    it('auto-submits expired attempts using server time and ignores late answers', async () => {
      const s = await studentLogin(ctx);
      const start = await ctx.http().post(`/api/v1/mock-exams/${templateId}/attempts`).set(auth(s.token)).send({}).expect(201);
      const id = start.body.data.id;
      // Simulate the deadline passing (beyond the grace period).
      await ctx.prisma.$executeRaw`UPDATE exam_attempts SET "startedAt" = now() - interval '2 hours', "expiresAt" = now() - interval '1 hour' WHERE id = ${id}::uuid`;
      const late = await ctx.http().put(`/api/v1/attempts/${id}/answers/${start.body.data.questions[0].answerId}`).set(auth(s.token)).send({ selectedOptionIds: [] }).expect(409);
      expect(late.body.error.code).toBe('ATTEMPT_EXPIRED');
      const row = await ctx.prisma.examAttempt.findUniqueOrThrow({ where: { id }, include: { result: true } });
      expect(row.status).toBe('EVALUATED');
      expect(row.result?.obtainedMarks.toNumber()).toBe(0);
      // A second finalize (e.g. the delayed job firing later) is a no-op.
      expect(await ctx.app.get(AttemptsService).finalize(id, true)).toBe(false);
    });
  });

  describe('manual evaluation of written answers', () => {
    it('keeps results provisional until evaluated and rejects impossible marks', async () => {
      const bank = await seedPublishedBank(ctx, 2, { type: 'WRITTEN' });
      await ctx.prisma.questionOption.deleteMany({ where: { versionId: { in: bank.questions.map((q) => q.versionId) } } });
      const t = await ctx.http().post('/api/v1/admin/mock-exams').set(auth(editor.token)).send({
        slug: 'written-test',
        title: 'Written',
        examId: bank.exam.id,
        config: { durationMinutes: 60, sections: [{ title: 'Essay', subjectId: bank.subject.id, questionTypes: ['WRITTEN'], selectionMode: 'RANDOM', questionCount: 2, marksPerQuestion: 10, negativeMarks: 0 }] },
      }).expect(201);
      await ctx.http().post(`/api/v1/admin/mock-exams/${t.body.data.id}/publish`).set(auth(editor.token)).expect(200);

      const s = await studentLogin(ctx);
      const start = await ctx.http().post(`/api/v1/mock-exams/${t.body.data.id}/attempts`).set(auth(s.token)).send({}).expect(201);
      for (const q of start.body.data.questions) {
        await ctx.http().put(`/api/v1/attempts/${start.body.data.id}/answers/${q.answerId}`).set(auth(s.token)).send({ textAnswer: 'My essay answer' }).expect(200);
      }
      const submitted = await ctx.http().post(`/api/v1/attempts/${start.body.data.id}/submit`).set(auth(s.token)).expect(200);
      expect(submitted.body.data).toMatchObject({ status: 'PROVISIONAL', pendingCount: 2, passed: null });

      const queue = await ctx.http().get('/api/v1/admin/evaluations').set(auth(reviewer.token)).expect(200);
      expect(queue.body.data).toHaveLength(2);
      expect(JSON.stringify(queue.body.data)).not.toContain(s.userId);

      const bad = await ctx.http().put(`/api/v1/admin/evaluations/${queue.body.data[0].answerId}`).set(auth(reviewer.token)).send({ awardedMarks: 11 }).expect(422);
      expect(bad.body.error.code).toBe('IMPOSSIBLE_MARKS');
      await ctx.http().put(`/api/v1/admin/evaluations/${queue.body.data[0].answerId}`).set(auth(reviewer.token)).send({ awardedMarks: 7.5 }).expect(200);
      await ctx.http().put(`/api/v1/admin/evaluations/${queue.body.data[1].answerId}`).set(auth(reviewer.token)).send({ awardedMarks: 6, comment: 'Good' }).expect(200);

      const result = await ctx.http().get(`/api/v1/attempts/${start.body.data.id}/result`).set(auth(s.token)).expect(200);
      expect(result.body.data).toMatchObject({ status: 'FINAL', obtainedMarks: 13.5, totalMarks: 20, pendingCount: 0 });
    });
  });
});
