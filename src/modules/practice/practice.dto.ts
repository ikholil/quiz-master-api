import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Difficulty, PracticeMode } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePracticeDto {
  @ApiProperty({ enum: PracticeMode }) @IsEnum(PracticeMode) mode: PracticeMode;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('4', { each: true }) topicIds?: string[];
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsInt() @Min(5) @Max(100) questionCount: number;
  /** Show correctness + explanation right after each answer (default true). */
  @IsOptional() @IsBoolean() instantFeedback?: boolean;
}

export class PracticeAnswerDto {
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsUUID('4', { each: true }) selectedOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(2000) textAnswer?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) timeSpentMs?: number;
}
