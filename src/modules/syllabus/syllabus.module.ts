import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentUser, Public, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import {
  ChapterDto,
  SetMappingsDto,
  SubjectDto,
  SyllabusStatusDto,
  SyllabusTreeResponse,
  SyllabusVersionDto,
  TopicDto,
  TopicRelationDto,
  UpdateNodeDto,
} from './syllabus.dto';
import { SyllabusService } from './syllabus.service';

@ApiTags('Public · Syllabus')
@Controller('public')
export class PublicSyllabusController {
  constructor(private readonly syllabus: SyllabusService) {}

  @Public()
  @Get('exams/:examId/syllabus')
  @ApiEnvelope(SyllabusTreeResponse)
  current(@Param('examId', ParseUUIDPipe) examId: string) {
    return this.syllabus.currentForExam(examId);
  }

  @Public()
  @Get('exams/:examId/syllabus-versions')
  versions(@Param('examId', ParseUUIDPipe) examId: string) {
    return this.syllabus.listVersions(examId);
  }

  @Public()
  @Get('syllabus-versions/:id')
  @ApiEnvelope(SyllabusTreeResponse)
  version(@Param('id', ParseUUIDPipe) id: string) {
    return this.syllabus.tree(id);
  }

  @Public()
  @Get('subjects')
  subjects() {
    return this.syllabus.listSubjects();
  }

  @Public()
  @Get('subjects/:id/tree')
  subjectTree(@Param('id', ParseUUIDPipe) id: string) {
    return this.syllabus.subjectTree(id);
  }

  @Public()
  @Get('topics/:id')
  topic(@Param('id', ParseUUIDPipe) id: string) {
    return this.syllabus.getTopic(id);
  }
}

@ApiTags('Admin · Syllabus & curriculum')
@Controller('admin')
export class AdminSyllabusController {
  constructor(private readonly syllabus: SyllabusService) {}

  @Post('subjects')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  createSubject(@Body() dto: SubjectDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.createSubject(dto, u.id, ctx);
  }
  @Patch('subjects/:id')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  updateSubject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNodeDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.updateSubject(id, dto, u.id, ctx);
  }
  @Post('chapters')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  createChapter(@Body() dto: ChapterDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.createChapter(dto, u.id, ctx);
  }
  @Patch('chapters/:id')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  updateChapter(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNodeDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.updateChapter(id, dto, u.id, ctx);
  }
  @Post('topics')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  createTopic(@Body() dto: TopicDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.createTopic(dto, u.id, ctx);
  }
  @Patch('topics/:id')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  updateTopic(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNodeDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.updateTopic(id, dto, u.id, ctx);
  }
  @Post('topic-relations')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  addRelation(@Body() dto: TopicRelationDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.addRelation(dto, u.id, ctx);
  }
  @Delete('topic-relations')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  removeRelation(@Body() dto: TopicRelationDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.removeRelation(dto, u.id, ctx);
  }

  @Get('exams/:examId/syllabus-versions')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  versions(@Param('examId', ParseUUIDPipe) examId: string) {
    return this.syllabus.listVersions(examId, true);
  }
  @Get('syllabus-versions/:id')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  @ApiEnvelope(SyllabusTreeResponse)
  tree(@Param('id', ParseUUIDPipe) id: string) {
    return this.syllabus.tree(id, true);
  }
  @Post('syllabus-versions')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  createVersion(@Body() dto: SyllabusVersionDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.createVersion(dto, u.id, ctx);
  }
  @Put('syllabus-versions/:id/mappings')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  @ApiEnvelope(SyllabusTreeResponse)
  setMappings(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetMappingsDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.setMappings(id, dto, u.id, ctx);
  }
  @Patch('syllabus-versions/:id/status')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SyllabusStatusDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.setStatus(id, dto.status, u.id, ctx);
  }
  @Post('syllabus-versions/:id/make-current')
  @AdminOnly(PERMISSIONS.SYLLABUS_MANAGE)
  makeCurrent(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.syllabus.makeCurrent(id, u.id, ctx);
  }
}

@Global()
@Module({ controllers: [PublicSyllabusController, AdminSyllabusController], providers: [SyllabusService], exports: [SyllabusService] })
export class SyllabusModule {}
