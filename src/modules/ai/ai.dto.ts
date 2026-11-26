import { ApiPropertyOptional } from '@nestjs/swagger';
import { Difficulty } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateConversationDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() topicId?: string;
}

export class SendMessageDto {
  @IsString() @MinLength(1) @MaxLength(4000) content: string;
}

export class FeedbackDto {
  @IsIn([-1, 1]) rating: -1 | 1;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class GenerateQuestionsDto {
  @IsUUID() topicId: string;
  @IsInt() @Min(1) @Max(20) count: number;
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsOptional() @IsIn(['bn', 'en']) language?: 'bn' | 'en';
}

export class PromptTemplateDto {
  @Matches(/^[a-z0-9_.-]{3,60}$/) key: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsString() @MinLength(10) @MaxLength(20000) system: string;
  @IsString() @MaxLength(5000) userTemplate: string;
}

export class UsageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}
