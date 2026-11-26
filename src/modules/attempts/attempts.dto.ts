import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttemptStatus, EvaluationStatus, ResultStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { StudentQuestionView } from '../questions/questions.dto';

export class SaveAnswerDto {
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsUUID('4', { each: true }) selectedOptionIds?: string[];
  @IsOptional() @IsString() @MaxLength(20000) textAnswer?: string | null;
  @IsOptional() @IsBoolean() flagged?: boolean;
  /** Client-measured time spent on this question since the last save (ms). Capped server-side. */
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) timeSpentMs?: number;
}

export class BatchAnswerItemDto extends SaveAnswerDto {
  @IsUUID() answerId: string;
}

export class BatchSaveAnswersDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BatchAnswerItemDto)
  answers: BatchAnswerItemDto[];
}

export class AttemptQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AttemptStatus }) @IsOptional() @IsEnum(AttemptStatus) status?: AttemptStatus;
  @IsOptional() @IsUUID() templateId?: string;
}

export class AdminAttemptQueryDto extends AttemptQueryDto {
  @IsOptional() @IsUUID() userId?: string;
}

export class EvaluationQueueQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() templateId?: string;
}

export class EvaluateAnswerDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) awardedMarks: number;
  @IsOptional() @IsString() @MaxLength(5000) comment?: string;
}

// ───────── Responses ─────────

export class AttemptQuestionView extends StudentQuestionView {
  @ApiProperty() answerId: string;
  @ApiProperty() position: number;
  @ApiProperty() sectionId: string;
  @ApiProperty() maxMarks: number;
  @ApiProperty() negativeMarks: number;
  @ApiProperty({ type: [String] }) selectedOptionIds: string[];
  @ApiPropertyOptional({ nullable: true }) textAnswer: string | null;
  @ApiProperty() flagged: boolean;
}

export class AttemptSectionView {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() sequence: number;
  @ApiProperty() questionCount: number;
}

export class AttemptStateResponse {
  @ApiProperty() id: string;
  @ApiProperty() templateId: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: AttemptStatus }) status: AttemptStatus;
  @ApiProperty() attemptNumber: number;
  @ApiProperty() startedAt: Date;
  @ApiProperty() expiresAt: Date;
  @ApiProperty({
    description:
      'Authoritative server time; clients must derive the countdown from this, not the device clock',
  })
  serverTime: Date;
  @ApiProperty() remainingSeconds: number;
  @ApiProperty() durationMinutes: number;
  @ApiProperty() totalMarks: number;
  @ApiProperty({ type: [AttemptSectionView] }) sections: AttemptSectionView[];
  @ApiProperty({ type: [AttemptQuestionView] }) questions: AttemptQuestionView[];
  @ApiProperty() answeredCount: number;
}

export class SectionResultView {
  @ApiProperty() sectionId: string;
  @ApiProperty() title: string;
  @ApiProperty() maxMarks: number;
  @ApiProperty() obtainedMarks: number;
  @ApiProperty() correct: number;
  @ApiProperty() partial: number;
  @ApiProperty() wrong: number;
  @ApiProperty() skipped: number;
  @ApiProperty() pending: number;
}

export class AttemptResultResponse {
  @ApiProperty() attemptId: string;
  @ApiProperty({ enum: AttemptStatus }) attemptStatus: AttemptStatus;
  @ApiProperty({ enum: ResultStatus }) status: ResultStatus;
  @ApiProperty() totalMarks: number;
  @ApiProperty() obtainedMarks: number;
  @ApiProperty() correctCount: number;
  @ApiProperty() wrongCount: number;
  @ApiProperty() skippedCount: number;
  @ApiProperty() pendingCount: number;
  @ApiProperty() accuracy: number;
  @ApiPropertyOptional({ nullable: true }) passed: boolean | null;
  @ApiProperty() timeTakenSeconds: number;
  @ApiProperty({ type: [SectionResultView] }) sections: SectionResultView[];
  @ApiPropertyOptional({ nullable: true }) rank: number | null;
  @ApiPropertyOptional({ nullable: true }) percentile: number | null;
  @ApiProperty() participants: number;
  @ApiProperty() scoringVersion: string;
  @ApiProperty() evaluatedAt: Date;
}

export class ReviewItemView extends AttemptQuestionView {
  @ApiProperty({ type: [String] }) correctOptionIds: string[];
  @ApiProperty({ type: [String] }) acceptedAnswers: string[];
  @ApiPropertyOptional({ nullable: true }) explanation: string | null;
  @ApiPropertyOptional({ nullable: true }) explanationBn: string | null;
  @ApiPropertyOptional({ nullable: true }) isCorrect: boolean | null;
  @ApiPropertyOptional({ nullable: true }) awardedMarks: number | null;
  @ApiProperty({ enum: EvaluationStatus }) evaluationStatus: EvaluationStatus;
  @ApiPropertyOptional({ nullable: true }) evaluatorComment: string | null;
}

export class AttemptHistoryItem {
  @ApiProperty() id: string;
  @ApiProperty() templateId: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: AttemptStatus }) status: AttemptStatus;
  @ApiProperty() attemptNumber: number;
  @ApiProperty() startedAt: Date;
  @ApiPropertyOptional({ nullable: true }) submittedAt: Date | null;
  @ApiPropertyOptional({ nullable: true }) obtainedMarks: number | null;
  @ApiProperty() totalMarks: number;
  @ApiPropertyOptional({ nullable: true }) accuracy: number | null;
}
