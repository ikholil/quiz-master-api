import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContentStatus,
  Difficulty,
  QuestionSourceType,
  QuestionType,
  ReportStatus,
  ReviewDecision,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto, SearchPaginationQueryDto } from '../../common/dto/pagination.dto';

export class OptionDto {
  @Matches(/^[A-Ha-h]$/) key: string;
  @IsString() @MaxLength(2000) text: string;
  @IsOptional() @IsString() @MaxLength(2000) textBn?: string;
  @IsOptional() @IsUUID() imageFileId?: string;
  @IsBoolean() isCorrect: boolean;
}

export class ExplanationDto {
  @IsString() @MinLength(2) @MaxLength(20000) content: string;
  @IsOptional() @IsString() @MaxLength(20000) contentBn?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  references?: string[];
}

export class QuestionContentDto {
  @IsString() @MinLength(2) @MaxLength(10000) stem: string;
  @IsOptional() @IsString() @MaxLength(10000) stemBn?: string;
  @IsOptional() @IsUUID() imageFileId?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.25) @Max(100) defaultMarks?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options?: OptionDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  acceptedAnswers?: string[];
  @IsOptional() @IsString() @MaxLength(10000) rubric?: string;
  @IsOptional() @ValidateNested() @Type(() => ExplanationDto) explanation?: ExplanationDto;
}

export class CreateQuestionDto {
  @ApiProperty({ enum: QuestionType }) @IsEnum(QuestionType) type: QuestionType;
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsUUID() subjectId: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('4', { each: true }) extraTopicIds?: string[];
  /** Passage-based questions share a stem passage. */
  @IsOptional() @IsUUID() passageId?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true }) examIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
  /** Demonstration content (seed/sample data). Never presented as an official paper. */
  @IsOptional() @IsBoolean() isDemo?: boolean;
  @IsOptional() @IsBoolean() aiGenerated?: boolean;
  @ValidateNested() @Type(() => QuestionContentDto) content: QuestionContentDto;
}

export class UpdateQuestionDto {
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsUUID('4', { each: true }) extraTopicIds?: string[];
  @IsOptional() @IsUUID() passageId?: string;
  @IsOptional() @IsUUID() sourceId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('4', { each: true }) examIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];
  /** New content creates a new version (or replaces an unpublished draft). */
  @IsOptional() @ValidateNested() @Type(() => QuestionContentDto) content?: QuestionContentDto;
  @IsOptional() @IsString() @MaxLength(500) changeNote?: string;
}

export class ReviewDto {
  @ApiProperty({ enum: ReviewDecision }) @IsEnum(ReviewDecision) decision: ReviewDecision;
  @IsOptional() @IsString() @MaxLength(5000) comments?: string;
}

export class PassageDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsString() @MinLength(10) @MaxLength(30000) content: string;
  @IsOptional() @IsUUID() imageFileId?: string;
}

export class SourceDto {
  @ApiProperty({ enum: QuestionSourceType }) @IsEnum(QuestionSourceType) type: QuestionSourceType;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsInt() @Min(1970) @Max(2100) year?: number;
  @IsOptional() @IsUUID() paperId?: string;
  @IsOptional() @IsString() @MaxLength(500) reference?: string;
  @IsOptional() @IsBoolean() isOfficial?: boolean;
}

export class AdminQuestionQueryDto extends SearchPaginationQueryDto {
  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @ApiPropertyOptional({ enum: QuestionType }) @IsOptional() @IsEnum(QuestionType) type?: QuestionType;
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsString() @MaxLength(40) tag?: string;
  @ApiPropertyOptional({ enum: QuestionSourceType })
  @IsOptional()
  @IsEnum(QuestionSourceType)
  sourceType?: QuestionSourceType;
  @IsOptional() @IsIn(['true', 'false']) aiGenerated?: string;
  @IsOptional() @IsIn(['true', 'false']) isDemo?: string;
  @IsOptional() @IsIn(['createdAt', 'updatedAt', 'timesAnswered']) sortBy?:
    'createdAt' | 'updatedAt' | 'timesAnswered';
}

export class PublicQuestionQueryDto extends SearchPaginationQueryDto {
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsUUID() topicId?: string;
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() paperId?: string;
  @ApiPropertyOptional({ enum: Difficulty }) @IsOptional() @IsEnum(Difficulty) difficulty?: Difficulty;
}

export class CreateReportDto {
  @IsIn(['WRONG_ANSWER', 'TYPO', 'UNCLEAR', 'OUTDATED', 'DUPLICATE', 'OTHER']) reason: string;
  @IsOptional() @IsString() @MaxLength(2000) details?: string;
}

export class ResolveReportDto {
  @ApiProperty({ enum: [ReportStatus.RESOLVED, ReportStatus.DISMISSED, ReportStatus.IN_REVIEW] })
  @IsIn([ReportStatus.RESOLVED, ReportStatus.DISMISSED, ReportStatus.IN_REVIEW])
  status: ReportStatus;
  @IsOptional() @IsString() @MaxLength(2000) resolution?: string;
}

export class ReportQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReportStatus }) @IsOptional() @IsEnum(ReportStatus) status?: ReportStatus;
}

export class ImportQuestionsDto {
  @IsUUID() fileId: string;
  @IsIn(['csv', 'json']) format: 'csv' | 'json';
  /** Submit imported questions straight to review instead of leaving them as drafts. */
  @IsOptional() @IsBoolean() submitForReview?: boolean;
}

// ───────── Responses ─────────

export class StudentOptionView {
  @ApiProperty() id: string;
  @ApiProperty() text: string;
  @ApiPropertyOptional({ nullable: true }) textBn: string | null;
  @ApiPropertyOptional({ nullable: true }) imageFileId: string | null;
}

export class PassageView {
  @ApiProperty() id: string;
  @ApiPropertyOptional({ nullable: true }) title: string | null;
  @ApiProperty() content: string;
  @ApiPropertyOptional({ nullable: true }) imageFileId: string | null;
}

/** Student-facing question: never contains correctness, accepted answers or rubric. */
export class StudentQuestionView {
  @ApiProperty() questionId: string;
  @ApiProperty() versionId: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: QuestionType }) type: QuestionType;
  @ApiProperty({ enum: Difficulty }) difficulty: Difficulty;
  @ApiProperty() stem: string;
  @ApiPropertyOptional({ nullable: true }) stemBn: string | null;
  @ApiPropertyOptional({ nullable: true }) imageFileId: string | null;
  @ApiPropertyOptional({ type: PassageView, nullable: true }) passage: PassageView | null;
  @ApiProperty({ type: [StudentOptionView] }) options: StudentOptionView[];
  @ApiProperty() subjectId: string;
  @ApiPropertyOptional({ nullable: true }) topicId: string | null;
  @ApiProperty() isDemo: boolean;
  @ApiPropertyOptional({ nullable: true, description: 'e.g. "BCS 2019" for previous-year questions' })
  sourceLabel: string | null;
}

export class AnswerKeyView {
  @ApiProperty({ type: [String] }) correctOptionIds: string[];
  @ApiProperty({ type: [String] }) acceptedAnswers: string[];
  @ApiPropertyOptional({ nullable: true }) explanation: string | null;
  @ApiPropertyOptional({ nullable: true }) explanationBn: string | null;
  @ApiProperty({ type: [String] }) references: string[];
}

export class AdminQuestionListItem {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: QuestionType }) type: QuestionType;
  @ApiProperty({ enum: Difficulty }) difficulty: Difficulty;
  @ApiProperty({ enum: ContentStatus }) status: ContentStatus;
  @ApiProperty() stem: string;
  @ApiProperty() subjectName: string;
  @ApiPropertyOptional({ nullable: true }) topicName: string | null;
  @ApiProperty() latestVersionNumber: number;
  @ApiProperty({ enum: ContentStatus }) latestVersionStatus: ContentStatus;
  @ApiPropertyOptional({ nullable: true }) publishedVersionNumber: number | null;
  @ApiProperty() isDemo: boolean;
  @ApiProperty() aiGenerated: boolean;
  @ApiProperty() timesAnswered: number;
  @ApiProperty() accuracy: number | null;
  @ApiProperty() updatedAt: Date;
}
