import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { PublishStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope, ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import {
  CategoryResponse,
  CreateAuthorityDto,
  CreateCategoryDto,
  CreateExamDto,
  ExamDetailResponse,
  ExamQueryDto,
  ExamSummaryResponse,
  NoticeDto,
  NoticeResponse,
  PaperDto,
  PaperResponse,
  StageDto,
  UpdateCategoryDto,
  UpdateExamDto,
} from './exams.dto';
import { ExamsService } from './exams.service';

class StatusDto {
  @ApiProperty({ enum: PublishStatus }) @IsEnum(PublishStatus) status: PublishStatus;
}

@ApiTags('Public · Examinations')
@Controller('public')
export class PublicExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Public()
  @Get('exam-categories')
  @ApiEnvelope(CategoryResponse, { isArray: true })
  categories() {
    return this.exams.listCategories();
  }

  @Public()
  @Get('authorities')
  authorities() {
    return this.exams.listAuthorities();
  }

  @Public()
  @Get('exams')
  @ApiPaginated(ExamSummaryResponse)
  list(@Query() q: ExamQueryDto) {
    return this.exams.listExams(q);
  }

  /** Accepts slug or id. When called with a bearer token, `isBookmarked` reflects the user. */
  @Public()
  @Get('exams/:slugOrId')
  @ApiEnvelope(ExamDetailResponse)
  get(@Param('slugOrId') slugOrId: string, @CurrentUser() user?: AuthUser) {
    return this.exams.getExam(slugOrId, user?.id);
  }

  @Public()
  @Get('exams/:id/notices')
  @ApiEnvelope(NoticeResponse, { isArray: true })
  notices(@Param('id', ParseUUIDPipe) id: string) {
    return this.exams.listNotices(id);
  }

  @Public()
  @Get('exams/:id/previous-papers')
  @ApiEnvelope(PaperResponse, { isArray: true })
  papers(@Param('id', ParseUUIDPipe) id: string) {
    return this.exams.listPapers(id);
  }
}

@ApiTags('Examinations')
@Authenticated()
@Controller('exams')
export class StudentExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Get('bookmarks')
  @ApiEnvelope(ExamSummaryResponse, { isArray: true })
  bookmarks(@CurrentUser() user: AuthUser) {
    return this.exams.bookmarks(user.id);
  }

  @Post(':id/bookmark')
  @HttpCode(200)
  bookmark(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.bookmark(user.id, id);
  }

  @Delete(':id/bookmark')
  unbookmark(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.exams.unbookmark(user.id, id);
  }
}

@ApiTags('Admin · Examination catalog')
@Controller('admin')
export class AdminExamsController {
  constructor(private readonly exams: ExamsService) {}

  @Get('exam-categories')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  categories() {
    return this.exams.adminCategories();
  }

  @Post('exam-categories')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  createCategory(@Body() dto: CreateCategoryDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.createCategory(dto, u.id, ctx);
  }

  @Patch('exam-categories/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.updateCategory(id, dto, u.id, ctx);
  }

  @Post('authorities')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  createAuthority(@Body() dto: CreateAuthorityDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.createAuthority(dto, u.id, ctx);
  }

  @Patch('authorities/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  updateAuthority(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAuthorityDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.updateAuthority(id, dto, u.id, ctx);
  }

  @Get('exams')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  @ApiPaginated(ExamSummaryResponse)
  list(@Query() q: ExamQueryDto) {
    return this.exams.listExams(q, true);
  }

  @Get('exams/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  @ApiEnvelope(ExamDetailResponse)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.exams.getExam(id, undefined, true);
  }

  @Post('exams')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  create(@Body() dto: CreateExamDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.createExam(dto, u.id, ctx);
  }

  @Patch('exams/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExamDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.updateExam(id, dto, u.id, ctx);
  }

  @Put('exams/:id/stages')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  upsertStage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StageDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.upsertStage(id, dto, u.id, ctx);
  }

  @Delete('stages/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  deleteStage(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.deleteStage(id, u.id, ctx);
  }

  @Get('exams/:id/notices')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  notices(@Param('id', ParseUUIDPipe) id: string) {
    return this.exams.listNotices(id, true);
  }

  @Post('exams/:id/notices')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  createNotice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NoticeDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.createNotice(id, dto, u.id, ctx);
  }

  @Patch('notices/:id/status')
  @AdminOnly(PERMISSIONS.NOTICES_MANAGE)
  noticeStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.setNoticeStatus(id, dto.status, u.id, ctx);
  }

  @Get('exams/:id/previous-papers')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  papers(@Param('id', ParseUUIDPipe) id: string) {
    return this.exams.listPapers(id, true);
  }

  @Post('exams/:id/previous-papers')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  createPaper(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaperDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.createPaper(id, dto, u.id, ctx);
  }

  @Patch('previous-papers/:id')
  @AdminOnly(PERMISSIONS.CATALOG_MANAGE)
  updatePaper(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaperDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.exams.updatePaper(id, dto, u.id, ctx);
  }
}

@Module({
  controllers: [PublicExamsController, StudentExamsController, AdminExamsController],
  providers: [ExamsService],
  exports: [ExamsService],
})
export class ExamsModule {}
