import { Body, Controller, Get, HttpCode, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AccessLevel, ContentStatus, MaterialType, Prisma, ReviewDecision, ReviewEntityType } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUrl, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PageResult, pageArgs, SearchPaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../rbac/permissions';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { SETTINGS, SystemConfigService } from '../system-config/system-config.module';

export class MaterialDto {
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @ApiProperty({ enum: MaterialType }) @IsEnum(MaterialType) type: MaterialType;
  @IsOptional() @IsString() @MaxLength(200000) content?: string;
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) url?: string;
  @IsOptional() @IsUUID() fileId?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @ApiPropertyOptional({ enum: AccessLevel }) @IsOptional() @IsEnum(AccessLevel) accessLevel?: AccessLevel;
  @IsOptional() @IsInt() @Min(1) @Max(600) estimatedMinutes?: number;
}

export class UpdateMaterialDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @IsOptional() @IsString() @MaxLength(200000) content?: string;
  @IsOptional() @IsUrl({ require_protocol: true, protocols: ['https'] }) url?: string;
  @IsOptional() @IsUUID() fileId?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @ApiPropertyOptional({ enum: AccessLevel }) @IsOptional() @IsEnum(AccessLevel) accessLevel?: AccessLevel;
  @IsOptional() @IsInt() @Min(1) @Max(600) estimatedMinutes?: number;
}

class MaterialReviewDto {
  @ApiProperty({ enum: ReviewDecision }) @IsEnum(ReviewDecision) decision: ReviewDecision;
  @IsOptional() @IsString() @MaxLength(5000) comments?: string;
}

export class MaterialQueryDto extends SearchPaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @ApiPropertyOptional({ enum: MaterialType }) @IsOptional() @IsEnum(MaterialType) type?: MaterialType;
  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
}

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: SystemConfigService,
  ) {}

  async list(userId: string, q: MaterialQueryDto) {
    const where: Prisma.LearningMaterialWhereInput = {
      status: ContentStatus.PUBLISHED,
      examId: q.examId,
      topicId: q.topicId,
      type: q.type,
      title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.learningMaterial.findMany({ where, orderBy: { publishedAt: 'desc' }, ...pageArgs(q), select: { id: true, title: true, titleBn: true, type: true, examId: true, topicId: true, accessLevel: true, estimatedMinutes: true, publishedAt: true } }),
      this.prisma.learningMaterial.count({ where }),
    ]);
    const premium = await this.entitlements.has(userId, FEATURES.MATERIALS_PREMIUM);
    return PageResult.of(rows.map((r) => ({ ...r, unlocked: r.accessLevel === AccessLevel.FREE || premium })), total, q);
  }

  async get(userId: string, id: string) {
    const m = await this.prisma.learningMaterial.findFirst({ where: { id, status: ContentStatus.PUBLISHED } });
    if (!m) throw AppError.notFound('Material');
    if (m.accessLevel === AccessLevel.PREMIUM) await this.entitlements.assert(userId, FEATURES.MATERIALS_PREMIUM);
    const { createdById: _c, ...rest } = m;
    return rest;
  }

  async create(dto: MaterialDto, actorId: string, ctx: RequestContext) {
    this.assertBody(dto);
    const m = await this.prisma.learningMaterial.create({ data: { ...dto, createdById: actorId } });
    await this.audit.record({ actorId, action: 'material.create', entityType: 'LearningMaterial', entityId: m.id, after: { title: dto.title }, ctx });
    return m;
  }

  async update(id: string, dto: UpdateMaterialDto, actorId: string, ctx: RequestContext) {
    const m = await this.prisma.learningMaterial.findUnique({ where: { id } });
    if (!m) throw AppError.notFound('Material');
    // Editing published content sends it back through review.
    const contentChanged = dto.content !== undefined || dto.url !== undefined || dto.fileId !== undefined;
    const updated = await this.prisma.learningMaterial.update({
      where: { id },
      data: { ...dto, status: contentChanged && m.status !== ContentStatus.DRAFT ? ContentStatus.DRAFT : undefined, createdById: contentChanged ? actorId : undefined },
    });
    await this.audit.record({ actorId, action: 'material.update', entityType: 'LearningMaterial', entityId: id, after: { ...dto, content: dto.content ? '[content]' : undefined }, ctx });
    return updated;
  }

  async submit(id: string, actorId: string, ctx: RequestContext) {
    return this.transition(id, [ContentStatus.DRAFT, ContentStatus.CHANGES_REQUESTED], ContentStatus.IN_REVIEW, actorId, 'material.submit', ctx);
  }

  async review(id: string, dto: MaterialReviewDto, actorId: string, ctx: RequestContext) {
    const m = await this.prisma.learningMaterial.findUnique({ where: { id } });
    if (!m) throw AppError.notFound('Material');
    if (m.status !== ContentStatus.IN_REVIEW) throw AppError.conflict('INVALID_TRANSITION', 'Material is not in review');
    if ((await this.settings.get<boolean>(SETTINGS.REQUIRE_DISTINCT_REVIEWER, true)) && m.createdById === actorId) {
      throw AppError.forbidden('Authors cannot review their own content', 'SELF_REVIEW_FORBIDDEN');
    }
    const next = { APPROVED: ContentStatus.APPROVED, REJECTED: ContentStatus.REJECTED, CHANGES_REQUESTED: ContentStatus.CHANGES_REQUESTED }[dto.decision];
    await this.prisma.$transaction([
      this.prisma.contentReview.create({ data: { entityType: ReviewEntityType.LEARNING_MATERIAL, entityId: id, reviewerId: actorId, decision: dto.decision, comments: dto.comments } }),
      this.prisma.learningMaterial.update({ where: { id }, data: { status: next } }),
    ]);
    await this.audit.record({ actorId, action: `material.review.${dto.decision.toLowerCase()}`, entityType: 'LearningMaterial', entityId: id, ctx });
    return { id, status: next };
  }

  async publish(id: string, actorId: string, ctx: RequestContext) {
    const res = await this.transition(id, [ContentStatus.APPROVED], ContentStatus.PUBLISHED, actorId, 'material.publish', ctx);
    await this.prisma.learningMaterial.update({ where: { id }, data: { publishedAt: new Date() } });
    return res;
  }

  async archive(id: string, actorId: string, ctx: RequestContext) {
    return this.transition(id, Object.values(ContentStatus), ContentStatus.ARCHIVED, actorId, 'material.archive', ctx);
  }

  async adminList(q: MaterialQueryDto) {
    const where: Prisma.LearningMaterialWhereInput = { status: q.status, examId: q.examId, topicId: q.topicId, type: q.type, title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.learningMaterial.findMany({ where, orderBy: { updatedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.learningMaterial.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  private async transition(id: string, from: ContentStatus[], to: ContentStatus, actorId: string, action: string, ctx: RequestContext) {
    const m = await this.prisma.learningMaterial.findUnique({ where: { id } });
    if (!m) throw AppError.notFound('Material');
    if (!from.includes(m.status)) throw AppError.conflict('INVALID_TRANSITION', `Cannot move from ${m.status} to ${to}`);
    await this.prisma.learningMaterial.update({ where: { id }, data: { status: to } });
    await this.audit.record({ actorId, action, entityType: 'LearningMaterial', entityId: id, before: { status: m.status }, after: { status: to }, ctx });
    return { id, status: to };
  }

  private assertBody(dto: MaterialDto) {
    const needs: Record<MaterialType, boolean> = {
      ARTICLE: !!dto.content,
      NOTE: !!dto.content,
      PDF: !!dto.fileId,
      VIDEO: !!dto.url || !!dto.fileId,
      LINK: !!dto.url,
    };
    if (!needs[dto.type]) throw AppError.badRequest('MATERIAL_BODY_REQUIRED', `A ${dto.type} material needs ${dto.type === 'PDF' ? 'fileId' : dto.type === 'LINK' ? 'url' : 'content'}`);
  }
}

@ApiTags('Learning materials')
@Authenticated()
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query() q: MaterialQueryDto) {
    return this.materials.list(u.id, q);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.materials.get(u.id, id);
  }
}

@ApiTags('Admin · Learning materials')
@Controller('admin/materials')
export class AdminMaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get()
  @AdminOnly(PERMISSIONS.MATERIALS_MANAGE)
  list(@Query() q: MaterialQueryDto) {
    return this.materials.adminList(q);
  }
  @Post()
  @AdminOnly(PERMISSIONS.MATERIALS_MANAGE)
  create(@Body() dto: MaterialDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.create(dto, u.id, ctx);
  }
  @Patch(':id')
  @AdminOnly(PERMISSIONS.MATERIALS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMaterialDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.update(id, dto, u.id, ctx);
  }
  @Post(':id/submit')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.MATERIALS_MANAGE)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.submit(id, u.id, ctx);
  }
  @Post(':id/review')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_REVIEW)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaterialReviewDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.review(id, dto, u.id, ctx);
  }
  @Post(':id/publish')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_PUBLISH)
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.publish(id, u.id, ctx);
  }
  @Post(':id/archive')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.MATERIALS_MANAGE)
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.materials.archive(id, u.id, ctx);
  }
}

@Module({ controllers: [MaterialsController, AdminMaterialsController], providers: [MaterialsService], exports: [MaterialsService] })
export class MaterialsModule {}
