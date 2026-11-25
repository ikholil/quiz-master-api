import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KnowledgeSourceStatus, KnowledgeVisibility } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUrl, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SearchPaginationQueryDto } from '../../common/dto/pagination.dto';
import { ALL_FEATURES } from '../subscriptions/features';

export class CreateKnowledgeSourceDto {
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() fileId?: string;
  /** Inline text (alternative to fileId). */
  @IsOptional() @IsString() @MaxLength(2_000_000) rawText?: string;
  @IsOptional() @IsIn(['text/plain', 'text/markdown', 'text/html', 'application/json']) mimeType?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @ApiPropertyOptional({ enum: KnowledgeVisibility }) @IsOptional() @IsEnum(KnowledgeVisibility) visibility?: KnowledgeVisibility;
  @ApiPropertyOptional({ enum: ALL_FEATURES }) @IsOptional() @IsIn(ALL_FEATURES) requiredFeature?: string;
  /** e.g. official syllabus or circular copied from the authority's website. */
  @IsOptional() @IsBoolean() isAuthoritative?: boolean;
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
}

export class UpdateKnowledgeSourceDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @ApiPropertyOptional({ enum: KnowledgeVisibility }) @IsOptional() @IsEnum(KnowledgeVisibility) visibility?: KnowledgeVisibility;
  @ApiPropertyOptional({ enum: ALL_FEATURES }) @IsOptional() @IsIn(ALL_FEATURES) requiredFeature?: string;
  @IsOptional() @IsBoolean() isAuthoritative?: boolean;
  @IsOptional() @IsUrl({ require_protocol: true }) sourceUrl?: string;
}

export class KnowledgeQueryDto extends SearchPaginationQueryDto {
  @ApiPropertyOptional({ enum: KnowledgeSourceStatus }) @IsOptional() @IsEnum(KnowledgeSourceStatus) status?: KnowledgeSourceStatus;
  @ApiPropertyOptional({ enum: KnowledgeVisibility }) @IsOptional() @IsEnum(KnowledgeVisibility) visibility?: KnowledgeVisibility;
  @IsOptional() @IsUUID() examId?: string;
}

export class RetrievalTestDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(1000) query: string;
  @IsOptional() @IsUUID() examId?: string;
}
