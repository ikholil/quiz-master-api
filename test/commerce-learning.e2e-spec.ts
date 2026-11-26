import { hmacSha256 } from '../src/common/utils/crypto.util';
import { AssistantService } from '../src/modules/ai/assistant.service';
import { KnowledgeService } from '../src/modules/knowledge/knowledge.service';
import { LearningService } from '../src/modules/learning/learning.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import { TestContext, auth, createTestApp, resetDatabase, seedPublishedBank, staffLogin, studentLogin } from './helpers';

const SECRET = 'test-sandbox-secret';

function signed(body: object) {
  const raw = JSON.stringify(body);
  return { raw, sig: hmacSha256(SECRET, raw) };
}

describe('Payments, entitlements, adaptive learning and AI (integration)', () => {
  let ctx: TestContext;
  let admin: { token: string; userId: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx);
    admin = await staffLogin(ctx, 'finance@test.local', ['SUPER_ADMIN']);
  });
  afterAll(async () => ctx.app.close());

  describe('subscriptions & payments', () => {
    let planId: string;
    let premiumMockId: string;

    beforeAll(async () => {
      const plan = await ctx.http().post('/api/v1/admin/plans').set(auth(admin.token)).send({
        code: 'premium-test',
        name: 'Premium',
        priceMinor: 29900,
        durationDays: 30,
        features: [{ featureKey: 'mock.premium' }, { featureKey: 'ai.assistant', limitValue: 50 }],
      }).expect(201);
      planId = plan.body.data.id;
      const bank = await seedPublishedBank(ctx, 5);
      const t = await ctx.http().post('/api/v1/admin/mock-exams').set(auth(admin.token)).send({
        slug: 'premium-mock',
        title: 'Premium mock',
        examId: bank.exam.id,
        accessLevel: 'PREMIUM',
        config: { durationMinutes: 10, sections: [{ title: 'S', subjectId: bank.subject.id, selectionMode: 'RANDOM', questionCount: 5, marksPerQuestion: 1, negativeMarks: 0 }] },
      }).expect(201);
      premiumMockId = t.body.data.id;
      await ctx.http().post(`/api/v1/admin/mock-exams/${premiumMockId}/publish`).set(auth(admin.token)).expect(200);
    });

    it('validates entitlements on the backend, grants them only after a verified payment, and is webhook-idempotent', async () => {
      const s = await studentLogin(ctx);
      const denied = await ctx.http().post(`/api/v1/mock-exams/${premiumMockId}/attempts`).set(auth(s.token)).send({}).expect(402);
      expect(denied.body.error).toMatchObject({ code: 'ENTITLEMENT_REQUIRED', details: { feature: 'mock.premium' } });

      // The client cannot choose the price.
      const pay = await ctx.http().post('/api/v1/payments').set(auth(s.token)).set('Idempotency-Key', 'pay-key-000001').send({ purpose: 'SUBSCRIPTION', referenceId: planId }).expect(201);
      expect(pay.body.data).toMatchObject({ status: 'PENDING', amountMinor: 29900, provider: 'sandbox' });
      const again = await ctx.http().post('/api/v1/payments').set(auth(s.token)).set('Idempotency-Key', 'pay-key-000001').send({ purpose: 'SUBSCRIPTION', referenceId: planId }).expect(201);
      expect(again.body.data.id).toBe(pay.body.data.id);

      const event = { eventId: 'evt-1', merchantTxnId: pay.body.data.merchantTxnId, status: 'SUCCEEDED', amountMinor: 29900 };
      const { raw, sig } = signed(event);

      // Forged signature: rejected, no state change.
      await ctx.http().post('/api/v1/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', '00'.repeat(32)).send(raw).expect(401);
      expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: pay.body.data.id } })).status).toBe('PENDING');

      const ok = await ctx.http().post('/api/v1/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', sig).send(raw).expect(200);
      expect(ok.body.data).toEqual({ received: true, duplicate: false });
      const dup = await ctx.http().post('/api/v1/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', sig).send(raw).expect(200);
      expect(dup.body.data.duplicate).toBe(true);

      // Worker step (queued job) — run it twice concurrently: exactly one fulfilment.
      const payments = ctx.app.get(PaymentsService);
      await Promise.all([payments.confirm(pay.body.data.id, 'webhook'), payments.confirm(pay.body.data.id, 'client')]);
      expect(await ctx.prisma.userSubscription.count({ where: { userId: s.userId } })).toBe(1);
      expect(await ctx.prisma.entitlement.count({ where: { userId: s.userId } })).toBe(2);

      const ents = await ctx.http().get('/api/v1/subscriptions/me/entitlements').set(auth(s.token)).expect(200);
      expect(ents.body.data.map((e: { featureKey: string }) => e.featureKey).sort()).toEqual(['ai.assistant', 'mock.premium']);
      await ctx.http().post(`/api/v1/mock-exams/${premiumMockId}/attempts`).set(auth(s.token)).send({}).expect(201);

      // Renewal extends from the current end date.
      const renew = await ctx.http().post('/api/v1/payments').set(auth(s.token)).send({ purpose: 'SUBSCRIPTION', referenceId: planId }).expect(201);
      const ev2 = signed({ eventId: 'evt-2', merchantTxnId: renew.body.data.merchantTxnId, status: 'SUCCEEDED', amountMinor: 29900 });
      await ctx.http().post('/api/v1/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', ev2.sig).send(ev2.raw).expect(200);
      await payments.confirm(renew.body.data.id, 'webhook');
      const subs = await ctx.prisma.userSubscription.findMany({ where: { userId: s.userId }, orderBy: { startsAt: 'asc' } });
      expect(subs[1].startsAt!.getTime()).toBe(subs[0].endsAt!.getTime());

      // Full refund revokes access.
      await ctx.http().post(`/api/v1/admin/payments/${renew.body.data.id}/refunds`).set(auth(admin.token)).send({ reason: 'Customer request' }).expect(201);
      const refunded = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: renew.body.data.id } });
      expect(refunded).toMatchObject({ status: 'REFUNDED', refundedMinor: 29900 });
      const tooMuch = await ctx.http().post(`/api/v1/admin/payments/${renew.body.data.id}/refunds`).set(auth(admin.token)).send({ reason: 'again' }).expect(409);
      expect(tooMuch.body.error.code).toBe('NOT_REFUNDABLE');
    });

    it('fails a payment whose verified amount does not match', async () => {
      const s = await studentLogin(ctx);
      const pay = await ctx.http().post('/api/v1/payments').set(auth(s.token)).send({ purpose: 'SUBSCRIPTION', referenceId: planId }).expect(201);
      const ev = signed({ eventId: 'evt-x', merchantTxnId: pay.body.data.merchantTxnId, status: 'SUCCEEDED', amountMinor: 100 });
      await ctx.http().post('/api/v1/payments/webhooks/sandbox').set('content-type', 'application/json').set('x-sandbox-signature', ev.sig).send(ev.raw).expect(200);
      const p = await ctx.app.get(PaymentsService).confirm(pay.body.data.id, 'webhook');
      expect(p).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
      expect(await ctx.prisma.entitlement.count({ where: { userId: s.userId } })).toBe(0);
    });

    it('expires subscriptions and revokes their entitlements', async () => {
      const subsService = ctx.app.get(SubscriptionsService);
      await ctx.prisma.userSubscription.updateMany({ where: { status: 'ACTIVE' }, data: { endsAt: new Date(Date.now() - 1000) } });
      expect(await subsService.expireDue()).toBeGreaterThan(0);
      expect(await ctx.prisma.entitlement.count({ where: { revokedAt: null, source: 'SUBSCRIPTION' } })).toBe(0);
    });
  });

  describe('practice, mastery and study plans', () => {
    it('updates mastery from practice, recommends weak topics and builds an explainable daily plan', async () => {
      const bank = await seedPublishedBank(ctx, 15);
      const s = await studentLogin(ctx);
      const session = await ctx.http().post('/api/v1/practice/sessions').set(auth(s.token)).send({ mode: 'EXAM', examId: bank.exam.id, questionCount: 10 }).expect(201);
      expect(JSON.stringify(session.body.data.questions)).not.toMatch(/isCorrect":true|Because/);
      const byQ = new Map(bank.questions.map((q) => [q.id, q]));
      for (const [i, q] of session.body.data.questions.entries()) {
        const option = i < 3 ? byQ.get(q.questionId)!.correctOptionId : byQ.get(q.questionId)!.wrongOptionId;
        const res = await ctx.http().post(`/api/v1/practice/sessions/${session.body.data.id}/answers/${q.practiceAnswerId}`).set(auth(s.token)).send({ selectedOptionIds: [option], timeSpentMs: 20000 }).expect(200);
        expect(res.body.data.isCorrect).toBe(i < 3);
        expect(res.body.data.answerKey.correctOptionIds).toEqual([byQ.get(q.questionId)!.correctOptionId]);
      }
      const dup = await ctx.http().post(`/api/v1/practice/sessions/${session.body.data.id}/answers/${session.body.data.questions[0].practiceAnswerId}`).set(auth(s.token)).send({ selectedOptionIds: [] });
      expect([409]).toContain(dup.status);

      const mastery = await ctx.prisma.topicMastery.findUniqueOrThrow({ where: { userId_topicId: { userId: s.userId, topicId: bank.topic.id } } });
      expect(mastery.totalAnswered).toBe(10);
      expect(mastery.totalCorrect).toBe(3);
      expect(mastery.masteryScore).toBeLessThan(0.5);
      expect(await ctx.prisma.revisionSchedule.count({ where: { userId: s.userId, itemType: 'QUESTION' } })).toBe(7);

      const recs = await ctx.app.get(LearningService).recommendations(s.userId, bank.exam.id);
      expect(recs.weakTopics[0].topicId).toBe(bank.topic.id);
      expect(recs.nextTopics[0].factors.length).toBeGreaterThan(0);

      const plan = await ctx.http().post('/api/v1/study-plans').set(auth(s.token)).send({ examId: bank.exam.id, dailyMinutes: 60 }).expect(201);
      const today = await ctx.http().get(`/api/v1/study-plans/${plan.body.data.id}/today`).set(auth(s.token)).expect(200);
      expect(today.body.data.length).toBeGreaterThan(0);
      expect(today.body.data.reduce((n: number, t: { estimatedMinutes: number }) => n + t.estimatedMinutes, 0)).toBeLessThanOrEqual(60);
      expect(today.body.data.every((t: { reason: { summary: string } }) => t.reason.summary)).toBe(true);
      // Idempotent generation.
      const again = await ctx.http().get(`/api/v1/study-plans/${plan.body.data.id}/today`).set(auth(s.token)).expect(200);
      expect(again.body.data.length).toBe(today.body.data.length);

      const wrong = await ctx.http().get('/api/v1/revision/wrong-answers').set(auth(s.token)).expect(200);
      expect(wrong.body.meta.pagination.total).toBe(7);
    });
  });

  describe('AI assistant with RAG (local provider, no external AI)', () => {
    it('answers from approved, indexed sources with citations and refuses to invent official dates', async () => {
      const editor = await staffLogin(ctx, 'kb-editor@test.local', ['CONTENT_EDITOR']);
      const src = await ctx.http().post('/api/v1/admin/knowledge-sources').set(auth(editor.token)).send({
        title: 'Percentages note',
        rawText: 'A percentage is a fraction of one hundred. To find x percent of N, multiply N by x and divide by 100.',
        mimeType: 'text/plain',
      }).expect(201);
      // Unapproved content is never retrievable.
      const s = await studentLogin(ctx);
      expect(await ctx.app.get(KnowledgeService).retrieve('percentage', { userId: s.userId })).toHaveLength(0);
      const self = await ctx.http().post(`/api/v1/admin/knowledge-sources/${src.body.data.id}/approve`).set(auth(editor.token)).expect(403);
      expect(self.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
      await ctx.http().post(`/api/v1/admin/knowledge-sources/${src.body.data.id}/approve`).set(auth(admin.token)).expect(200);
      expect(await ctx.app.get(KnowledgeService).index(src.body.data.id)).toBeGreaterThan(0);

      const conv = await ctx.http().post('/api/v1/ai/conversations').set(auth(s.token)).send({}).expect(201);
      const sent = await ctx.http().post(`/api/v1/ai/conversations/${conv.body.data.id}/messages`).set(auth(s.token)).send({ content: 'How do I find a percentage of a number?' }).expect(201);
      expect(sent.body.data.status).toBe('PENDING');
      await ctx.app.get(AssistantService).generateReply(sent.body.data.assistantMessageId);
      const reply = await ctx.http().get(`/api/v1/ai/messages/${sent.body.data.assistantMessageId}`).set(auth(s.token)).expect(200);
      expect(reply.body.data.status).toBe('COMPLETED');
      expect(reply.body.data.content).toMatch(/multiply N by x/);
      expect(reply.body.data.citations[0]).toMatchObject({ title: 'Percentages note' });

      const q2 = await ctx.http().post(`/api/v1/ai/conversations/${conv.body.data.id}/messages`).set(auth(s.token)).send({ content: 'What is the exam date of the next BCS?' }).expect(201);
      await ctx.app.get(AssistantService).generateReply(q2.body.data.assistantMessageId);
      const r2 = await ctx.http().get(`/api/v1/ai/messages/${q2.body.data.assistantMessageId}`).set(auth(s.token)).expect(200);
      expect(r2.body.data.content).toContain('will not guess');

      const usage = await ctx.prisma.aiUsageRecord.count({ where: { userId: s.userId } });
      expect(usage).toBeGreaterThan(0);
    });
  });
});
