import { Body, Controller, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PublishStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { ApiEnvelope, ApiPaginated } from '../../common/swagger/api-envelope';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PERMISSIONS } from '../rbac/permissions';
import { CreateMockTemplateDto, MockExamDetail, MockExamSummary, MockQueryDto, UpdateMockTemplateDto } from './mock-exams.dto';
import { MockExamsService } from './mock-exams.service';
import { QuestionSelector } from './question-selector';

class MockStatusDto {
  @ApiProperty({ enum: PublishStatus }) @IsEnum(PublishStatus) status: PublishStatus;
}

@ApiTags('Mock examinations')
@Authenticated()
@Controller('mock-exams')
export class MockExamsController {
  constructor(private readonly mocks: MockExamsService) {}

  @Get()
  @ApiPaginated(MockExamSummary)
  list(@CurrentUser() user: AuthUser, @Query() q: MockQueryDto) {
    return this.mocks.list(user.id, q);
  }

  @Get(':idOrSlug')
  @ApiEnvelope(MockExamDetail)
  detail(@CurrentUser() user: AuthUser, @Param('idOrSlug') idOrSlug: string) {
    return this.mocks.detail(user.id, idOrSlug);
  }
}

@ApiTags('Admin · Mock examinations')
@Controller('admin/mock-exams')
export class AdminMockExamsController {
  constructor(private readonly mocks: MockExamsService) {}

  @Get()
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  list(@Query() q: MockQueryDto) {
    return this.mocks.adminList(q);
  }

  @Post()
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  create(@Body() dto: CreateMockTemplateDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.mocks.create(dto, u.id, ctx);
  }

  @Get(':id')
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.mocks.adminGet(id);
  }

  @Get(':id/pool-report')
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  @ApiOperation({ summary: 'How many published questions are available for each draft section' })
  pool(@Param('id', ParseUUIDPipe) id: string) {
    return this.mocks.poolReport(id);
  }

  @Patch(':id')
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMockTemplateDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.mocks.update(id, dto, u.id, ctx);
  }

  @Post(':id/publish')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  @ApiOperation({ summary: 'Freeze the draft configuration into a new immutable version' })
  publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.mocks.publish(id, u.id, ctx);
  }

  @Patch(':id/status')
  @AdminOnly(PERMISSIONS.MOCK_EXAMS_MANAGE)
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MockStatusDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.mocks.setStatus(id, dto.status, u.id, ctx);
  }
}

@Global()
@Module({
  controllers: [MockExamsController, AdminMockExamsController],
  providers: [MockExamsService, QuestionSelector],
  exports: [MockExamsService, QuestionSelector],
})
export class MockExamsModule {}
