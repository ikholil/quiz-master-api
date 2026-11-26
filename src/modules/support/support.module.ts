import { Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, TicketPriority, TicketStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../rbac/permissions';

const CATEGORIES = ['ACCOUNT', 'PAYMENT', 'EXAM', 'CONTENT_ERROR', 'TECHNICAL', 'OTHER'];

class CreateTicketDto {
  @IsString() @MinLength(5) @MaxLength(200) subject: string;
  @IsIn(CATEGORIES) category: string;
  @IsString() @MinLength(5) @MaxLength(10000) body: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUUID('4', { each: true }) fileIds?: string[];
}
class TicketMessageDto {
  @IsString() @MinLength(1) @MaxLength(10000) body: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsUUID('4', { each: true }) fileIds?: string[];
}
class UpdateTicketDto {
  @ApiPropertyOptional({ enum: TicketStatus }) @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
  @ApiPropertyOptional({ enum: TicketPriority }) @IsOptional() @IsEnum(TicketPriority) priority?: TicketPriority;
  @IsOptional() @IsUUID() assigneeId?: string;
}
class TicketQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TicketStatus }) @IsOptional() @IsEnum(TicketStatus) status?: TicketStatus;
  @ApiPropertyOptional({ enum: TicketPriority }) @IsOptional() @IsEnum(TicketPriority) priority?: TicketPriority;
  @IsOptional() @IsUUID() assigneeId?: string;
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async create(user: AuthUser, dto: CreateTicketDto) {
    await this.assertFiles(user.id, dto.fileIds);
    const open = await this.prisma.supportTicket.count({ where: { userId: user.id, status: { in: [TicketStatus.OPEN, TicketStatus.AWAITING_SUPPORT] } } });
    if (open >= 5) throw AppError.tooMany('You already have 5 open tickets');
    const priority = dto.category === 'PAYMENT' ? TicketPriority.HIGH : TicketPriority.NORMAL;
    return this.prisma.supportTicket.create({
      data: { userId: user.id, subject: dto.subject, category: dto.category, priority, messages: { create: { authorId: user.id, body: dto.body, fileIds: dto.fileIds ?? [] } } },
      include: { messages: true },
    });
  }

  async mine(userId: string, q: PaginationQueryDto) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({ where: { userId }, orderBy: { lastMessageAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.supportTicket.count({ where: { userId } }),
    ]);
    return PageResult.of(items, total, q);
  }

  async get(user: AuthUser, id: string, staff = false) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!t || (!staff && t.userId !== user.id)) throw AppError.notFound('Ticket');
    return t;
  }

  async addMessage(user: AuthUser, id: string, dto: TicketMessageDto, staff: boolean, ctx?: RequestContext) {
    const t = await this.get(user, id, staff);
    if (t.status === TicketStatus.CLOSED) throw AppError.conflict('TICKET_CLOSED', 'This ticket is closed; open a new one');
    if (!staff) await this.assertFiles(user.id, dto.fileIds);
    const [msg] = await this.prisma.$transaction([
      this.prisma.supportTicketMessage.create({ data: { ticketId: id, authorId: user.id, isStaff: staff, body: dto.body, fileIds: dto.fileIds ?? [] } }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { lastMessageAt: new Date(), status: staff ? TicketStatus.AWAITING_USER : TicketStatus.AWAITING_SUPPORT, assigneeId: staff && !t.assigneeId ? user.id : undefined },
      }),
    ]);
    if (staff) {
      await this.notifications.notify(t.userId, { type: 'support.reply', title: 'সাপোর্ট টিম উত্তর দিয়েছে', body: `Reply on: ${t.subject.slice(0, 80)}`, data: { ticketId: id }, channels: ['IN_APP', 'PUSH'] });
      await this.audit.record({ actorId: user.id, action: 'support.reply', entityType: 'SupportTicket', entityId: id, ctx });
    }
    return msg;
  }

  async closeByUser(user: AuthUser, id: string) {
    await this.get(user, id);
    return this.prisma.supportTicket.update({ where: { id }, data: { status: TicketStatus.CLOSED, closedAt: new Date() } });
  }

  async adminList(q: TicketQueryDto) {
    const where: Prisma.SupportTicketWhereInput = { status: q.status, priority: q.priority, assigneeId: q.assigneeId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({ where, orderBy: [{ priority: 'desc' }, { lastMessageAt: 'asc' }], ...pageArgs(q) }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async adminUpdate(id: string, dto: UpdateTicketDto, actor: AuthUser, ctx: RequestContext) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw AppError.notFound('Ticket');
    const closing = dto.status === TicketStatus.CLOSED || dto.status === TicketStatus.RESOLVED;
    const updated = await this.prisma.supportTicket.update({ where: { id }, data: { ...dto, closedAt: closing ? new Date() : undefined } });
    await this.audit.record({ actorId: actor.id, action: 'support.update', entityType: 'SupportTicket', entityId: id, before: { status: t.status, priority: t.priority, assigneeId: t.assigneeId }, after: dto, ctx });
    return updated;
  }

  private async assertFiles(userId: string, fileIds?: string[]) {
    if (!fileIds?.length) return;
    const n = await this.prisma.storedFile.count({ where: { id: { in: fileIds }, ownerId: userId, purpose: 'SUPPORT_ATTACHMENT' } });
    if (n !== new Set(fileIds).size) throw AppError.badRequest('INVALID_FILE', 'Attachments must be your own SUPPORT_ATTACHMENT uploads');
  }
}

@ApiTags('Support')
@Authenticated()
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) {
    return this.support.create(u, dto);
  }
  @Get()
  mine(@CurrentUser() u: AuthUser, @Query() q: PaginationQueryDto) {
    return this.support.mine(u.id, q);
  }
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(u, id);
  }
  @Post(':id/messages')
  message(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketMessageDto) {
    return this.support.addMessage(u, id, dto, false);
  }
  @Post(':id/close')
  close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.closeByUser(u, id);
  }
}

@ApiTags('Admin · Support')
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @AdminOnly(PERMISSIONS.SUPPORT_MANAGE)
  list(@Query() q: TicketQueryDto) {
    return this.support.adminList(q);
  }
  @Get(':id')
  @AdminOnly(PERMISSIONS.SUPPORT_MANAGE)
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(u, id, true);
  }
  @Post(':id/messages')
  @AdminOnly(PERMISSIONS.SUPPORT_MANAGE)
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TicketMessageDto, @ReqContext() ctx: RequestContext) {
    return this.support.addMessage(u, id, dto, true, ctx);
  }
  @Patch(':id')
  @AdminOnly(PERMISSIONS.SUPPORT_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.support.adminUpdate(id, dto, u, ctx);
  }
}

@Module({ controllers: [SupportController, AdminSupportController], providers: [SupportService] })
export class SupportModule {}
