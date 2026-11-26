import { ApiPropertyOptional } from '@nestjs/swagger';
import { StudyPlanStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateStudyPlanDto {
  @IsUUID() examId: string;
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  /** YYYY-MM-DD (exam date, if known) */
  @IsOptional() @IsISO8601({ strict: true }) targetDate?: string;
  @IsOptional() @IsInt() @Min(15) @Max(720) dailyMinutes?: number;
  /** Days of week (0 = Sunday … 6 = Saturday) the student studies. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  studyDays?: number[];
}

export class UpdateStudyPlanDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsISO8601({ strict: true }) targetDate?: string;
  @IsOptional() @IsInt() @Min(15) @Max(720) dailyMinutes?: number;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  studyDays?: number[];
  @ApiPropertyOptional({
    enum: [
      StudyPlanStatus.ACTIVE,
      StudyPlanStatus.PAUSED,
      StudyPlanStatus.COMPLETED,
      StudyPlanStatus.ARCHIVED,
    ],
  })
  @IsOptional()
  @IsIn(Object.values(StudyPlanStatus))
  status?: StudyPlanStatus;
}

export class RescheduleTaskDto {
  @IsISO8601({ strict: true }) date: string;
}

export class TaskRangeQueryDto {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}
