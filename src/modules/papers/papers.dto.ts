import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnswerKeyType, PaperVerification, PublishStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class CreatePaperDto {
  @IsUUID() examId: string;
  @IsOptional() @IsUUID() stageId?: string;
  @IsInt() @Min(1970) @Max(2100) year: number;
  @IsString() @MaxLength(200) title: string;
  /** Where the paper came from (publication, archive reference). */
  @IsOptional() @IsString() @MaxLength(500) sourceReference?: string;
  @IsOptional() @IsISO8601({ strict: true }) heldOn?: string;
  @IsOptional() @IsInt() @Min(1) @Max(600) durationMinutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalMarks?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10) negativeMarking?: number;
  @IsOptional() @IsUUID() fileId?: string;
}

export class UpdatePaperDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(500) sourceReference?: string;
  @IsOptional() @IsISO8601({ strict: true }) heldOn?: string;
  @IsOptional() @IsInt() @Min(1) @Max(600) durationMinutes?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) totalMarks?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10) negativeMarking?: number;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class PaperQuestionItemDto {
  @IsUUID() questionId: string;
  @IsInt() @Min(1) @Max(1000) questionNumber: number;
  @IsOptional() @IsString() @MaxLength(80) section?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) marks?: number;
}

export class AttachQuestionsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PaperQuestionItemDto)
  items: PaperQuestionItemDto[];
}

export class ImportPaperDto {
  @IsUUID() fileId: string;
  @IsIn(['csv', 'json']) format: 'csv' | 'json';
  /** Default true: imported questions enter the review queue. */
  @IsOptional() @IsBoolean() submitForReview?: boolean;
}

export class VerifyPaperDto {
  @ApiProperty({ enum: PaperVerification }) @IsEnum(PaperVerification) status: PaperVerification;
  @ApiPropertyOptional({ enum: AnswerKeyType })
  @IsOptional()
  @IsEnum(AnswerKeyType)
  answerKeyType?: AnswerKeyType;
  @IsOptional() @IsUrl({ require_protocol: true }) evidenceUrl?: string;
  @IsOptional() @IsUUID() evidenceFileId?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class DisputeDto {
  @IsBoolean() answerDisputed: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class PaperQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @Type(() => Number) @IsInt() year?: number;
  @ApiPropertyOptional({ enum: PaperVerification })
  @IsOptional()
  @IsEnum(PaperVerification)
  verificationStatus?: PaperVerification;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class FrequencyQueryDto {
  @IsOptional() @IsIn(['true', 'false']) verifiedOnly?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) years?: number;
}
