import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ExamEventType, Prisma, PublishStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  AdminOnly,
  Authenticated,
  CurrentUser,
  Public,
  ReqContext,
} from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { DAY_MS, toIsoDate } from '../../common/utils/date.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../rbac/permissions';

class ExamEventDto {
  @ApiProperty({ enum: ExamEventType }) @IsEnum(ExamEventType) type: ExamEventType;
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsISO8601() startsAt: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  /** Official circular / notice URL — required to publish. */
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
  @IsOptional() @IsUUID() noticeId?: string;
}
class UpdateExamEventDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
  @IsOptional() @IsUUID() noticeId?: string;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}
class CalendarQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

const REMINDER_TYPES: ExamEventType[] = [
  ExamEventType.APPLICATION_DEADLINE,
  ExamEventType.EXAM_DATE,
  ExamEventType.ADMIT_CARD,
];

@Injectable()
export class ExamCalendarService {
  private readonly logger = new Logger(ExamCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(examId: string, dto: ExamEventDto, actor: AuthUser, ctx: RequestContext) {
    if (!(await this.prisma.exam.count({ where: { id: examId } }))) throw AppError.notFound('Exam');
    this.assertWindow(dto.startsAt, dto.endsAt);
    const e = await this.prisma.examEvent.create({
      data: {
        examId,
        ...dto,
        startsAt: new Date(dto.startsAt),
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        createdById: actor.id,
      },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'exam_event.create',
      entityType: 'ExamEvent',
      entityId: e.id,
      after: dto,
      ctx,
    });
    return e;
  }

  async update(id: string, dto: UpdateExamEventDto, actor: AuthUser, ctx: RequestContext) {
    const before = await this.prisma.examEvent.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Exam event');
    const sourceUrl = dto.sourceUrl ?? before.sourceUrl;
    const noticeId = dto.noticeId ?? before.noticeId;
    // Official dates are never published without a verifiable source.
    if (dto.status === PublishStatus.PUBLISHED && !sourceUrl && !noticeId) {
      throw AppError.badRequest(
        'SOURCE_REQUIRED',
        'Link the official circular (sourceUrl) or a published notice before publishing a date',
      );
    }
    this.assertWindow(
      dto.startsAt ?? before.startsAt.toISOString(),
      dto.endsAt ?? before.endsAt?.toISOString(),
    );
    const e = await this.prisma.examEvent.update({
      where: { id },
      data: {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'exam_event.update',
      entityType: 'ExamEvent',
      entityId: id,
      before,
      after: dto,
      ctx,
    });
    return e;
  }

  async remove(id: string, actor: AuthUser, ctx: RequestContext) {
    await this.prisma.examEvent.delete({ where: { id } }).catch(() => {
      throw AppError.notFound('Exam event');
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'exam_event.delete',
      entityType: 'ExamEvent',
      entityId: id,
      ctx,
    });
    return { ok: true };
  }

  adminList(examId: string) {
    return this.prisma.examEvent.findMany({ where: { examId }, orderBy: { startsAt: 'asc' } });
  }

  async publicList(examId: string) {
    const events = await this.prisma.examEvent.findMany({
      where: { examId, status: PublishStatus.PUBLISHED, exam: { status: PublishStatus.PUBLISHED } },
      orderBy: { startsAt: 'asc' },
    });
    return events.map((e) => this.view(e));
  }

  /** Upcoming dates for the student's bookmarked and target exams, with countdowns. */
  async myCalendar(userId: string, days = 90) {
    const [bookmarks, profile] = await Promise.all([
      this.prisma.examBookmark.findMany({ where: { userId }, select: { examId: true } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { targetExamIds: true } }),
    ]);
    const examIds = [...new Set([...bookmarks.map((b) => b.examId), ...(profile?.targetExamIds ?? [])])];
    const now = new Date();
    const events = await this.prisma.examEvent.findMany({
      where: {
        examId: { in: examIds },
        status: PublishStatus.PUBLISHED,
        OR: [{ startsAt: { gte: now } }, { endsAt: { gte: now } }],
        startsAt: { lte: new Date(now.getTime() + days * DAY_MS) },
      },
      include: { exam: { select: { name: true, slug: true } } },
      orderBy: { startsAt: 'asc' },
    });
    return events.map((e) => ({ ...this.view(e), examName: e.exam.name, examSlug: e.exam.slug }));
  }

  /** Scheduled: notify students 7, 3 and 1 day(s) before deadlines and exam dates of exams they follow. */
  async sendReminders(now = new Date()): Promise<number> {
    let sent = 0;
    for (const daysBefore of [7, 3, 1]) {
      const from = new Date(now.getTime() + (daysBefore - 0.5) * DAY_MS);
      const to = new Date(now.getTime() + (daysBefore + 0.5) * DAY_MS);
      const events = await this.prisma.examEvent.findMany({
        where: {
          status: PublishStatus.PUBLISHED,
          type: { in: REMINDER_TYPES },
          startsAt: { gte: from, lt: to },
        },
        include: { exam: { select: { name: true } } },
      });
      for (const e of events) {
        const followers = await this.prisma.user.findMany({
          where: {
            status: 'ACTIVE',
            OR: [
              { examBookmarks: { some: { examId: e.examId } } },
              { profile: { targetExamIds: { has: e.examId } } },
            ],
          },
          select: { id: true },
        });
        for (const f of followers) {
          const id = await this.notifications.notify(f.id, {
            type: 'exam.reminder',
            title: `${e.exam.name}: ${daysBefore} দিন বাকি`,
            body: `${e.title} — ${toIsoDate(e.startsAt)}. Confirm on the official circular.`,
            data: { examId: e.examId, eventId: e.id },
            channels: ['IN_APP', 'PUSH'],
            dedupeKey: `exam-event:${e.id}:${daysBefore}:${f.id}`,
          });
          if (id) sent++;
        }
      }
    }
    if (sent) this.logger.log(`Exam reminders sent: ${sent}`);
    return sent;
  }

  private view(e: Prisma.ExamEventGetPayload<object>) {
    const ms = e.startsAt.getTime() - Date.now();
    return {
      id: e.id,
      examId: e.examId,
      type: e.type,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      sourceUrl: e.sourceUrl,
      noticeId: e.noticeId,
      daysRemaining: ms > 0 ? Math.ceil(ms / DAY_MS) : 0,
      ongoing: ms <= 0 && !!e.endsAt && e.endsAt.getTime() > Date.now(),
    };
  }

  private assertWindow(start: string, end?: string | null) {
    if (end && new Date(end) < new Date(start))
      throw AppError.badRequest('INVALID_WINDOW', 'endsAt must be after startsAt');
  }
}

@ApiTags('Exam calendar')
@Controller()
export class ExamCalendarController {
  constructor(private readonly calendar: ExamCalendarService) {}

  @Public()
  @Get('public/exams/:examId/events')
  @ApiOperation({ summary: 'Official dates for an exam (each published date links its source)' })
  list(@Param('examId', ParseUUIDPipe) examId: string) {
    return this.calendar.publicList(examId);
  }

  @Authenticated()
  @Get('exam-calendar')
  @ApiOperation({ summary: 'Upcoming dates for bookmarked and target exams, with countdowns' })
  mine(@CurrentUser() u: AuthUser, @Query() q: CalendarQueryDto) {
    return this.calendar.myCalendar(u.id, q.days ?? 90);
  }

  @Get('admin/exams/:examId/events')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  adminList(@Param('examId', ParseUUIDPipe) examId: string) {
    return this.calendar.adminList(examId);
  }

  @Post('admin/exams/:examId/events')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  create(
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: ExamEventDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.calendar.create(examId, dto, u, ctx);
  }

  @Patch('admin/exam-events/:id')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExamEventDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.calendar.update(id, dto, u, ctx);
  }

  @Delete('admin/exam-events/:id')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.calendar.remove(id, u, ctx);
  }
}

@Module({
  controllers: [ExamCalendarController],
  providers: [ExamCalendarService],
  exports: [ExamCalendarService],
})
export class ExamCalendarModule {}
