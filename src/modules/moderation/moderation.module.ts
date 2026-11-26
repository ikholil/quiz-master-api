import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { CommunityStatus, Prisma, ReportStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AdminOnly, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../rbac/permissions';

class ModerationReportQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus }) @IsOptional() @IsEnum(ReportStatus) status?: ReportStatus;
  @ApiPropertyOptional({ enum: ReportTargetType })
  @IsOptional()
  @IsEnum(ReportTargetType)
  targetType?: ReportTargetType;
}
class ResolveDto {
  @ApiProperty({ enum: ['DISMISS', 'HIDE', 'REMOVE', 'RESTORE'] })
  @IsIn(['DISMISS', 'HIDE', 'REMOVE', 'RESTORE'])
  action: 'DISMISS' | 'HIDE' | 'REMOVE' | 'RESTORE';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class DiscussionStatusDto {
  @ApiProperty({ enum: CommunityStatus }) @IsEnum(CommunityStatus) status: CommunityStatus;
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
class RestrictDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
  /** Omit for an indefinite restriction. */
  @IsOptional() @IsISO8601() until?: string;
}

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Reports grouped by target, with the content to review. */
  async queue(q: ModerationReportQueryDto) {
    const where: Prisma.ContentReportWhereInput = {
      status: q.status ?? ReportStatus.OPEN,
      targetType: q.targetType,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contentReport.findMany({ where, orderBy: { createdAt: 'asc' }, ...pageArgs(q) }),
      this.prisma.contentReport.count({ where }),
    ]);
    const discussionIds = items.filter((i) => i.targetType === 'DISCUSSION').map((i) => i.targetId);
    const replyIds = items.filter((i) => i.targetType === 'REPLY').map((i) => i.targetId);
    const [ds, rs] = await Promise.all([
      this.prisma.discussion.findMany({
        where: { id: { in: discussionIds } },
        select: { id: true, title: true, body: true, status: true, authorId: true },
      }),
      this.prisma.discussionReply.findMany({
        where: { id: { in: replyIds } },
        select: { id: true, body: true, status: true, authorId: true, discussionId: true },
      }),
    ]);
    const content = new Map<string, unknown>([
      ...ds.map((d) => [d.id, d] as const),
      ...rs.map((r) => [r.id, r] as const),
    ]);
    return PageResult.of(
      items.map((i) => ({ ...i, content: content.get(i.targetId) ?? null })),
      total,
      q,
    );
  }

  async resolve(reportId: string, dto: ResolveDto, actor: AuthUser, ctx: RequestContext) {
    const report = await this.prisma.contentReport.findUnique({ where: { id: reportId } });
    if (!report) throw AppError.notFound('Report');
    const newStatus = {
      HIDE: CommunityStatus.HIDDEN,
      REMOVE: CommunityStatus.REMOVED,
      RESTORE: CommunityStatus.VISIBLE,
      DISMISS: null,
    }[dto.action];
    await this.prisma.$transaction(async (tx) => {
      if (newStatus) {
        if (report.targetType === 'DISCUSSION')
          await tx.discussion.update({ where: { id: report.targetId }, data: { status: newStatus } });
        if (report.targetType === 'REPLY')
          await tx.discussionReply.update({ where: { id: report.targetId }, data: { status: newStatus } });
      }
      // Resolve every open report on the same target together.
      await tx.contentReport.updateMany({
        where: {
          targetType: report.targetType,
          targetId: report.targetId,
          status: { in: [ReportStatus.OPEN, ReportStatus.IN_REVIEW] },
        },
        data: {
          status: dto.action === 'DISMISS' ? ReportStatus.DISMISSED : ReportStatus.RESOLVED,
          resolution: dto.note ?? dto.action,
          resolvedById: actor.id,
          resolvedAt: new Date(),
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: `moderation.${dto.action.toLowerCase()}`,
          entityType: report.targetType,
          entityId: report.targetId,
          metadata: { reportId, note: dto.note },
          ctx,
        },
        tx,
      );
    });
    return { ok: true };
  }

  async setDiscussionStatus(id: string, dto: DiscussionStatusDto, actor: AuthUser, ctx: RequestContext) {
    const d = await this.prisma.discussion.findUnique({ where: { id } });
    if (!d) throw AppError.notFound('Discussion');
    await this.prisma.discussion.update({ where: { id }, data: { status: dto.status } });
    await this.audit.record({
      actorId: actor.id,
      action: 'moderation.discussion.status',
      entityType: 'Discussion',
      entityId: id,
      before: { status: d.status },
      after: dto,
      ctx,
    });
    return { id, status: dto.status };
  }

  async restrict(userId: string, dto: RestrictDto, actor: AuthUser, ctx: RequestContext) {
    if (userId === actor.id) throw AppError.badRequest('SELF_RESTRICT', 'You cannot restrict yourself');
    if (!(await this.prisma.user.count({ where: { id: userId } }))) throw AppError.notFound('User');
    const r = await this.prisma.communityRestriction.upsert({
      where: { userId },
      create: {
        userId,
        reason: dto.reason,
        until: dto.until ? new Date(dto.until) : null,
        createdById: actor.id,
      },
      update: { reason: dto.reason, until: dto.until ? new Date(dto.until) : null, createdById: actor.id },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'moderation.user.restrict',
      entityType: 'User',
      entityId: userId,
      after: dto,
      ctx,
    });
    return r;
  }

  async unrestrict(userId: string, actor: AuthUser, ctx: RequestContext) {
    await this.prisma.communityRestriction.deleteMany({ where: { userId } });
    await this.audit.record({
      actorId: actor.id,
      action: 'moderation.user.unrestrict',
      entityType: 'User',
      entityId: userId,
      ctx,
    });
    return { ok: true };
  }
}

@ApiTags('Admin · Moderation')
@Controller('admin/moderation')
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('reports')
  @AdminOnly(PERMISSIONS.COMMUNITY_MODERATE)
  queue(@Query() q: ModerationReportQueryDto) {
    return this.moderation.queue(q);
  }

  @Post('reports/:id/resolve')
  @AdminOnly(PERMISSIONS.COMMUNITY_MODERATE)
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.moderation.resolve(id, dto, u, ctx);
  }

  @Patch('discussions/:id/status')
  @AdminOnly(PERMISSIONS.COMMUNITY_MODERATE)
  status(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DiscussionStatusDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.moderation.setDiscussionStatus(id, dto, u, ctx);
  }

  @Put('users/:id/restriction')
  @AdminOnly(PERMISSIONS.COMMUNITY_MODERATE)
  restrict(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestrictDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.moderation.restrict(id, dto, u, ctx);
  }

  @Delete('users/:id/restriction')
  @AdminOnly(PERMISSIONS.COMMUNITY_MODERATE)
  unrestrict(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.moderation.unrestrict(id, u, ctx);
  }
}

@Module({ controllers: [ModerationController], providers: [ModerationService] })
export class ModerationModule {}
