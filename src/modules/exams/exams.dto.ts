import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublishStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SearchPaginationQueryDto } from '../../common/dto/pagination.dto';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateCategoryDto {
  @Matches(SLUG) @MaxLength(60) slug: string;
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(100) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class CreateAuthorityDto {
  @Matches(SLUG) @MaxLength(60) slug: string;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(160) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(20) shortName?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) website?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class CreateExamDto {
  @Matches(SLUG) @MaxLength(80) slug: string;
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(200) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(30) shortName?: string;
  @IsUUID() categoryId: string;
  @IsOptional() @IsUUID() authorityId?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** Structured eligibility (age limits, education, quota) taken from the official circular. */
  @IsOptional() @IsObject() eligibility?: Record<string, unknown>;
  @IsOptional() @IsObject() pattern?: Record<string, unknown>;
  @IsOptional() @IsUrl({ require_protocol: true }) officialUrl?: string;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
export class UpdateExamDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(30) shortName?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() authorityId?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsObject() eligibility?: Record<string, unknown>;
  @IsOptional() @IsObject() pattern?: Record<string, unknown>;
  @IsOptional() @IsUrl({ require_protocol: true }) officialUrl?: string;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class StageDto {
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(100) nameBn?: string;
  @IsInt() @Min(1) @Max(20) sequence: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalMarks?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1440) durationMinutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) passMarks?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10) negativeMarking?: number;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class NoticeDto {
  @IsString() @MinLength(3) @MaxLength(300) title: string;
  @IsString() @MaxLength(20000) body: string;
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
  @IsOptional() @IsUUID() fileId?: string;
  @IsOptional() @IsISO8601({ strict: true }) noticeDate?: string;
  /** Must only be true when copied from the recruiting authority's own publication. */
  @IsOptional() @IsBoolean() isOfficial?: boolean;
}

export class PaperDto {
  @IsInt() @Min(1970) @Max(2100) year: number;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(500) sourceReference?: string;
  @IsOptional() @IsUUID() fileId?: string;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class ExamQueryDto extends SearchPaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsString() @MaxLength(60) authority?: string;
  @IsOptional() @IsIn(['true', 'false']) featured?: string;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class CategoryResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() examCount: number;
}

export class ExamSummaryResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiPropertyOptional({ nullable: true }) shortName: string | null;
  @ApiProperty() categorySlug: string;
  @ApiPropertyOptional({ nullable: true }) authorityName: string | null;
  @ApiProperty() isFeatured: boolean;
  @ApiProperty({ enum: PublishStatus }) status: PublishStatus;
}

export class StageResponse {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiProperty() sequence: number;
  @ApiPropertyOptional({ nullable: true }) totalMarks: number | null;
  @ApiPropertyOptional({ nullable: true }) durationMinutes: number | null;
  @ApiPropertyOptional({ nullable: true }) passMarks: number | null;
  @ApiPropertyOptional({ nullable: true }) negativeMarking: number | null;
  @ApiPropertyOptional({ nullable: true }) description: string | null;
}

export class ExamDetailResponse extends ExamSummaryResponse {
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) eligibility: unknown;
  @ApiPropertyOptional({ type: Object, nullable: true }) pattern: unknown;
  @ApiPropertyOptional({ nullable: true }) officialUrl: string | null;
  @ApiProperty({ type: [StageResponse] }) stages: StageResponse[];
  @ApiPropertyOptional({ nullable: true }) currentSyllabusVersionId: string | null;
  @ApiProperty() isBookmarked: boolean;
}

export class NoticeResponse {
  @ApiProperty() id: string;
  @ApiProperty() examId: string;
  @ApiProperty() title: string;
  @ApiProperty() body: string;
  @ApiPropertyOptional({ nullable: true }) sourceUrl: string | null;
  @ApiPropertyOptional({ nullable: true }) fileId: string | null;
  @ApiPropertyOptional({ nullable: true }) noticeDate: Date | null;
  @ApiProperty() isOfficial: boolean;
  @ApiPropertyOptional({ nullable: true }) publishedAt: Date | null;
}

export class PaperResponse {
  @ApiProperty() id: string;
  @ApiProperty() year: number;
  @ApiProperty() title: string;
  @ApiPropertyOptional({ nullable: true }) sourceReference: string | null;
  @ApiPropertyOptional({ nullable: true }) fileId: string | null;
  @ApiProperty() questionCount: number;
}

export class IdParam {
  @IsUUID() id: string;
}
export { Type };
