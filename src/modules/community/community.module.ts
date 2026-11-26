import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { CommunityStatus, Prisma, ReportStatus, ReportTargetType } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Authenticated, CurrentUser, Public } from '../../common/decorators/auth.decorators';
import {
  PageResult,
  pageArgs,
  PaginationQueryDto,
  SearchPaginationQueryDto,
} from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';

export class DiscussionDto {
  @IsString() @MinLength(5) @MaxLength(200) title: string;
  @IsString() @MinLength(5) @MaxLength(10000) body: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() questionId?: string;
}
export class UpdateDiscussionDto {
  @IsOptional() @IsString() @MinLength(5) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(10000) body?: string;
}
export class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}
export class ReportContentDto {
  @ApiProperty({ enum: ReportTargetType }) @IsEnum(ReportTargetType) targetType: ReportTargetType;
  @IsUUID() targetId: string;
  @IsIn(['SPAM', 'ABUSE', 'MISINFORMATION', 'CHEATING', 'OFF_TOPIC', 'OTHER']) reason: string;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
}
class DiscussionQueryDto extends SearchPaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() questionId?: string;
}

const EDIT_WINDOW_MS = 24 * 3600_000;
const AUTHOR_SELECT = {
  id: true,
  profile: { select: { displayName: true, fullName: true, avatarFileId: true } },
  status: true,
} as const;

function authorView(a: {
  id: string;
  status: string;
  profile: { displayName: string | null; fullName: string | null; avatarFileId: string | null } | null;
}) {
  if (a.status === 'DELETED') return { id: null, name: 'Deleted user', avatarFileId: null };
  return {
    id: a.id,
    name: a.profile?.displayName ?? a.profile?.fullName?.split(' ')[0] ?? 'Student',
    avatarFileId: a.profile?.avatarFileId ?? null,
  };
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: DiscussionQueryDto) {
    const where: Prisma.DiscussionWhereInput = {
      status: { in: [CommunityStatus.VISIBLE, CommunityStatus.LOCKED] },
      deletedAt: null,
      examId: q.examId,
      topicId: q.topicId,
      questionId: q.questionId,
      title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.discussion.findMany({
        where,
        include: { author: { select: AUTHOR_SELECT } },
        orderBy: { lastActivityAt: 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.discussion.count({ where }),
    ]);
    return PageResult.of(
      rows.map((d) => ({
        id: d.id,
        title: d.title,
        excerpt: d.body.slice(0, 200),
        examId: d.examId,
        topicId: d.topicId,
        status: d.status,
        replyCount: d.replyCount,
        lastActivityAt: d.lastActivityAt,
        createdAt: d.createdAt,
        author: authorView(d.author),
      })),
      total,
      q,
    );
  }

  async get(id: string, q: PaginationQueryDto) {
    const d = await this.prisma.discussion.findFirst({
      where: { id, deletedAt: null, status: { in: [CommunityStatus.VISIBLE, CommunityStatus.LOCKED] } },
      include: { author: { select: AUTHOR_SELECT } },
    });
    if (!d) throw AppError.notFound('Discussion');
    const where = { discussionId: id, deletedAt: null, status: CommunityStatus.VISIBLE };
    const [replies, total] = await this.prisma.$transaction([
      this.prisma.discussionReply.findMany({
        where,
        include: { author: { select: AUTHOR_SELECT } },
        orderBy: { createdAt: 'asc' },
        ...pageArgs(q),
      }),
      this.prisma.discussionReply.count({ where }),
    ]);
    return {
      id: d.id,
      title: d.title,
      body: d.body,
      status: d.status,
      examId: d.examId,
      topicId: d.topicId,
      questionId: d.questionId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      author: authorView(d.author),
      replies: {
        items: replies.map((r) => ({
          id: r.id,
          body: r.body,
          createdAt: r.createdAt,
          author: authorView(r.author),
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      },
    };
  }

  async create(user: AuthUser, dto: DiscussionDto) {
    await this.assertCanPost(user.id);
    await this.assertClean(`${dto.title}\n${dto.body}`);
    await this.assertRateLimit(user.id);
    return this.prisma.discussion.create({ data: { ...dto, authorId: user.id } });
  }

  async update(user: AuthUser, id: string, dto: UpdateDiscussionDto) {
    const d = await this.prisma.discussion.findUnique({ where: { id } });
    if (!d || d.deletedAt || d.authorId !== user.id) throw AppError.notFound('Discussion');
    if (Date.now() - d.createdAt.getTime() > EDIT_WINDOW_MS)
      throw AppError.forbidden('Posts can only be edited within 24 hours', 'EDIT_WINDOW_CLOSED');
    await this.assertClean(`${dto.title ?? ''}\n${dto.body ?? ''}`);
    return this.prisma.discussion.update({ where: { id }, data: dto });
  }

  async remove(user: AuthUser, id: string) {
    const d = await this.prisma.discussion.findUnique({ where: { id } });
    if (!d || d.deletedAt || d.authorId !== user.id) throw AppError.notFound('Discussion');
    await this.prisma.discussion.update({
      where: { id },
      data: { deletedAt: new Date(), status: CommunityStatus.REMOVED },
    });
    return { ok: true };
  }

  async reply(user: AuthUser, discussionId: string, dto: ReplyDto) {
    await this.assertCanPost(user.id);
    const d = await this.prisma.discussion.findFirst({ where: { id: discussionId, deletedAt: null } });
    if (!d || d.status === CommunityStatus.HIDDEN || d.status === CommunityStatus.REMOVED)
      throw AppError.notFound('Discussion');
    if (d.status === CommunityStatus.LOCKED)
      throw AppError.forbidden('This discussion is locked', 'DISCUSSION_LOCKED');
    await this.assertClean(dto.body);
    await this.assertRateLimit(user.id);
    const [reply] = await this.prisma.$transaction([
      this.prisma.discussionReply.create({ data: { discussionId, authorId: user.id, body: dto.body } }),
      this.prisma.discussion.update({
        where: { id: discussionId },
        data: { replyCount: { increment: 1 }, lastActivityAt: new Date() },
      }),
    ]);
    if (d.authorId !== user.id) {
      await this.notifications.notify(d.authorId, {
        type: 'community.reply',
        title: 'নতুন উত্তর',
        body: `New reply on "${d.title.slice(0, 60)}"`,
        data: { discussionId },
        channels: ['IN_APP', 'PUSH'],
      });
    }
    return reply;
  }

  async removeReply(user: AuthUser, id: string) {
    const r = await this.prisma.discussionReply.findUnique({ where: { id } });
    if (!r || r.deletedAt || r.authorId !== user.id) throw AppError.notFound('Reply');
    await this.prisma.$transaction([
      this.prisma.discussionReply.update({
        where: { id },
        data: { deletedAt: new Date(), status: CommunityStatus.REMOVED },
      }),
      this.prisma.discussion.update({
        where: { id: r.discussionId },
        data: { replyCount: { decrement: 1 } },
      }),
    ]);
    return { ok: true };
  }

  /** Reports are unique per reporter+target; enough distinct reports auto-hide content pending moderation. */
  async report(user: AuthUser, dto: ReportContentDto) {
    const exists =
      dto.targetType === ReportTargetType.DISCUSSION
        ? await this.prisma.discussion.count({ where: { id: dto.targetId } })
        : dto.targetType === ReportTargetType.REPLY
          ? await this.prisma.discussionReply.count({ where: { id: dto.targetId } })
          : await this.prisma.user.count({ where: { id: dto.targetId } });
    if (!exists) throw AppError.notFound('Content');
    try {
      await this.prisma.contentReport.create({ data: { reporterId: user.id, ...dto } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002')
        throw AppError.conflict('ALREADY_REPORTED', 'You already reported this');
      throw err;
    }
    const threshold = await this.settings.get<number>(SETTINGS.COMMUNITY_AUTO_HIDE_REPORTS, 5);
    const open = await this.prisma.contentReport.count({
      where: { targetType: dto.targetType, targetId: dto.targetId, status: ReportStatus.OPEN },
    });
    if (open >= threshold) {
      if (dto.targetType === ReportTargetType.DISCUSSION)
        await this.prisma.discussion.updateMany({
          where: { id: dto.targetId, status: CommunityStatus.VISIBLE },
          data: { status: CommunityStatus.HIDDEN },
        });
      if (dto.targetType === ReportTargetType.REPLY)
        await this.prisma.discussionReply.updateMany({
          where: { id: dto.targetId, status: CommunityStatus.VISIBLE },
          data: { status: CommunityStatus.HIDDEN },
        });
    }
    return { reported: true };
  }

  private async assertCanPost(userId: string) {
    const r = await this.prisma.communityRestriction.findUnique({ where: { userId } });
    if (r && (!r.until || r.until > new Date()))
      throw AppError.forbidden('You are restricted from posting in the community', 'COMMUNITY_RESTRICTED');
  }

  private async assertClean(text: string) {
    const words = await this.settings.get<string[]>(SETTINGS.COMMUNITY_BLOCKED_WORDS, []);
    const lower = text.toLowerCase();
    if (words.some((w) => w && lower.includes(w.toLowerCase())))
      throw AppError.badRequest('CONTENT_BLOCKED', 'Your post contains words that are not allowed');
  }

  private async assertRateLimit(userId: string) {
    const recent = await this.prisma.discussionReply.count({
      where: { authorId: userId, createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    const recentPosts = await this.prisma.discussion.count({
      where: { authorId: userId, createdAt: { gte: new Date(Date.now() - 60_000) } },
    });
    if (recent + recentPosts >= 5) throw AppError.tooMany('You are posting too quickly');
  }
}

@ApiTags('Community')
@Controller('community')
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Public()
  @Get('discussions')
  list(@Query() q: DiscussionQueryDto) {
    return this.community.list(q);
  }

  @Public()
  @Get('discussions/:id')
  get(@Param('id', ParseUUIDPipe) id: string, @Query() q: PaginationQueryDto) {
    return this.community.get(id, q);
  }

  @Authenticated()
  @Post('discussions')
  create(@CurrentUser() u: AuthUser, @Body() dto: DiscussionDto) {
    return this.community.create(u, dto);
  }

  @Authenticated()
  @Patch('discussions/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiscussionDto,
  ) {
    return this.community.update(u, id, dto);
  }

  @Authenticated()
  @Delete('discussions/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.community.remove(u, id);
  }

  @Authenticated()
  @Post('discussions/:id/replies')
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto) {
    return this.community.reply(u, id, dto);
  }

  @Authenticated()
  @Delete('replies/:id')
  removeReply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.community.removeReply(u, id);
  }

  @Authenticated()
  @Post('reports')
  report(@CurrentUser() u: AuthUser, @Body() dto: ReportContentDto) {
    return this.community.report(u, dto);
  }
}

@Global()
@Module({ controllers: [CommunityController], providers: [CommunityService], exports: [CommunityService] })
export class CommunityModule {}
