import { Body, Controller, Delete, Get, Global, Injectable, Module, Param, Put } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsDefined, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AdminOnly, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSIONS } from '../rbac/permissions';

/** Well-known setting keys with defaults (settings are data; these are only fallbacks). */
export const SETTINGS = {
  REQUIRE_DISTINCT_REVIEWER: 'content.require_distinct_reviewer',
  COMMUNITY_BLOCKED_WORDS: 'community.blocked_words',
  COMMUNITY_AUTO_HIDE_REPORTS: 'community.auto_hide_report_threshold',
  ANDROID_MIN_VERSION: 'app.android.min_version',
  MAINTENANCE_MODE: 'app.maintenance_mode',
  AI_ENABLED: 'ai.enabled',
  FREE_PRACTICE_DAILY_QUESTIONS: 'practice.free_daily_questions',
  ATTEMPT_SUBMIT_GRACE_SECONDS: 'exam.submit_grace_seconds',
} as const;

const DEFAULTS: Record<string, unknown> = {
  [SETTINGS.REQUIRE_DISTINCT_REVIEWER]: true,
  [SETTINGS.COMMUNITY_BLOCKED_WORDS]: [],
  [SETTINGS.COMMUNITY_AUTO_HIDE_REPORTS]: 5,
  [SETTINGS.ANDROID_MIN_VERSION]: '1.0.0',
  [SETTINGS.MAINTENANCE_MODE]: false,
  [SETTINGS.AI_ENABLED]: true,
  [SETTINGS.FREE_PRACTICE_DAILY_QUESTIONS]: 50,
  [SETTINGS.ATTEMPT_SUBMIT_GRACE_SECONDS]: 30,
};

const CACHE_TTL_MS = 30_000;

@Injectable()
export class SystemConfigService {
  private cache = new Map<string, { value: unknown; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get<T>(key: string, fallback?: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    const value = row ? row.value : (fallback ?? DEFAULTS[key]);
    this.cache.set(key, { value, at: Date.now() });
    return value as T;
  }

  list() {
    return this.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
  }

  async publicSettings() {
    const rows = await this.prisma.systemSetting.findMany({ where: { isPublic: true } });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async set(key: string, dto: UpsertSettingDto, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.systemSetting.findUnique({ where: { key } });
    const row = await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: dto.value as Prisma.InputJsonValue, description: dto.description, isPublic: dto.isPublic ?? false, updatedById: actorId },
      update: { value: dto.value as Prisma.InputJsonValue, description: dto.description, isPublic: dto.isPublic, updatedById: actorId },
    });
    this.cache.delete(key);
    await this.audit.record({ actorId, action: 'settings.set', entityType: 'SystemSetting', entityId: key, before: before?.value, after: dto.value, ctx });
    return row;
  }

  async remove(key: string, actorId: string, ctx: RequestContext) {
    const before = await this.prisma.systemSetting.findUnique({ where: { key } });
    if (!before) throw AppError.notFound('Setting');
    await this.prisma.systemSetting.delete({ where: { key } });
    this.cache.delete(key);
    await this.audit.record({ actorId, action: 'settings.delete', entityType: 'SystemSetting', entityId: key, before: before.value, ctx });
    return { ok: true };
  }
}

export class UpsertSettingDto {
  @ApiProperty({ description: 'Any JSON value' }) @IsDefined() value: unknown;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsBoolean() isPublic?: boolean;
}

export class SettingResponse {
  @ApiProperty() key: string;
  @ApiProperty({ description: 'JSON value' }) value: unknown;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() isPublic: boolean;
  @ApiProperty() updatedAt: Date;
}

class KeyParam {
  @Matches(/^[a-z0-9_.-]{2,100}$/) key: string;
}

@ApiTags('Public · Configuration')
@Controller('public/config')
export class PublicConfigController {
  constructor(private readonly settings: SystemConfigService) {}

  @Public()
  @Get()
  get() {
    return this.settings.publicSettings();
  }
}

@ApiTags('Admin · System configuration')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: SystemConfigService) {}

  @Get()
  @AdminOnly(PERMISSIONS.SETTINGS_MANAGE)
  @ApiEnvelope(SettingResponse, { isArray: true })
  list() {
    return this.settings.list();
  }

  @Put(':key')
  @AdminOnly(PERMISSIONS.SETTINGS_MANAGE)
  @ApiEnvelope(SettingResponse)
  set(@Param() p: KeyParam, @Body() dto: UpsertSettingDto, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.settings.set(p.key, dto, user.id, ctx);
  }

  @Delete(':key')
  @AdminOnly(PERMISSIONS.SETTINGS_MANAGE)
  remove(@Param() p: KeyParam, @CurrentUser() user: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.settings.remove(p.key, user.id, ctx);
  }
}

@Global()
@Module({
  controllers: [PublicConfigController, AdminSettingsController],
  providers: [SystemConfigService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
