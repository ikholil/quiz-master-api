import { TestContext, auth, createTestApp, nextPhone, resetDatabase, staffLogin, studentLogin } from './helpers';

describe('Authentication & authorization (integration)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx);
  });
  afterAll(async () => ctx.app.close());

  it('signs up a new student with phone OTP and stores only a hash of the code', async () => {
    const phone = nextPhone();
    const req = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: phone, purpose: 'LOGIN' }).expect(200);
    expect(req.body).toMatchObject({ success: true, data: { sent: true, cooldownSeconds: 60 } });
    const code = req.body.data.devCode;
    const row = await ctx.prisma.otpVerification.findFirstOrThrow({ where: { identifier: `+88${phone}` } });
    expect(row.codeHash).not.toContain(code);

    const res = await ctx.http().post('/api/v1/auth/otp/verify').send({ identifier: phone, code }).expect(200);
    expect(res.body.data).toMatchObject({ isNewUser: true, user: { phone: `+88${phone}`, roles: ['STUDENT'] } });

    const me = await ctx.http().get('/api/v1/me').set(auth(res.body.data.accessToken)).expect(200);
    expect(me.body.data.phoneVerified).toBe(true);
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
  });

  it('rejects wrong OTPs, counts attempts and locks the code after the maximum', async () => {
    const phone = nextPhone();
    const req = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: phone, purpose: 'LOGIN' }).expect(200);
    const good = req.body.data.devCode as string;
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await ctx.http().post('/api/v1/auth/otp/verify').send({ identifier: phone, code: wrong }).expect(400);
      expect(r.body.error.code).toBe('OTP_INVALID');
    }
    const locked = await ctx.http().post('/api/v1/auth/otp/verify').send({ identifier: phone, code: good }).expect(400);
    expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('enforces the OTP resend cooldown', async () => {
    const phone = nextPhone();
    await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: phone, purpose: 'LOGIN' }).expect(200);
    const again = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: phone, purpose: 'LOGIN' }).expect(429);
    expect(again.body.error.code).toBe('OTP_COOLDOWN');
  });

  it('does not reveal whether an account exists when requesting a reset code', async () => {
    const res = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: 'nobody@example.com', purpose: 'RESET_PASSWORD' }).expect(200);
    expect(res.body.data.sent).toBe(true);
    expect(res.body.data.devCode).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const s = await studentLogin(ctx);
    const r1 = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
    expect(r1.body.data.refreshToken).not.toEqual(s.refreshToken);

    // Simulate a stolen token being replayed after the grace window.
    await ctx.prisma.refreshToken.updateMany({ where: { usedAt: { not: null } }, data: { usedAt: new Date(Date.now() - 60_000) } });
    const replay = await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The whole session (including the new tokens) is revoked.
    await ctx.http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken }).expect(401);
    const me = await ctx.http().get('/api/v1/me').set(auth(r1.body.data.accessToken)).expect(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  it('logout revokes the access token immediately', async () => {
    const s = await studentLogin(ctx);
    await ctx.http().post('/api/v1/auth/logout').set(auth(s.token)).expect(200);
    await ctx.http().get('/api/v1/me').set(auth(s.token)).expect(401);
  });

  it('locks password login after repeated failures (brute-force protection)', async () => {
    await staffLogin(ctx, 'lock@example.com', ['STUDENT']).catch(() => undefined);
    for (let i = 0; i < 5; i++) {
      await ctx.http().post('/api/v1/auth/login').send({ identifier: 'lock@example.com', password: 'wrong-password1' }).expect(401);
    }
    const res = await ctx.http().post('/api/v1/auth/login').send({ identifier: 'lock@example.com', password: 'StaffPass123' }).expect(429);
    expect(res.body.error.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
  });

  it('separates public, student and admin routes', async () => {
    await ctx.http().get('/api/v1/public/exam-categories').expect(200);
    const unauth = await ctx.http().get('/api/v1/me').expect(401);
    expect(unauth.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });

    const student = await studentLogin(ctx);
    const forbidden = await ctx.http().get('/api/v1/admin/users').set(auth(student.token)).expect(403);
    expect(forbidden.body.error.code).toBe('PERMISSION_DENIED');

    const admin = await staffLogin(ctx, 'admin1@example.com', ['ADMIN']);
    const list = await ctx.http().get('/api/v1/admin/users?pageSize=5').set(auth(admin.token)).expect(200);
    expect(list.body.meta.pagination).toMatchObject({ page: 1, pageSize: 5 });
  });

  it('refuses admin dashboard sign-in for accounts without admin access', async () => {
    const s = await staffLogin(ctx, 'plain@example.com', ['STUDENT']).catch((e) => e);
    expect(s).toBeInstanceOf(Error);
  });

  it('applies permission changes and suspension without waiting for token expiry', async () => {
    const admin = await staffLogin(ctx, 'super@example.com', ['SUPER_ADMIN']);
    const student = await studentLogin(ctx);
    await ctx.http().patch(`/api/v1/admin/users/${student.userId}/status`).set(auth(admin.token)).send({ status: 'SUSPENDED', reason: 'abuse test' }).expect(200);
    await ctx.http().get('/api/v1/me').set(auth(student.token)).expect(401);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'user.status', entityId: student.userId } });
    expect(audit?.actorId).toBe(admin.userId);
  });

  it('validates request bodies strictly and reports field errors', async () => {
    const res = await ctx.http().post('/api/v1/auth/otp/request').send({ identifier: '123', purpose: 'LOGIN', extra: 1 }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.error.details)).toContain('extra');
  });

  it('deletes an account (re-authenticated) and anonymises personal data', async () => {
    const s = await studentLogin(ctx);
    const codeRes = await ctx.http().post('/api/v1/me/deletion-code').set(auth(s.token)).expect(200);
    await ctx.http().delete('/api/v1/me').set(auth(s.token)).send({ code: codeRes.body.data.devCode, confirm: 'DELETE' }).expect(200);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: s.userId } });
    expect(user).toMatchObject({ status: 'DELETED', phone: null, email: null });
    await ctx.http().get('/api/v1/me').set(auth(s.token)).expect(401);
  });

  it('exports personal data as a background job', async () => {
    const s = await studentLogin(ctx);
    const req = await ctx.http().post('/api/v1/me/data-export').set(auth(s.token)).expect(201);
    const { UsersService } = await import('../src/modules/users/users.service');
    await ctx.app.get(UsersService).buildDataExport(req.body.data.id);
    const status = await ctx.http().get(`/api/v1/me/data-export/${req.body.data.id}`).set(auth(s.token)).expect(200);
    expect(status.body.data.status).toBe('READY');
    expect(status.body.data.downloadUrl).toContain('/api/v1/files/download/');
  });
});
