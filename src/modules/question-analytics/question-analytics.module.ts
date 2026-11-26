import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminOnly, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QuestionsService } from '../questions/questions.service';
import { PERMISSIONS } from '../rbac/permissions';
import { ItemResponse, MIN_SAMPLE, analyseItem } from './item-analysis';

class FlaggedQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ['POSSIBLE_KEY_ERROR', 'NEGATIVE_DISCRIMINATION', 'LOW_DISCRIMINATION', 'TOO_EASY', 'TOO_HARD'],
  })
  @IsOptional()
  @IsIn(['POSSIBLE_KEY_ERROR', 'NEGATIVE_DISCRIMINATION', 'LOW_DISCRIMINATION', 'TOO_EASY', 'TOO_HARD'])
  flag?: string;
}
class CalibrateDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(MIN_SAMPLE) @Max(100000) minSample?: number;
}
class SimilarDto {
  @IsString() @MinLength(5) @MaxLength(10000) stem: string;
}

@Injectable()
export class QuestionAnalyticsService {
  private readonly logger = new Logger(QuestionAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Recomputes item statistics from FINAL exam results. Each response carries the attempt's overall score so
   * upper/lower groups can be formed. Runs as a nightly job; idempotent.
   */
  async run(): Promise<{ analysed: number; flagged: number }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ questionId: string; correct: boolean | null; score: number }>
    >`
      SELECT aa."questionId", aa."isCorrect" AS correct, (ar."obtainedMarks" / NULLIF(ar."totalMarks", 0))::float AS score
        FROM attempt_answers aa
        JOIN attempt_results ar ON ar."attemptId" = aa."attemptId"
        JOIN questions q ON q.id = aa."questionId"
       WHERE ar.status = 'FINAL' AND q.type IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'SHORT_ANSWER')`;
    const byQ = new Map<string, ItemResponse[]>();
    for (const r of rows) {
      const list = byQ.get(r.questionId) ?? [];
      list.push({ correct: r.correct === true, attemptScore: Number(r.score ?? 0) });
      byQ.set(r.questionId, list);
    }
    let analysed = 0;
    let flagged = 0;
    for (const [questionId, responses] of byQ) {
      const stats = analyseItem(responses);
      if (!stats) continue;
      analysed++;
      if (stats.flags.length) flagged++;
      await this.prisma.question.update({
        where: { id: questionId },
        data: {
          pValue: stats.pValue,
          discrimination: stats.discrimination,
          calibratedDifficulty: stats.calibratedDifficulty,
          qualityFlags: stats.flags,
          statsSampleSize: stats.sampleSize,
          statsUpdatedAt: new Date(),
        },
      });
    }
    this.logger.log(`Item analysis: ${analysed} questions analysed, ${flagged} flagged`);
    return { analysed, flagged };
  }

  /** Per-option pick rates for a question across final exam results (which distractors attract whom). */
  async distractors(questionId: string) {
    const q = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        code: true,
        pValue: true,
        discrimination: true,
        calibratedDifficulty: true,
        difficulty: true,
        qualityFlags: true,
        statsSampleSize: true,
      },
    });
    if (!q) throw AppError.notFound('Question');
    const rows = await this.prisma.$queryRaw<
      Array<{
        versionNumber: number;
        optionId: string | null;
        key: string | null;
        text: string | null;
        isCorrect: boolean | null;
        picks: bigint;
        upperPicks: bigint;
      }>
    >`
      WITH resp AS (
        SELECT aa."questionVersionId", aa."selectedOptionIds",
               percent_rank() OVER (ORDER BY ar."obtainedMarks" / NULLIF(ar."totalMarks", 0)) AS pr
          FROM attempt_answers aa JOIN attempt_results ar ON ar."attemptId" = aa."attemptId"
         WHERE aa."questionId" = ${questionId}::uuid AND ar.status = 'FINAL'
      )
      SELECT v."versionNumber", o.id AS "optionId", o.key, o.text, o."isCorrect",
             COUNT(r.*) FILTER (WHERE o.id = ANY(r."selectedOptionIds")) AS picks,
             COUNT(r.*) FILTER (WHERE o.id = ANY(r."selectedOptionIds") AND r.pr >= 0.73) AS "upperPicks"
        FROM question_versions v
        JOIN question_options o ON o."versionId" = v.id
        LEFT JOIN resp r ON r."questionVersionId" = v.id
       WHERE v."questionId" = ${questionId}::uuid
       GROUP BY v."versionNumber", o.id, o.key, o.text, o."isCorrect", o."sortOrder"
       ORDER BY v."versionNumber" DESC, o."sortOrder"`;
    const skipped = await this.prisma.attemptAnswer.count({
      where: { questionId, selectedOptionIds: { isEmpty: true }, attempt: { result: { status: 'FINAL' } } },
    });
    return {
      ...q,
      skipped,
      options: rows.map((r) => ({
        versionNumber: r.versionNumber,
        optionId: r.optionId,
        key: r.key,
        text: r.text,
        isCorrect: r.isCorrect,
        picks: Number(r.picks),
        upperGroupPicks: Number(r.upperPicks),
      })),
    };
  }

  async flagged(q: FlaggedQueryDto) {
    const where: Prisma.QuestionWhereInput = {
      deletedAt: null,
      qualityFlags: q.flag ? { has: q.flag } : { isEmpty: false },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where,
        select: {
          id: true,
          code: true,
          difficulty: true,
          calibratedDifficulty: true,
          pValue: true,
          discrimination: true,
          qualityFlags: true,
          statsSampleSize: true,
          latestVersion: { select: { stem: true } },
        },
        orderBy: [{ discrimination: 'asc' }],
        ...pageArgs(q),
      }),
      this.prisma.question.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  /** Explicit, audited: replace authored difficulty with the empirically calibrated one. */
  async applyCalibration(minSample: number, actor: AuthUser, ctx: RequestContext) {
    const res = await this.prisma.$executeRaw`
      UPDATE questions SET difficulty = "calibratedDifficulty"
       WHERE "calibratedDifficulty" IS NOT NULL AND "statsSampleSize" >= ${minSample} AND difficulty <> "calibratedDifficulty"`;
    await this.audit.record({
      actorId: actor.id,
      action: 'questions.calibrate_difficulty',
      entityType: 'Question',
      metadata: { minSample, updated: res },
      ctx,
    });
    return { updated: res };
  }

  similar(stem: string) {
    return this.questions.findSimilar(stem, { threshold: 0.4, limit: 10 });
  }
}

@ApiTags('Admin · Question quality')
@Controller('admin/question-quality')
export class QuestionAnalyticsController {
  constructor(private readonly analytics: QuestionAnalyticsService) {}

  @Get('flagged')
  @AdminOnly(PERMISSIONS.QUESTIONS_REVIEW)
  @ApiOperation({ summary: 'Questions flagged by item analysis (possible wrong key, poor discrimination…)' })
  flagged(@Query() q: FlaggedQueryDto) {
    return this.analytics.flagged(q);
  }

  @Get('questions/:id/distractors')
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  distractors(@Param('id', ParseUUIDPipe) id: string) {
    return this.analytics.distractors(id);
  }

  @Post('similar')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  @ApiOperation({ summary: 'Find near-duplicate questions for a draft stem (trigram similarity)' })
  similar(@Body() dto: SimilarDto) {
    return this.analytics.similar(dto.stem);
  }

  @Post('run')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_REVIEW)
  run() {
    return this.analytics.run();
  }

  @Post('apply-calibration')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_PUBLISH)
  calibrate(@Body() dto: CalibrateDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.analytics.applyCalibration(dto.minSample ?? 100, u, ctx);
  }
}

@Module({
  controllers: [QuestionAnalyticsController],
  providers: [QuestionAnalyticsService],
  exports: [QuestionAnalyticsService],
})
export class QuestionAnalyticsModule {}
