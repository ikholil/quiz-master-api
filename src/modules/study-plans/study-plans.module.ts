import {
  Body,
  Controller,
  Get,
  Global,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthUser } from '../../common/types/auth-user';
import {
  CreateStudyPlanDto,
  RescheduleTaskDto,
  TaskRangeQueryDto,
  UpdateStudyPlanDto,
} from './study-plans.dto';
import { StudyPlansService } from './study-plans.service';

@ApiTags('Study plans')
@Authenticated()
@Controller('study-plans')
export class StudyPlansController {
  constructor(private readonly plans: StudyPlansService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStudyPlanDto) {
    return this.plans.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.plans.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.get(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudyPlanDto,
  ) {
    return this.plans.update(user.id, id, dto);
  }

  @Get(':id/today')
  @ApiOperation({ summary: "Today's personalised tasks (each with an explainable reason)" })
  today(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.today(user.id, id);
  }

  @Get(':id/tasks')
  tasks(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: TaskRangeQueryDto,
  ) {
    return this.plans.tasks(user.id, id, q);
  }

  @Get(':id/progress')
  progress(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.plans.progress(user.id, id);
  }

  @Post('tasks/:taskId/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.plans.setTaskStatus(user.id, taskId, 'COMPLETED');
  }

  @Post('tasks/:taskId/skip')
  @HttpCode(200)
  skip(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.plans.setTaskStatus(user.id, taskId, 'SKIPPED');
  }

  @Post('tasks/:taskId/reschedule')
  @HttpCode(200)
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: RescheduleTaskDto,
  ) {
    return this.plans.reschedule(user.id, taskId, dto);
  }
}

@Global()
@Module({ controllers: [StudyPlansController], providers: [StudyPlansService], exports: [StudyPlansService] })
export class StudyPlansModule {}
