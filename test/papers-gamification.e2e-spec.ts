import { loadQuestionBank } from '../prisma/question-bank/loader';
import { QuestionAnalyticsService } from '../src/modules/question-analytics/question-analytics.module';
import { ExamCalendarService } from '../src/modules/exam-calendar/exam-calendar.module';
import { QuestionImportProcessor } from '../src/modules/questions/question-import.processor';
import { FilesService } from '../src/modules/files/files.service';
import { QuestionsService } from '../src/modules/questions/questions.service';
import { RbacService } from '../src/modules/rbac/rbac.service';
import { TestContext, auth, createTestApp, resetDatabase, staffLogin, studentLogin } from './helpers';

describe('Question bank, past papers, item analysis, gamification and calendar (integration)', () => {
  let ctx: TestContext;
  let admin: { token: string; userId: string };
  let bcsId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx);
    admin = await staffLogin(ctx, 'owner@test.local', ['SUPER_ADMIN']);
    const res = await loadQuestionBank(ctx.prisma as never, { status: 'published' });
    expect(res.inserted).toBeGreaterThan(2500);
    bcsId = (await ctx.prisma.exam.findUniqueOrThrow({ where: { slug: 'bcs-demo' } })).id;
  }, 120000);
  afterAll(async () => ctx.app.close());

  describe('original question bank', () => {
    it('is idempotent and labelled as original (not official) content', async () => {
      const again = await loadQuestionBank(ctx.prisma as never, { status: 'published' });
      expect(again.inserted).toBe(0);
      const src = await ctx.prisma.questionSource.findFirstOrThrow({
        where: { title: 'Quiz Master original practice bank' },
      });
      expect(src).toMatchObject({ type: 'ORIGINAL', isOfficial: false });
      const pub = await ctx.http().get('/api/v1/public/questions?pageSize=5').expect(200);
      expect(pub.body.meta.pagination.total).toBeGreaterThan(2500);
      expect(pub.body.data.every((q: { sourceLabel: string | null }) => q.sourceLabel === null)).toBe(true);
    });

    it('serves a full-length 100-question practice mock with a difficulty mix', async () => {
      const s = await studentLogin(ctx);
      const mock = await ctx.prisma.mockExamTemplate.findUniqueOrThrow({
        where: { slug: 'bcs-demo-full-practice' },
      });
      const start = await ctx
        .http()
        .post(`/api/v1/mock-exams/${mock.id}/attempts`)
        .set(auth(s.token))
        .send({})
        .expect(201);
      expect(start.body.data.questions).toHaveLength(100);
      expect(new Set(start.body.data.questions.map((q: { questionId: string }) => q.questionId)).size).toBe(
        100,
      );
      expect(start.body.data.sections).toHaveLength(9);
      await ctx.http().post(`/api/v1/attempts/${start.body.data.id}/submit`).set(auth(s.token)).expect(200);
    });

    it('detects near-duplicates when authoring', async () => {
      const res = await ctx
        .http()
        .post('/api/v1/admin/question-quality/similar')
        .set(auth(admin.token))
        .send({ stem: 'What is the capital of Nepal?' })
        .expect(200);
      expect(res.body.data[0].score).toBeGreaterThan(0.9);
    });
  });

  describe('past-paper archive', () => {
    let paperId: string;

    it('imports a paper, links repeated questions instead of duplicating, and gates "official" behind verification', async () => {
      const paper = await ctx
        .http()
        .post('/api/v1/admin/previous-papers')
        .set(auth(admin.token))
        .send({
          examId: bcsId,
          year: 2020,
          title: 'Sample paper (test fixture)',
          durationMinutes: 30,
          totalMarks: 3,
          negativeMarking: 0.5,
        })
        .expect(201);
      paperId = paper.body.data.id;
      const csv = [
        'question_number,type,difficulty,subject,topic,stem,option_a,option_b,option_c,option_d,correct,explanation',
        '1,single_choice,easy,international-affairs,world/capitals,What is the capital of Nepal?,Kathmandu,Thimphu,Dhaka,Colombo,A,Kathmandu is the capital.',
        '2,single_choice,medium,mathematics,arithmetic/percentage,"Test fixture: what is 30% of 90?",27,30,24,33,A,90 × 0.3 = 27',
        ',single_choice,medium,mathematics,arithmetic/percentage,Missing number row,1,2,3,4,A,x',
      ].join('\n');
      const up = await ctx
        .http()
        .post('/api/v1/files')
        .set(auth(admin.token))
        .field('purpose', 'QUESTION_IMPORT')
        .attach('file', Buffer.from(csv), { filename: 'paper.csv', contentType: 'text/csv' })
        .expect(201);
      const job = await ctx
        .http()
        .post(`/api/v1/admin/previous-papers/${paperId}/import`)
        .set(auth(admin.token))
        .send({ fileId: up.body.data.id, format: 'csv', submitForReview: false })
        .expect(201);
      // Workers are disabled in tests; run the processor directly with the app's services.
      const processor = new QuestionImportProcessor(
        ctx.prisma,
        ctx.app.get(FilesService),
        ctx.app.get(QuestionsService),
        ctx.app.get(RbacService),
      );
      await processor.process({
        data: { jobId: job.body.data.id, submitForReview: false, paperId },
        updateProgress: async () => undefined,
      } as never);
      const status = await ctx
        .http()
        .get(`/api/v1/admin/questions/imports/${job.body.data.id}`)
        .set(auth(admin.token))
        .expect(200);
      expect(status.body.data).toMatchObject({ status: 'COMPLETED', importedRows: 2, failedRows: 1 });

      const detail = await ctx
        .http()
        .get(`/api/v1/admin/previous-papers/${paperId}`)
        .set(auth(admin.token))
        .expect(200);
      expect(detail.body.data.questions.map((q: { questionNumber: number }) => q.questionNumber)).toEqual([
        1, 2,
      ]);
      // Q1 is the bank's existing question, linked rather than duplicated.
      expect(detail.body.data.questions[0].question.code).toMatch(/^QM-/);

      // Publish the new question so the paper can be replayed.
      const newQ = detail.body.data.questions[1].questionId;
      await ctx.prisma.question.update({
        where: { id: newQ },
        data: {
          status: 'PUBLISHED',
          publishedVersionId: (await ctx.prisma.question.findUniqueOrThrow({ where: { id: newQ } }))
            .latestVersionId,
        },
      });

      const noEvidence = await ctx
        .http()
        .post(`/api/v1/admin/previous-papers/${paperId}/verify`)
        .set(auth(admin.token))
        .send({ status: 'VERIFIED', answerKeyType: 'OFFICIAL' })
        .expect(400);
      expect(noEvidence.body.error.code).toBe('EVIDENCE_REQUIRED');
      await ctx
        .http()
        .patch(`/api/v1/admin/previous-papers/${paperId}/details`)
        .set(auth(admin.token))
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const before = await ctx.http().get(`/api/v1/public/previous-papers/${paperId}`).expect(200);
      expect(before.body.data.verificationStatus).toBe('UNVERIFIED');
      expect(before.body.data.disclaimer).toMatch(/Not yet verified/);
      expect(JSON.stringify(before.body.data.questions)).not.toMatch(/isCorrect/);

      await ctx
        .http()
        .post(`/api/v1/admin/previous-papers/${paperId}/verify`)
        .set(auth(admin.token))
        .send({
          status: 'VERIFIED',
          answerKeyType: 'EXPERT',
          evidenceUrl: 'https://example.org/official-copy.pdf',
        })
        .expect(200);
      const after = await ctx.http().get(`/api/v1/public/previous-papers/${paperId}`).expect(200);
      expect(after.body.data.disclaimer).toMatch(/expert solutions, not an official key/);
      expect(after.body.data.questions[1].sourceLabel).toBe('Sample paper (test fixture) (2020)');
    });

    it('lets students practise the paper in order and replay it as a timed mock', async () => {
      const s = await studentLogin(ctx);
      const session = await ctx
        .http()
        .post('/api/v1/practice/sessions')
        .set(auth(s.token))
        .send({ mode: 'PAPER', paperId, questionCount: 5, instantFeedback: true })
        .expect(201);
      expect(session.body.data.questions).toHaveLength(2);
      expect(session.body.data.questions[1].stem).toContain('30% of 90');

      const replay = await ctx
        .http()
        .post(`/api/v1/admin/previous-papers/${paperId}/replay-mock`)
        .set(auth(admin.token))
        .expect(201);
      const att = await ctx
        .http()
        .post(`/api/v1/mock-exams/${replay.body.data.templateId}/attempts`)
        .set(auth(s.token))
        .send({})
        .expect(201);
      expect(att.body.data.questions.map((q: { stem: string }) => q.stem)).toEqual([
        'What is the capital of Nepal?',
        'Test fixture: what is 30% of 90?',
      ]);
      expect(att.body.data.durationMinutes).toBe(30);
    });

    it('computes topic frequency from verified papers and applies it to syllabus weights', async () => {
      const freq = await ctx.http().get(`/api/v1/public/exams/${bcsId}/topic-frequency`).expect(200);
      expect(freq.body.data.totalPapers).toBe(1);
      expect(freq.body.data.topics.map((t: { topicName: string }) => t.topicName).sort()).toEqual([
        'Capitals',
        'Percentage',
      ]);
      const version = await ctx.prisma.syllabusVersion.findFirstOrThrow({
        where: { examId: bcsId, isCurrent: true },
      });
      const res = await ctx
        .http()
        .post(`/api/v1/admin/syllabus-versions/${version.id}/weights-from-papers`)
        .set(auth(admin.token))
        .expect(200);
      expect(res.body.data.updated).toBe(2);
    });
  });

  describe('item analysis', () => {
    it('flags a question whose key looks wrong from real result patterns', async () => {
      const q = await ctx.prisma.question.findFirstOrThrow({
        where: { contentHash: { not: null } },
        include: { publishedVersion: { include: { options: true } } },
      });
      const tv = await ctx.prisma.mockExamTemplateVersion.findFirstOrThrow({ include: { sections: true } });
      const users = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          ctx.prisma.user.create({ data: { email: `ia${i}@t.local`, status: 'ACTIVE' } }),
        ),
      );
      for (const [i, u] of users.entries()) {
        const score = i / 40; // weak → strong
        const correct = i < 8; // only the weakest answer "correctly": classic wrong-key signature
        const a = await ctx.prisma.examAttempt.create({
          data: {
            userId: u.id,
            templateVersionId: tv.id,
            attemptNumber: 1,
            rulesSnapshot: {},
            seed: 's',
            status: 'EVALUATED',
            startedAt: new Date(Date.now() - 60000),
            expiresAt: new Date(),
            submittedAt: new Date(),
          },
        });
        await ctx.prisma.attemptAnswer.create({
          data: {
            attemptId: a.id,
            sectionId: tv.sections[0].id,
            questionId: q.id,
            questionVersionId: q.publishedVersionId!,
            position: 1,
            maxMarks: 1,
            isCorrect: correct,
            selectedOptionIds: [q.publishedVersion!.options[correct ? 0 : 1].id],
            evaluationStatus: 'AUTO_EVALUATED',
          },
        });
        await ctx.prisma.attemptResult.create({
          data: {
            attemptId: a.id,
            templateVersionId: tv.id,
            userId: u.id,
            status: 'FINAL',
            totalMarks: 100,
            obtainedMarks: Math.round(score * 100),
            correctCount: 0,
            wrongCount: 0,
            skippedCount: 0,
            accuracy: 0,
            sectionBreakdown: [],
            scoringVersion: 't',
            timeTakenSeconds: 60,
          },
        });
      }
      const r = await ctx.app.get(QuestionAnalyticsService).run();
      expect(r.analysed).toBeGreaterThanOrEqual(1);
      const flagged = await ctx
        .http()
        .get('/api/v1/admin/question-quality/flagged?flag=POSSIBLE_KEY_ERROR')
        .set(auth(admin.token))
        .expect(200);
      expect(flagged.body.data.map((x: { id: string }) => x.id)).toContain(q.id);
      const d = await ctx
        .http()
        .get(`/api/v1/admin/question-quality/questions/${q.id}/distractors`)
        .set(auth(admin.token))
        .expect(200);
      expect(d.body.data.options.reduce((n: number, o: { picks: number }) => n + o.picks, 0)).toBe(40);
    });
  });

  describe('gamification, bookmarks and calendar', () => {
    it('awards XP idempotently, tracks streaks and unlocks achievements', async () => {
      const s = await studentLogin(ctx);
      const session = await ctx
        .http()
        .post('/api/v1/practice/sessions')
        .set(auth(s.token))
        .send({ mode: 'EXAM', examId: bcsId, questionCount: 5 })
        .expect(201);
      for (const q of session.body.data.questions) {
        await ctx
          .http()
          .post(`/api/v1/practice/sessions/${session.body.data.id}/answers/${q.practiceAnswerId}`)
          .set(auth(s.token))
          .send({ selectedOptionIds: [q.options[0].id] })
          .expect(200);
      }
      const me = await ctx.http().get('/api/v1/gamification/me').set(auth(s.token)).expect(200);
      expect(me.body.data.questionsAnswered).toBe(5);
      expect(me.body.data.xp).toBeGreaterThanOrEqual(5);
      expect(me.body.data.currentStreak).toBe(1);
      expect(
        me.body.data.achievements.find((a: { key: string }) => a.key === 'FIRST_STEP').earnedAt,
      ).not.toBeNull();
      const xp = me.body.data.xp;
      // Re-awarding the same event does nothing.
      const { GamificationService } = await import('../src/modules/gamification/gamification.service');
      await ctx.app
        .get(GamificationService)
        .onPracticeAnswer(
          s.userId,
          (await ctx.prisma.practiceAnswer.findFirstOrThrow({ where: { sessionId: session.body.data.id } }))
            .id,
          true,
        );
      expect((await ctx.http().get('/api/v1/gamification/me').set(auth(s.token))).body.data.xp).toBe(xp);

      const board = await ctx
        .http()
        .get('/api/v1/leaderboards/xp?period=week')
        .set(auth(s.token))
        .expect(200);
      expect(board.body.data.me.rank).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(board.body.data)).not.toMatch(/\+880|@/);
    });

    it('serves one daily challenge for everyone and accepts a single answer', async () => {
      const a = await studentLogin(ctx);
      const b = await studentLogin(ctx);
      const ca = await ctx.http().get('/api/v1/gamification/daily-challenge').set(auth(a.token)).expect(200);
      const cb = await ctx.http().get('/api/v1/gamification/daily-challenge').set(auth(b.token)).expect(200);
      expect(ca.body.data.question.questionId).toBe(cb.body.data.question.questionId);
      expect(ca.body.data.answerKey).toBeNull();
      const ans = await ctx
        .http()
        .post('/api/v1/gamification/daily-challenge/answer')
        .set(auth(a.token))
        .send({ selectedOptionIds: [ca.body.data.question.options[0].id], timeSpentMs: 4000 })
        .expect(200);
      expect(ans.body.data.answerKey.correctOptionIds).toHaveLength(1);
      expect(ans.body.data.stats.participants).toBe(1);
      await ctx
        .http()
        .post('/api/v1/gamification/daily-challenge/answer')
        .set(auth(a.token))
        .send({ selectedOptionIds: [ca.body.data.question.options[0].id] })
        .expect(409);
    });

    it('bookmarks questions with notes and practises them', async () => {
      const s = await studentLogin(ctx);
      const qs = await ctx.http().get('/api/v1/public/questions?pageSize=6').expect(200);
      for (const q of qs.body.data)
        await ctx
          .http()
          .put(`/api/v1/questions/${q.questionId}/bookmark`)
          .set(auth(s.token))
          .send({ note: 'revise', folder: 'tricky' })
          .expect(200);
      const list = await ctx
        .http()
        .get('/api/v1/questions/bookmarks?folder=tricky')
        .set(auth(s.token))
        .expect(200);
      expect(list.body.meta.pagination.total).toBe(6);
      const session = await ctx
        .http()
        .post('/api/v1/practice/sessions')
        .set(auth(s.token))
        .send({ mode: 'BOOKMARKS', folder: 'tricky', questionCount: 10 })
        .expect(201);
      expect(session.body.data.questions).toHaveLength(6);
    });

    it('requires an official source to publish exam dates and shows countdowns to followers', async () => {
      const s = await studentLogin(ctx);
      await ctx.http().post(`/api/v1/exams/${bcsId}/bookmark`).set(auth(s.token)).expect(200);
      const ev = await ctx
        .http()
        .post(`/api/v1/admin/exams/${bcsId}/events`)
        .set(auth(admin.token))
        .send({
          type: 'APPLICATION_DEADLINE',
          title: 'Application deadline (test)',
          startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
        })
        .expect(201);
      const blocked = await ctx
        .http()
        .patch(`/api/v1/admin/exam-events/${ev.body.data.id}`)
        .set(auth(admin.token))
        .send({ status: 'PUBLISHED' })
        .expect(400);
      expect(blocked.body.error.code).toBe('SOURCE_REQUIRED');
      await ctx
        .http()
        .patch(`/api/v1/admin/exam-events/${ev.body.data.id}`)
        .set(auth(admin.token))
        .send({ status: 'PUBLISHED', sourceUrl: 'https://example.org/circular' })
        .expect(200);
      const cal = await ctx.http().get('/api/v1/exam-calendar').set(auth(s.token)).expect(200);
      expect(cal.body.data[0]).toMatchObject({ type: 'APPLICATION_DEADLINE', daysRemaining: 3 });
      expect(await ctx.app.get(ExamCalendarService).sendReminders()).toBeGreaterThanOrEqual(1);
      expect(await ctx.app.get(ExamCalendarService).sendReminders()).toBe(0);
    });
  });
});
