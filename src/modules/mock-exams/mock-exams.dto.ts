import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccessLevel, Difficulty, MultiSelectPolicy, PublishStatus, QuestionType, ResultVisibility, SelectionMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { PaginationQueryDto } from '../../common/dto/pagination.dto';

export class DifficultyMixDto {
  @IsOptional() @IsNumber() @Min(0) @Max(1) EASY?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) MEDIUM?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) HARD?: number;
}

export class SectionConfigDto {
  @IsString() @MaxLength(120) title: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('4', { each: true }) topicIds?: string[];
  /** Restrict the pool to these question types (default: all auto-graded types). */
  @ApiPropertyOptional({ enum: QuestionType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(QuestionType, { each: true })
  questionTypes?: QuestionType[];
  @IsOptional() @ValidateNested() @Type(() => DifficultyMixDto) difficultyMix?: DifficultyMixDto;
  @ApiProperty({ enum: SelectionMode }) @IsEnum(SelectionMode) selectionMode: SelectionMode;
  @IsInt() @Min(1) @Max(500) questionCount: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.25) @Max(100) marksPerQuestion: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) negativeMarks: number;
  /** FIXED sections: exact question ids (pinned to their published version on publish). */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true }) questionIds?: string[];
}

export class MockConfigDto {
  @IsInt() @Min(1) @Max(600) durationMinutes: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) passMarks?: number;
  @IsOptional() @IsBoolean() shuffleQuestions?: boolean;
  @IsOptional() @IsBoolean() shuffleOptions?: boolean;
  @ApiPropertyOptional({ enum: MultiSelectPolicy }) @IsOptional() @IsEnum(MultiSelectPolicy) multiSelectPolicy?: MultiSelectPolicy;
  @IsOptional() @IsBoolean() allowNegativeTotal?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxAttempts?: number;
  @ApiPropertyOptional({ enum: ResultVisibility }) @IsOptional() @IsEnum(ResultVisibility) resultVisibility?: ResultVisibility;
  /** Live/scheduled exams: attempts may start only inside this window. */
  @IsOptional() @IsISO8601() availableFrom?: string;
  @IsOptional() @IsISO8601() availableUntil?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SectionConfigDto) sections: SectionConfigDto[];
}

export class CreateMockTemplateDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) @MaxLength(100) slug: string;
  @IsString() @MaxLength(200) title: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsUUID() examId: string;
  @IsOptional() @IsUUID() stageId?: string;
  @ApiPropertyOptional({ enum: AccessLevel }) @IsOptional() @IsEnum(AccessLevel) accessLevel?: AccessLevel;
  @IsOptional() @IsBoolean() isDemo?: boolean;
  @ValidateNested() @Type(() => MockConfigDto) config: MockConfigDto;
}

export class UpdateMockTemplateDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleBn?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @ApiPropertyOptional({ enum: AccessLevel }) @IsOptional() @IsEnum(AccessLevel) accessLevel?: AccessLevel;
  /** Edits the draft only; students see changes after the next publish (existing attempts keep their rules). */
  @IsOptional() @ValidateNested() @Type(() => MockConfigDto) config?: MockConfigDto;
}

export class MockQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() examId?: string;
  @IsOptional() @IsUUID() stageId?: string;
  @ApiPropertyOptional({ enum: AccessLevel }) @IsOptional() @IsEnum(AccessLevel) accessLevel?: AccessLevel;
  @ApiPropertyOptional({ enum: PublishStatus }) @IsOptional() @IsEnum(PublishStatus) status?: PublishStatus;
}

export class MockSectionSummary {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() sequence: number;
  @ApiProperty() questionCount: number;
  @ApiProperty() marksPerQuestion: number;
  @ApiProperty() negativeMarks: number;
}

export class MockExamSummary {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() title: string;
  @ApiPropertyOptional({ nullable: true }) titleBn: string | null;
  @ApiProperty() examId: string;
  @ApiProperty({ enum: AccessLevel }) accessLevel: AccessLevel;
  @ApiProperty() isDemo: boolean;
  @ApiProperty() durationMinutes: number;
  @ApiProperty() totalMarks: number;
  @ApiProperty() questionCount: number;
  @ApiPropertyOptional({ nullable: true }) availableFrom: Date | null;
  @ApiPropertyOptional({ nullable: true }) availableUntil: Date | null;
  @ApiProperty({ description: 'False when a premium entitlement is required' }) unlocked: boolean;
  @ApiProperty() attemptsUsed: number;
  @ApiPropertyOptional({ nullable: true }) maxAttempts: number | null;
  @ApiPropertyOptional({ nullable: true }) activeAttemptId: string | null;
}

export class MockExamDetail extends MockExamSummary {
  @ApiPropertyOptional({ nullable: true }) description: string | null;
  @ApiProperty() versionId: string;
  @ApiPropertyOptional({ nullable: true }) passMarks: number | null;
  @ApiProperty({ enum: MultiSelectPolicy }) multiSelectPolicy: MultiSelectPolicy;
  @ApiProperty({ enum: ResultVisibility }) resultVisibility: ResultVisibility;
  @ApiProperty({ type: [MockSectionSummary] }) sections: MockSectionSummary[];
}

export { Difficulty };
