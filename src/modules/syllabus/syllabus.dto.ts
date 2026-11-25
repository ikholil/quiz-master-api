import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PublishStatus, TopicRelationType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SubjectDto {
  @Matches(SLUG) @MaxLength(60) slug: string;
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(120) nameBn?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class ChapterDto {
  @IsUUID() subjectId: string;
  @Matches(SLUG) @MaxLength(80) slug: string;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(160) nameBn?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class TopicDto {
  @IsUUID() chapterId: string;
  @Matches(SLUG) @MaxLength(80) slug: string;
  @IsString() @MaxLength(160) name: string;
  @IsOptional() @IsString() @MaxLength(160) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateNodeDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(160) nameBn?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class TopicRelationDto {
  @IsUUID() fromTopicId: string;
  @IsUUID() toTopicId: string;
  @ApiProperty({ enum: TopicRelationType }) @IsEnum(TopicRelationType) type: TopicRelationType;
}

export class SyllabusVersionDto {
  @IsUUID() examId: string;
  @IsOptional() @IsUUID() stageId?: string;
  @IsString() @MaxLength(60) label: string;
  @IsOptional() @IsISO8601({ strict: true }) effectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  /** Copy topic mappings from an existing version (new circulars usually change only a few topics). */
  @IsOptional() @IsUUID() copyFromVersionId?: string;
}

export class TopicMappingItemDto {
  @IsUUID() topicId: string;
  /** Relative priority 0..1 used by the adaptive engine. */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1) weight: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) marks?: number;
}

export class SetMappingsDto {
  @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => TopicMappingItemDto) items: TopicMappingItemDto[];
  /** When true, mappings not listed are removed. */
  @IsOptional() replace?: boolean;
}

export class SyllabusStatusDto {
  @ApiProperty({ enum: PublishStatus }) @IsEnum(PublishStatus) status: PublishStatus;
}

export class SyllabusTopicNode {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiProperty() weight: number;
  @ApiPropertyOptional({ nullable: true }) marks: number | null;
}
export class SyllabusChapterNode {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiProperty({ type: [SyllabusTopicNode] }) topics: SyllabusTopicNode[];
}
export class SyllabusSubjectNode {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true }) nameBn: string | null;
  @ApiProperty() totalMarks: number;
  @ApiProperty({ type: [SyllabusChapterNode] }) chapters: SyllabusChapterNode[];
}
export class SyllabusTreeResponse {
  @ApiProperty() versionId: string;
  @ApiProperty() examId: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional({ nullable: true }) effectiveFrom: Date | null;
  @ApiPropertyOptional({ nullable: true }) stageId: string | null;
  @ApiProperty() topicCount: number;
  @ApiProperty({ type: [SyllabusSubjectNode] }) subjects: SyllabusSubjectNode[];
}
