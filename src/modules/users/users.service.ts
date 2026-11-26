import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { DataExportStatus, OtpPurpose, Prisma, UserStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { verifyPassword } from '../../common/utils/crypto.util';
import { parseIsoDate } from '../../common/utils/date.util';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { AuditService } from '../audit/audit.service';
import { OtpService } from '../auth/otp.service';
import { SessionService } from '../auth/session.service';
import { FilesService } from '../files/files.service';
import { RbacService } from '../rbac/rbac.service';
import { AdminUserQueryDto, DeleteAccountDto, UpdateProfileDto, UpdateUserStatusDto } from './users.dto';

const EXPORT_TTL_DAYS = 7;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    @InjectQueue(QUEUES.MAINTENANCE) private readonly maintenance: Queue,
  ) {}

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    const access = await this.rbac.getAccess(userId);
    const p = user.profile;
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      phoneVerified: !!user.phoneVerifiedAt,
      emailVerified: !!user.emailVerifiedAt,
      hasPassword: !!user.passwordHash,
      status: user.status,
      profile: {
        fullName: p?.fullName ?? null,
        displayName: p?.displayName ?? null,
        avatarFileId: p?.avatarFileId ?? null,
        gender: p?.gender ?? null,
        dateOfBirth: p?.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null,
        district: p?.district ?? null,
        institution: p?.institution ?? null,
        educationLevel: p?.educationLevel ?? null,
        preferredLocale: p?.preferredLocale ?? 'bn',
        targetExamIds: p?.targetExamIds ?? [],
        dailyStudyMinutes: p?.dailyStudyMinutes ?? 60,
      },
      roles: access.roles,
      permissions: access.permissions,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.targetExamIds?.length) {
      const count = await this.prisma.exam.count({ where: { id: { in: dto.targetExamIds }, status: 'PUBLISHED' } });
      if (count !== new Set(dto.targetExamIds).size) throw AppError.badRequest('INVALID_EXAM', 'One or more target exams do not exist');
    }
    if (dto.avatarFileId) {
      const file = await this.prisma.storedFile.findUnique({ where: { id: dto.avatarFileId } });
      if (!file || file.ownerId !== userId || file.purpose !== 'AVATAR') throw AppError.badRequest('INVALID_FILE', 'Invalid avatar file');
    }
    const data: Prisma.ProfileUpdateInput = {
      ...dto,
      dateOfBirth: dto.dateOfBirth ? parseIsoDate(dto.dateOfBirth.slice(0, 10)) : undefined,
    };
    await this.prisma.profile.upsert({
      where: { userId },
      create: { ...(data as Prisma.ProfileCreateWithoutUserInput), user: { connect: { id: userId } } },
      update: data,
    });
    return this.me(userId);
  }

  /** Sends a DELETE_ACCOUNT code to the user's verified phone (preferred) or email. */
  async requestDeletionCode(userId: string, ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.phone && user.phoneVerifiedAt) return this.otp.issue(user.phone, 'SMS', OtpPurpose.DELETE_ACCOUNT, ctx.ip);
    if (user.email && user.emailVerifiedAt) return this.otp.issue(user.email, 'EMAIL', OtpPurpose.DELETE_ACCOUNT, ctx.ip);
    throw AppError.badRequest('NO_VERIFIED_CONTACT', 'No verified phone or email on this account');
  }

  /**
   * Account deletion: personal data is erased/anonymised immediately; financial records are retained
   * (legal obligation) but detached from personal identifiers. Requires re-authentication.
   */
  async deleteAccount(userId: string, dto: DeleteAccountDto, ctx: RequestContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (dto.password) {
      if (!user.passwordHash || !(await verifyPassword(dto.password, user.passwordHash))) {
        throw AppError.badRequest('INVALID_CREDENTIALS', 'Password is incorrect');
      }
    } else if (dto.code) {
      const identifier = user.phone && user.phoneVerifiedAt ? user.phone : user.email;
      if (!identifier) throw AppError.badRequest('NO_VERIFIED_CONTACT', 'No verified contact');
      await this.otp.verify(identifier, OtpPurpose.DELETE_ACCOUNT, dto.code);
    } else {
      throw AppError.badRequest('REAUTH_REQUIRED', 'Provide your password or a DELETE_ACCOUNT code');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { phone: null, email: null, passwordHash: null, phoneVerifiedAt: null, emailVerifiedAt: null, status: UserStatus.DELETED, deletedAt: new Date() },
      });
      await tx.profile.updateMany({
        where: { userId },
        data: { fullName: null, displayName: null, avatarFileId: null, gender: null, dateOfBirth: null, district: null, institution: null, educationLevel: null },
      });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.aiConversation.deleteMany({ where: { userId } });
      await tx.flashcard.deleteMany({ where: { ownerId: userId } });
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userSubscription.updateMany({ where: { userId, status: { in: ['ACTIVE', 'PENDING'] } }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.entitlement.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.discussion.updateMany({ where: { authorId: userId }, data: { body: '[deleted]', status: 'REMOVED', deletedAt: new Date() } });
      await tx.discussionReply.updateMany({ where: { authorId: userId }, data: { body: '[deleted]', status: 'REMOVED', deletedAt: new Date() } });
      await this.audit.record({ actorId: userId, action: 'user.delete', entityType: 'User', entityId: userId, ctx }, tx);
    });
    await this.sessions.revokeAllForUser(userId, 'account_deleted');
    await this.rbac.invalidate(userId);
    return { ok: true };
  }

  async requestDataExport(userId: string) {
    const recent = await this.prisma.dataExportRequest.findFirst({
      where: { userId, status: { in: [DataExportStatus.QUEUED, DataExportStatus.PROCESSING] } },
    });
    if (recent) return this.exportView(recent);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const todayCount = await this.prisma.dataExportRequest.count({ where: { userId, createdAt: { gte: dayAgo } } });
    if (todayCount >= 3) throw AppError.tooMany('Data export can be requested at most 3 times per day');
    const req = await this.prisma.dataExportRequest.create({ data: { userId } });
    await this.maintenance.add(JOBS.DATA_EXPORT, { requestId: req.id }, { jobId: `export-${req.id}` });
    return this.exportView(req);
  }

  async getDataExport(userId: string, id: string) {
    const req = await this.prisma.dataExportRequest.findFirst({ where: { id, userId } });
    if (!req) throw AppError.notFound('Data export');
    return this.exportView(req, true);
  }

  private async exportView(req: { id: string; status: DataExportStatus; fileId: string | null; expiresAt: Date | null; createdAt: Date; userId: string }, withUrl = false) {
    let downloadUrl: string | null = null;
    if (withUrl && req.status === DataExportStatus.READY && req.fileId && req.expiresAt && req.expiresAt > new Date()) {
      const url = await this.files.getDownloadUrl(req.fileId, { id: req.userId, sessionId: '', roles: [], permissions: [] }, 900);
      downloadUrl = url.url;
    }
    return { id: req.id, status: req.status, downloadUrl, expiresAt: req.expiresAt, createdAt: req.createdAt };
  }

  /** Background job: assemble every personal record into a JSON document. */
  async buildDataExport(requestId: string): Promise<void> {
    const req = await this.prisma.dataExportRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status === DataExportStatus.READY) return;
    await this.prisma.dataExportRequest.update({ where: { id: requestId }, data: { status: DataExportStatus.PROCESSING } });
    try {
      const userId = req.userId;
      const [user, attempts, practice, mastery, plans, flashcards, conversations, enrollments, subscriptions, payments, notifications, discussions, replies, tickets, sessions] =
        await Promise.all([
          this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } }),
          this.prisma.examAttempt.findMany({ where: { userId }, include: { result: true, answers: { select: { questionId: true, selectedOptionIds: true, textAnswer: true, awardedMarks: true, answeredAt: true } } } }),
          this.prisma.practiceSession.findMany({ where: { userId }, include: { answers: true } }),
          this.prisma.topicMastery.findMany({ where: { userId } }),
          this.prisma.studyPlan.findMany({ where: { userId }, include: { tasks: true } }),
          this.prisma.flashcard.findMany({ where: { ownerId: userId } }),
          this.prisma.aiConversation.findMany({ where: { userId }, include: { messages: { select: { role: true, content: true, createdAt: true } } } }),
          this.prisma.enrollment.findMany({ where: { userId } }),
          this.prisma.userSubscription.findMany({ where: { userId } }),
          this.prisma.payment.findMany({ where: { userId }, select: { id: true, purpose: true, amountMinor: true, currency: true, status: true, provider: true, paidAt: true, createdAt: true } }),
          this.prisma.notification.findMany({ where: { userId } }),
          this.prisma.discussion.findMany({ where: { authorId: userId } }),
          this.prisma.discussionReply.findMany({ where: { authorId: userId } }),
          this.prisma.supportTicket.findMany({ where: { userId }, include: { messages: true } }),
          this.prisma.session.findMany({ where: { userId }, select: { platform: true, deviceName: true, ipAddress: true, createdAt: true, lastSeenAt: true, revokedAt: true } }),
        ]);
      const safeUser = user ? { ...user, passwordHash: undefined } : null;
      const doc = {
        generatedAt: new Date().toISOString(),
        user: safeUser,
        sessions,
        attempts,
        practice,
        topicMastery: mastery,
        studyPlans: plans,
        flashcards,
        aiConversations: conversations,
        enrollments,
        subscriptions,
        payments,
        notifications,
        discussions,
        discussionReplies: replies,
        supportTickets: tickets,
      };
      const body = Buffer.from(JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
      const file = await this.files.storeGenerated(userId, `data-export-${requestId}.json`, 'application/json', body, 'DATA_EXPORT');
      await this.prisma.dataExportRequest.update({
        where: { id: requestId },
        data: { status: DataExportStatus.READY, fileId: file.id, completedAt: new Date(), expiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000) },
      });
    } catch (err) {
      this.logger.error(`Data export ${requestId} failed: ${(err as Error).message}`);
      await this.prisma.dataExportRequest.update({ where: { id: requestId }, data: { status: DataExportStatus.FAILED, error: 'Export failed' } });
      throw err;
    }
  }

  // ───────────── Admin ─────────────

  async adminList(q: AdminUserQueryDto) {
    const where: Prisma.UserWhereInput = {
      status: q.status,
      deletedAt: q.status === UserStatus.DELETED ? undefined : null,
      roles: q.role ? { some: { role: { key: q.role } } } : undefined,
      OR: q.q
        ? [
            { phone: { contains: q.q } },
            { email: { contains: q.q.toLowerCase() } },
            { profile: { fullName: { contains: q.q, mode: 'insensitive' } } },
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: { profile: { select: { fullName: true } }, roles: { include: { role: { select: { key: true } } } } },
        orderBy: { createdAt: q.sortOrder },
        ...pageArgs(q),
      }),
      this.prisma.user.count({ where }),
    ]);
    return PageResult.of(
      rows.map((u) => ({
        id: u.id,
        phone: u.phone,
        email: u.email,
        status: u.status,
        fullName: u.profile?.fullName ?? null,
        roles: u.roles.map((r) => r.role.key),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      })),
      total,
      q,
    );
  }

  async adminGet(id: string) {
    const me = await this.me(id).catch(() => null);
    if (!me) throw AppError.notFound('User');
    const [attempts, subscriptions, sessions] = await Promise.all([
      this.prisma.examAttempt.count({ where: { userId: id } }),
      this.prisma.userSubscription.findMany({ where: { userId: id }, include: { plan: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }),
      this.sessions.listSessions(id),
    ]);
    return { ...me, stats: { attempts }, subscriptions, activeSessions: sessions };
  }

  async adminSetStatus(id: string, dto: UpdateUserStatusDto, actorId: string, ctx: RequestContext) {
    if (id === actorId) throw AppError.badRequest('SELF_STATUS_CHANGE', 'You cannot change your own status');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw AppError.notFound('User');
    const target = await this.rbac.getAccess(id);
    const actor = await this.rbac.getAccess(actorId);
    if (target.roles.includes('SUPER_ADMIN') && !actor.roles.includes('SUPER_ADMIN')) throw AppError.forbidden('Cannot change a super administrator');
    await this.prisma.user.update({ where: { id }, data: { status: dto.status } });
    if (dto.status === UserStatus.SUSPENDED) await this.sessions.revokeAllForUser(id, 'suspended');
    await this.audit.record({ actorId, action: 'user.status', entityType: 'User', entityId: id, before: { status: user.status }, after: { status: dto.status }, metadata: { reason: dto.reason }, ctx });
    return { id, status: dto.status };
  }
}
