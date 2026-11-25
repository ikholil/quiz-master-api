import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types/auth-user';
import { CreatePracticeDto, PracticeAnswerDto } from './practice.dto';
import { PracticeService } from './practice.service';

@ApiTags('Practice')
@Authenticated()
@Controller('practice')
export class PracticeController {
  constructor(private readonly practice: PracticeService) {}

  @Get('quota')
  async quota(@CurrentUser() user: AuthUser) {
    return { remainingToday: await this.practice.remainingQuota(user.id) };
  }

  @Post('sessions')
  @ApiOperation({ summary: 'Create a practice set (topic, subject, exam, weak topics, wrong answers or mixed)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePracticeDto) {
    return this.practice.create(user.id, dto);
  }

  @Get('sessions')
  history(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.practice.history(user.id, q);
  }

  @Get('sessions/:id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.practice.get(user.id, id);
  }

  @Post('sessions/:id/answers/:answerId')
  @HttpCode(200)
  answer(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('answerId', ParseUUIDPipe) answerId: string, @Body() dto: PracticeAnswerDto) {
    return this.practice.answer(user.id, id, answerId, dto);
  }

  @Post('sessions/:id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.practice.complete(user.id, id);
  }
}

@Module({ controllers: [PracticeController], providers: [PracticeService], exports: [PracticeService] })
export class PracticeModule {}
