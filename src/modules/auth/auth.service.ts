import { Inject, Injectable } from '@nestjs/common';
import { ClientPlatform, OtpChannel, OtpPurpose, Prisma, User, UserStatus } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { AppError } from '../../common/errors/app-error';
import { hashPassword, verifyPassword } from '../../common/utils/crypto.util';
import { normalizeBdPhone, normalizeEmail } from '../../common/utils/phone.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RbacService } from '../rbac/rbac.service';
import {
  ChangePasswordDto,
  DeviceInfoDto,
  OtpRequestResponse,
  PasswordLoginDto,
  RegisterEmailDto,
  RequestOtpDto,
  ResetPasswordDto,
  TokenResponse,
  VerifyEmailDto,
  VerifyOtpDto,
} from './auth.dto';
import { LoginGuardService } from './login-guard.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

export interface ParsedIdentifier {
  value: string;
  channel: OtpChannel;
  field: 'phone' | 'email';
}

export function parseIdentifier(raw: string): ParsedIdentifier {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) {
    const email = normalizeEmail(trimmed);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw AppError.badRequest('INVALID_IDENTIFIER', 'Invalid email address');
    return { value: email, channel: OtpChannel.EMAIL, field: 'email' };
  }
  const phone = normalizeBdPhone(trimmed);
  if (!phone) throw AppError.badRequest('INVALID_IDENTIFIER', 'Invalid Bangladeshi mobile number');
  return { value: phone, channel: OtpChannel.SMS, field: 'phone' };
}

const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly loginGuard: LoginGuardService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Issues an OTP. The response is identical whether or not an account exists (no account enumeration).
   * For flows that require an existing account, delivery silently does not happen when there is none.
   */
  async requestOtp(dto: RequestOtpDto, ctx: RequestContext): Promise<OtpRequestResponse> {
    const id = parseIdentifier(dto.identifier);
    if (dto.purpose === OtpPurpose.VERIFY_EMAIL && id.field !== 'email')
      throw AppError.badRequest('INVALID_IDENTIFIER', 'Email required');
    if (dto.purpose === OtpPurpose.VERIFY_PHONE && id.field !== 'phone')
      throw AppError.badRequest('INVALID_IDENTIFIER', 'Phone number required');

    const user = await this.findByIdentifier(id);
    const requiresAccount = dto.purpose !== OtpPurpose.LOGIN;
    const blocked = user?.status === UserStatus.SUSPENDED;
    const deliver = !blocked && (!requiresAccount || !!user);
    const result = await this.otp.issue(id.value, id.channel, dto.purpose, ctx.ip, deliver);
    if (!deliver) delete result.devCode;
    return { sent: true, ...result };
  }

  /** Passwordless sign-in / sign-up with phone or email OTP. */
  async verifyOtpLogin(dto: VerifyOtpDto, ctx: RequestContext): Promise<TokenResponse> {
    const id = parseIdentifier(dto.identifier);
    await this.otp.verify(id.value, OtpPurpose.LOGIN, dto.code);

    let user = await this.findByIdentifier(id);
    let isNewUser = false;
    const verifiedField = id.field === 'phone' ? 'phoneVerifiedAt' : 'emailVerifiedAt';
    if (!user) {
      isNewUser = true;
      user = await this.prisma.user.create({
        data: {
          [id.field]: id.value,
          [verifiedField]: new Date(),
          status: UserStatus.ACTIVE,
          profile: { create: {} },
        },
      });
      await this.rbac.assignDefaultRole(user.id);
      await this.audit.record({
        actorId: user.id,
        action: 'auth.register',
        entityType: 'User',
        entityId: user.id,
        metadata: { method: `otp_${id.field}` },
        ctx,
      });
    } else {
      this.assertCanLogin(user);
      if (!user[verifiedField] || user.status === UserStatus.PENDING_VERIFICATION) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: { [verifiedField]: new Date(), status: UserStatus.ACTIVE },
        });
      }
    }
    return this.completeLogin(user, dto, ctx, isNewUser, `otp_${id.field}`);
  }

  async registerWithEmail(dto: RegisterEmailDto, ctx: RequestContext): Promise<OtpRequestResponse> {
    if (!this.cfg.auth.passwordLoginEnabled)
      throw AppError.forbidden('Password registration is disabled', 'PASSWORD_AUTH_DISABLED');
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && existing.status !== UserStatus.PENDING_VERIFICATION) {
      // Do not reveal that the account exists; send nothing.
      const r = await this.otp.issue(email, OtpChannel.EMAIL, OtpPurpose.VERIFY_EMAIL, ctx.ip, false);
      delete r.devCode;
      return { sent: true, ...r };
    }
    const passwordHash = await hashPassword(dto.password);
    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          profile: { upsert: { create: { fullName: dto.fullName }, update: { fullName: dto.fullName } } },
        },
      });
    } else {
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          status: UserStatus.PENDING_VERIFICATION,
          profile: { create: { fullName: dto.fullName } },
        },
      });
      await this.rbac.assignDefaultRole(user.id);
      await this.audit.record({
        actorId: user.id,
        action: 'auth.register',
        entityType: 'User',
        entityId: user.id,
        metadata: { method: 'email_password' },
        ctx,
      });
    }
    const r = await this.otp.issue(email, OtpChannel.EMAIL, OtpPurpose.VERIFY_EMAIL, ctx.ip);
    return { sent: true, ...r };
  }

  async verifyEmail(dto: VerifyEmailDto, ctx: RequestContext): Promise<TokenResponse> {
    const email = normalizeEmail(dto.email);
    await this.otp.verify(email, OtpPurpose.VERIFY_EMAIL, dto.code);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired');
    this.assertCanLogin(user);
    const isNewUser = user.status === UserStatus.PENDING_VERIFICATION;
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), status: UserStatus.ACTIVE },
    });
    return this.completeLogin(updated, dto, ctx, isNewUser, 'email_verify');
  }

  async loginWithPassword(dto: PasswordLoginDto, ctx: RequestContext): Promise<TokenResponse> {
    if (!this.cfg.auth.passwordLoginEnabled)
      throw AppError.forbidden('Password login is disabled', 'PASSWORD_AUTH_DISABLED');
    const id = parseIdentifier(dto.identifier);
    await this.loginGuard.assertNotLocked(id.value);
    const user = await this.findByIdentifier(id);
    // Always run a hash comparison so response time does not reveal whether the account exists.
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) {
      await this.loginGuard.recordFailure(id.value);
      if (user)
        await this.audit.record({
          actorId: user.id,
          action: 'auth.login.failed',
          entityType: 'User',
          entityId: user.id,
          ctx,
        });
      throw AppError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    }
    if (user.status === UserStatus.PENDING_VERIFICATION) {
      throw AppError.forbidden('Verify your email or phone before signing in', 'VERIFICATION_REQUIRED');
    }
    this.assertCanLogin(user);
    await this.loginGuard.reset(id.value);
    return this.completeLogin(user, dto, ctx, false, 'password');
  }

  async refresh(refreshToken: string, ctx: RequestContext) {
    const { userId: _userId, ...tokens } = await this.sessions.rotate(refreshToken, ctx);
    return tokens;
  }

  async logout(sessionId: string, userId: string, ctx: RequestContext) {
    await this.sessions.revokeSession(sessionId, 'logout');
    await this.audit.record({
      actorId: userId,
      action: 'auth.logout',
      entityType: 'Session',
      entityId: sessionId,
      ctx,
    });
    return { ok: true };
  }

  async logoutAll(userId: string, currentSessionId: string, includeCurrent: boolean, ctx: RequestContext) {
    const revoked = await this.sessions.revokeAllForUser(
      userId,
      'logout_all',
      includeCurrent ? undefined : currentSessionId,
    );
    await this.audit.record({
      actorId: userId,
      action: 'auth.logout_all',
      entityType: 'User',
      entityId: userId,
      metadata: { revoked },
      ctx,
    });
    return { revoked };
  }

  async revokeSession(userId: string, sessionId: string, ctx: RequestContext) {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId } });
    if (!session) throw AppError.notFound('Session');
    await this.sessions.revokeSession(sessionId, 'user_revoked');
    await this.audit.record({
      actorId: userId,
      action: 'auth.session.revoke',
      entityType: 'Session',
      entityId: sessionId,
      ctx,
    });
    return { ok: true };
  }

  async resetPassword(dto: ResetPasswordDto, ctx: RequestContext) {
    const id = parseIdentifier(dto.identifier);
    await this.otp.verify(id.value, OtpPurpose.RESET_PASSWORD, dto.code);
    const user = await this.findByIdentifier(id);
    if (!user) throw AppError.badRequest('OTP_INVALID', 'The code is invalid or has expired');
    this.assertCanLogin(user);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });
    await this.sessions.revokeAllForUser(user.id, 'password_reset');
    await this.loginGuard.reset(id.value);
    await this.audit.record({
      actorId: user.id,
      action: 'auth.password.reset',
      entityType: 'User',
      entityId: user.id,
      ctx,
    });
    return { ok: true };
  }

  async changePassword(userId: string, sessionId: string, dto: ChangePasswordDto, ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash) {
      if (!dto.currentPassword || !(await verifyPassword(dto.currentPassword, user.passwordHash))) {
        throw AppError.badRequest('INVALID_CREDENTIALS', 'Current password is incorrect');
      }
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });
    await this.sessions.revokeAllForUser(userId, 'password_changed', sessionId);
    await this.audit.record({
      actorId: userId,
      action: 'auth.password.change',
      entityType: 'User',
      entityId: userId,
      ctx,
    });
    return { ok: true };
  }

  listSessions(userId: string, currentSessionId: string) {
    return this.sessions
      .listSessions(userId)
      .then((list) => list.map((s) => ({ ...s, current: s.id === currentSessionId })));
  }

  private async completeLogin(
    user: User,
    device: DeviceInfoDto,
    ctx: RequestContext,
    isNewUser: boolean,
    method: string,
  ): Promise<TokenResponse> {
    const access = await this.rbac.getAccess(user.id);
    const isAdmin = RbacService.isAdmin(access);
    if (device.platform === ClientPlatform.ADMIN_WEB && !isAdmin) {
      throw AppError.forbidden(
        'This account cannot access the administration dashboard',
        'ADMIN_ACCESS_DENIED',
      );
    }
    // Administrators must use password login (stronger audit trail) for the admin dashboard.
    if (device.platform === ClientPlatform.ADMIN_WEB && method.startsWith('otp') && !user.passwordHash) {
      throw AppError.forbidden(
        'Set a password before signing in to the dashboard',
        'ADMIN_PASSWORD_REQUIRED',
      );
    }
    const tokens = await this.sessions.createSession(
      user.id,
      device,
      ctx,
      isAdmin && device.platform === ClientPlatform.ADMIN_WEB,
    );
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      actorId: user.id,
      action: 'auth.login',
      entityType: 'Session',
      entityId: tokens.sessionId,
      metadata: { method, platform: device.platform },
      ctx,
    });
    const profile = await this.prisma.profile.findUnique({
      where: { userId: user.id },
      select: { fullName: true },
    });
    return {
      ...tokens,
      isNewUser,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        status: user.status,
        fullName: profile?.fullName ?? null,
        roles: access.roles,
        permissions: access.permissions,
      },
    };
  }

  private assertCanLogin(user: User) {
    if (user.deletedAt || user.status === UserStatus.DELETED)
      throw AppError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
    if (user.status === UserStatus.SUSPENDED)
      throw AppError.forbidden('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  private findByIdentifier(id: ParsedIdentifier) {
    const where: Prisma.UserWhereUniqueInput =
      id.field === 'email' ? { email: id.value } : { phone: id.value };
    return this.prisma.user.findUnique({ where });
  }
}
