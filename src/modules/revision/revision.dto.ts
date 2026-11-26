import { ApiPropertyOptional } from '@nestjs/swagger';
import { RevisionItemType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class DueQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @ApiPropertyOptional({ enum: RevisionItemType })
  @IsOptional()
  @IsEnum(RevisionItemType)
  type?: RevisionItemType;
}

export class ReviewItemDto {
  /** 0 = forgot completely … 5 = perfect recall */
  @IsInt() @Min(0) @Max(5) quality: number;
}

export class FlashcardDto {
  @IsString() @MinLength(1) @MaxLength(2000) front: string;
  @IsString() @MinLength(1) @MaxLength(5000) back: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsString() @MaxLength(60) deck?: string;
  /** Staff only: publish as a system card visible to every student. */
  @IsOptional() @IsBoolean() isPublic?: boolean;
}

export class UpdateFlashcardDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) front?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(5000) back?: string;
  @IsOptional() @IsString() @MaxLength(60) deck?: string;
}

export class FlashcardQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['mine', 'public', 'all']) scope?: 'mine' | 'public' | 'all';
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsString() @MaxLength(60) deck?: string;
}

export class StudyCardsDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true }) flashcardIds: string[];
}
