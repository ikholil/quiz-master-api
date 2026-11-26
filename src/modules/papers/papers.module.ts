import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import {
  AttachQuestionsDto,
  CreatePaperDto,
  DisputeDto,
  FrequencyQueryDto,
  ImportPaperDto,
  PaperQueryDto,
  UpdatePaperDto,
  VerifyPaperDto,
} from './papers.dto';
import { PapersService } from './papers.service';

@ApiTags('Public · Previous-year papers')
@Controller('public')
export class PublicPapersController {
  constructor(private readonly papers: PapersService) {}

  @Public()
  @Get('previous-papers')
  list(@Query() q: PaperQueryDto) {
    return this.papers.publicList(q);
  }

  @Public()
  @Get('previous-papers/:id')
  @ApiOperation({ summary: 'Paper with numbered questions (no answers) and its verification status' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.papers.publicGet(id);
  }

  @Public()
  @Get('exams/:examId/topic-frequency')
  @ApiOperation({ summary: 'Which topics are asked most often in verified past papers' })
  frequency(@Param('examId', ParseUUIDPipe) examId: string, @Query() q: FrequencyQueryDto) {
    return this.papers.topicFrequency(examId, { verifiedOnly: true, years: q.years });
  }
}

@ApiTags('Admin · Previous-year papers')
@Controller('admin')
export class AdminPapersController {
  constructor(private readonly papers: PapersService) {}

  @Get('previous-papers')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  list(@Query() q: PaperQueryDto) {
    return this.papers.adminList(q);
  }

  @Post('previous-papers')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  create(@Body() dto: CreatePaperDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.papers.create(dto, u, ctx);
  }

  @Get('previous-papers/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.papers.adminGet(id);
  }

  @Patch('previous-papers/:id/details')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaperDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.update(id, dto, u, ctx);
  }

  @Post('previous-papers/:id/questions')
  @AdminOnly(PERMISSIONS.QUESTIONS_EDIT)
  attach(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachQuestionsDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.attach(id, dto, u, ctx);
  }

  @Delete('previous-papers/:id/questions/:questionId')
  @AdminOnly(PERMISSIONS.QUESTIONS_EDIT)
  detach(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.detach(id, questionId, u, ctx);
  }

  @Post('previous-papers/:id/import')
  @AdminOnly(PERMISSIONS.QUESTIONS_IMPORT)
  @ApiOperation({
    summary:
      'Import a whole paper from CSV/JSON (needs a question_number column); repeated questions are linked, not duplicated',
  })
  import(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImportPaperDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.startImport(id, dto, u, ctx);
  }

  @Post('previous-papers/:id/verify')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_PUBLISH)
  @ApiOperation({ summary: 'Mark the paper verified/disputed against evidence of the official paper' })
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyPaperDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.verify(id, dto, u, ctx);
  }

  @Patch('previous-papers/:id/questions/:questionId/dispute')
  @AdminOnly(PERMISSIONS.QUESTION_REPORTS_MANAGE)
  dispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('questionId', ParseUUIDPipe) questionId: string,
    @Body() dto: DisputeDto,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.dispute(id, questionId, dto, u, ctx);
  }

  @Post('previous-papers/:id/replay-mock')
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  @ApiOperation({ summary: 'Create a timed mock that replays the paper in its original order' })
  replay(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.createReplayMock(id, u, ctx);
  }

  @Get('exams/:examId/topic-frequency')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  frequency(@Param('examId', ParseUUIDPipe) examId: string, @Query() q: FrequencyQueryDto) {
    return this.papers.topicFrequency(examId, { verifiedOnly: q.verifiedOnly !== 'false', years: q.years });
  }

  @Post('syllabus-versions/:id/weights-from-papers')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  @ApiOperation({
    summary: 'Set topic weights from verified past-paper frequency (feeds the adaptive engine)',
  })
  applyWeights(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() u: AuthUser,
    @ReqContext() ctx: RequestContext,
  ) {
    return this.papers.applyFrequencyWeights(id, u, ctx);
  }
}

@Module({
  controllers: [PublicPapersController, AdminPapersController],
  providers: [PapersService],
  exports: [PapersService],
})
export class PapersModule {}
