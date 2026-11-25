import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Job } from 'bullmq';
import { IsOptional, IsUUID } from 'class-validator';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthUser } from '../../common/types/auth-user';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { RevisionService } from '../revision/revision.service';
import { StudyPlansService } from '../study-plans/study-plans.service';
import { LearningService } from './learning.service';

class ExamQuery {
  @IsUUID() examId: string;
}
class OptionalExamQuery {
  @IsOptional() @IsUUID() examId?: string;
}

export class PriorityFactorView {
  @ApiProperty() key: string;
  @ApiProperty() value: number;
  @ApiProperty() weight: number;
  @ApiProperty() contribution: number;
  @ApiProperty() label: string;
}
export class TopicRecommendationView {
  @ApiProperty() topicId: string;
  @ApiProperty() topicName: string;
  @ApiProperty() score: number;
  @ApiProperty() masteryScore: number;
  @ApiProperty() reason: string;
  @ApiProperty({ type: [PriorityFactorView] }) factors: PriorityFactorView[];
}
export class RecommendationsResponse {
  @ApiProperty() examId: string;
  @ApiProperty() syllabusCoverage: number;
  @ApiProperty({ type: [TopicRecommendationView] }) nextTopics: TopicRecommendationView[];
  @ApiProperty({ type: Object, isArray: true }) weakTopics: unknown[];
  @ApiPropertyOptional({ type: Object, nullable: true }) mockExam: unknown;
}

@ApiTags('Adaptive learning')
@Authenticated()
@Controller('learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('recommendations')
  @ApiOperation({ summary: 'Explainable next-topic, weak-topic and mock recommendations (no AI dependency)' })
  recommendations(@CurrentUser() user: AuthUser, @Query() q: ExamQuery): Promise<RecommendationsResponse> {
    return this.learning.recommendations(user.id, q.examId);
  }

  @Get('mastery')
  mastery(@CurrentUser() user: AuthUser, @Query() q: OptionalExamQuery) {
    return this.learning.masteryOverview(user.id, q.examId);
  }
}

@Processor(QUEUES.LEARNING, { concurrency: 4 })
export class LearningProcessor extends WorkerHost {
  constructor(
    private readonly learning: LearningService,
    private readonly plans: StudyPlansService,
    private readonly revision: RevisionService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case JOBS.UPDATE_MASTERY:
        if (job.data.source === 'attempt') return this.learning.processAttempt(job.data.id as string);
        return undefined;
      case JOBS.GENERATE_DAILY_PLANS:
        return this.plans.generateForAllActive();
      case JOBS.REVISION_REMINDERS:
        return this.revision.sendDueReminders();
      default:
        return undefined;
    }
  }
}

@Global()
@Module({
  controllers: [LearningController],
  providers: [LearningService, ...workers(LearningProcessor)],
  exports: [LearningService],
})
export class LearningModule {}
