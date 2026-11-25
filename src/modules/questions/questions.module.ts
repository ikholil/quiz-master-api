import { Body, Controller, Delete, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, Authenticated, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope, ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import { QuestionImportProcessor } from './question-import.processor';
import {
  AdminQuestionListItem,
  AdminQuestionQueryDto,
  CreateQuestionDto,
  CreateReportDto,
  ImportQuestionsDto,
  PassageDto,
  PublicQuestionQueryDto,
  ReportQueryDto,
  ResolveReportDto,
  ReviewDto,
  SourceDto,
  StudentQuestionView,
  UpdateQuestionDto,
} from './questions.dto';
import { QuestionsService } from './questions.service';

@ApiTags('Public · Question bank')
@Controller('public/questions')
export class PublicQuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  /** Browse published objective questions (no answers; practise them via practice sessions). */
  @Public()
  @Get()
  @ApiPaginated(StudentQuestionView)
  list(@Query() q: PublicQuestionQueryDto) {
    return this.questions.publicList(q);
  }

  @Public()
  @Get(':id')
  @ApiEnvelope(StudentQuestionView)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.questions.publicGet(id);
  }
}

@ApiTags('Question bank')
@Authenticated()
@Controller('questions')
export class StudentQuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Post(':id/reports')
  @ApiOperation({ summary: 'Report an error in a published question' })
  report(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateReportDto, @CurrentUser() user: AuthUser) {
    return this.questions.report(id, dto, user.id);
  }
}

@ApiTags('Admin · Question bank')
@Controller('admin/questions')
export class AdminQuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get()
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  @ApiPaginated(AdminQuestionListItem)
  list(@Query() q: AdminQuestionQueryDto) {
    return this.questions.adminList(q);
  }

  @Get('review-queue')
  @AdminOnly(PERMISSIONS.QUESTIONS_REVIEW)
  reviewQueue(@Query() q: AdminQuestionQueryDto) {
    return this.questions.reviewQueue(q);
  }

  @Get('sources')
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  sources() {
    return this.questions.listSources();
  }

  @Post('sources')
  @AdminOnly(PERMISSIONS.QUESTIONS_CREATE)
  createSource(@Body() dto: SourceDto) {
    return this.questions.createSource(dto);
  }

  @Post('passages')
  @AdminOnly(PERMISSIONS.QUESTIONS_CREATE)
  createPassage(@Body() dto: PassageDto, @CurrentUser() u: AuthUser) {
    return this.questions.createPassage(dto, u);
  }

  @Get('reports')
  @AdminOnly(PERMISSIONS.QUESTION_REPORTS_MANAGE)
  reports(@Query() q: ReportQueryDto) {
    return this.questions.listReports(q);
  }

  @Patch('reports/:id')
  @AdminOnly(PERMISSIONS.QUESTION_REPORTS_MANAGE)
  resolveReport(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveReportDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.resolveReport(id, dto, u, ctx);
  }

  @Get('imports')
  @AdminOnly(PERMISSIONS.QUESTIONS_IMPORT)
  imports() {
    return this.questions.listImports();
  }

  @Post('imports')
  @AdminOnly(PERMISSIONS.QUESTIONS_IMPORT)
  @ApiOperation({ summary: 'Start a background CSV/JSON import (upload the file with purpose QUESTION_IMPORT first)' })
  startImport(@Body() dto: ImportQuestionsDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.startImport(dto, u, ctx);
  }

  @Get('imports/:id')
  @AdminOnly(PERMISSIONS.QUESTIONS_IMPORT)
  importStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.questions.getImport(id);
  }

  @Post()
  @AdminOnly(PERMISSIONS.QUESTIONS_CREATE)
  create(@Body() dto: CreateQuestionDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.create(dto, u, ctx);
  }

  @Get(':id')
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.questions.adminGet(id);
  }

  @Get(':id/versions')
  @AdminOnly(PERMISSIONS.QUESTIONS_READ)
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.questions.versions(id);
  }

  @Patch(':id')
  @AdminOnly(PERMISSIONS.QUESTIONS_EDIT)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateQuestionDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.update(id, dto, u, ctx);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_EDIT)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.submitForReview(id, u, ctx);
  }

  @Post(':id/review')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_REVIEW)
  review(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.review(id, dto, u, ctx);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_PUBLISH)
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.publish(id, u, ctx);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.QUESTIONS_PUBLISH)
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.archive(id, u, ctx);
  }

  @Delete(':id')
  @AdminOnly(PERMISSIONS.QUESTIONS_EDIT)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.questions.remove(id, u, ctx);
  }
}

@Global()
@Module({
  controllers: [PublicQuestionsController, StudentQuestionsController, AdminQuestionsController],
  providers: [QuestionsService, ...workers(QuestionImportProcessor)],
  exports: [QuestionsService],
})
export class QuestionsModule {}
