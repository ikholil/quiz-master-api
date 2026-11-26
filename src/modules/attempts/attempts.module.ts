import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientPlatform } from '@prisma/client';
import { Job } from 'bullmq';
import { IsEnum, IsOptional } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelope, ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import {
  AdminAttemptQueryDto,
  AttemptHistoryItem,
  AttemptQueryDto,
  AttemptResultResponse,
  AttemptStateResponse,
  BatchSaveAnswersDto,
  EvaluateAnswerDto,
  EvaluationQueueQueryDto,
  ReviewItemView,
  SaveAnswerDto,
} from './attempts.dto';
import { AttemptsService } from './attempts.service';

class StartAttemptDto {
  @IsOptional() @IsEnum(ClientPlatform) platform?: ClientPlatform;
}

@ApiTags('Exam attempts')
@Authenticated()
@Controller()
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Post('mock-exams/:templateId/attempts')
  @ApiOperation({ summary: 'Start (or resume) an attempt. Server time and expiry are authoritative.' })
  @ApiEnvelope(AttemptStateResponse, { status: 201 })
  start(
    @CurrentUser() user: AuthUser,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: StartAttemptDto,
  ) {
    return this.attempts.start(user, templateId, dto.platform);
  }

  @Get('attempts')
  @ApiPaginated(AttemptHistoryItem)
  history(@CurrentUser() user: AuthUser, @Query() q: AttemptQueryDto) {
    return this.attempts.history(user.id, q);
  }

  @Get('attempts/:id')
  @ApiEnvelope(AttemptStateResponse)
  state(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.getState(user.id, id);
  }

  @Put('attempts/:id/answers/:answerId')
  saveOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('answerId', ParseUUIDPipe) answerId: string,
    @Body() dto: SaveAnswerDto,
  ) {
    return this.attempts.saveAnswer(user.id, id, answerId, dto);
  }

  @Put('attempts/:id/answers')
  @ApiOperation({ summary: 'Batch save (offline sync); all-or-nothing' })
  saveMany(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BatchSaveAnswersDto,
  ) {
    return this.attempts.saveAnswers(user.id, id, dto.answers);
  }

  @Post('attempts/:id/submit')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated key; retries return the same result',
  })
  @ApiOperation({ summary: 'Submit and score the attempt (idempotent)' })
  @ApiEnvelope(AttemptResultResponse)
  submit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw AppError.badRequest(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8-100 URL-safe characters',
      );
    return this.attempts.submit(user.id, id, key);
  }

  @Get('attempts/:id/result')
  @ApiEnvelope(AttemptResultResponse)
  result(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.getResult(user.id, id);
  }

  @Get('attempts/:id/review')
  @ApiEnvelope(ReviewItemView, { isArray: true })
  review(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.review(user.id, id);
  }
}

@ApiTags('Admin · Attempts & evaluation')
@Controller('admin')
export class AdminAttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  @Get('attempts')
  @AdminOnly(PERMISSIONS.ATTEMPTS_READ)
  list(@Query() q: AdminAttemptQueryDto) {
    return this.attempts.adminList(q);
  }

  @Get('attempts/:id')
  @AdminOnly(PERMISSIONS.ATTEMPTS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.attempts.adminGet(id);
  }

  @Get('evaluations')
  @AdminOnly(PERMISSIONS.EVALUATION_MANAGE)
  queue(@Query() q: EvaluationQueueQueryDto) {
    return this.attempts.evaluationQueue(q);
  }

  @Put('evaluations/:answerId')
  @AdminOnly(PERMISSIONS.EVALUATION_MANAGE)
  evaluate(
    @Param('answerId', ParseUUIDPipe) answerId: string,
    @Body() dto: EvaluateAnswerDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.attempts.evaluateAnswer(answerId, dto, u, ctx);
  }
}

@Processor(QUEUES.ATTEMPTS, { concurrency: 5 })
export class AttemptsProcessor extends WorkerHost {
  constructor(private readonly attempts: AttemptsService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.AUTO_SUBMIT_ATTEMPT)
      return this.attempts.finalize(job.data.attemptId as string, true);
    if (job.name === JOBS.SWEEP_EXPIRED_ATTEMPTS) return this.attempts.sweepExpired();
    return undefined;
  }
}

@Module({
  controllers: [AttemptsController, AdminAttemptsController],
  providers: [AttemptsService, ...workers(AttemptsProcessor)],
  exports: [AttemptsService],
})
export class AttemptsModule {}
