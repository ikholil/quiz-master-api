import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types/auth-user';
import { GamificationService } from './gamification.service';

class DailyAnswerDto {
  @IsArray() @ArrayMaxSize(1) @IsUUID('4', { each: true }) selectedOptionIds: string[];
  @IsOptional() @IsInt() @Min(0) @Max(3_600_000) timeSpentMs?: number;
}
class PeriodQueryDto {
  @IsOptional() @IsIn(['week', 'month', 'all']) period?: 'week' | 'month' | 'all';
}
class BookmarkDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @MaxLength(60) folder?: string;
}
class BookmarkQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(60) folder?: string;
}

@ApiTags('Gamification & leaderboards')
@Authenticated()
@Controller()
export class GamificationController {
  constructor(private readonly game: GamificationService) {}

  @Get('gamification/me')
  @ApiOperation({ summary: 'XP, level, streak, accuracy and achievements' })
  me(@CurrentUser() u: AuthUser) {
    return this.game.profile(u.id);
  }

  @Get('gamification/daily-challenge')
  @ApiOperation({
    summary: "Today's challenge (same question for everyone); the key is shown after answering",
  })
  daily(@CurrentUser() u: AuthUser) {
    return this.game.today(u.id);
  }

  @Post('gamification/daily-challenge/answer')
  @HttpCode(200)
  answer(@CurrentUser() u: AuthUser, @Body() dto: DailyAnswerDto) {
    return this.game.answerToday(u.id, dto.selectedOptionIds, dto.timeSpentMs);
  }

  @Get('leaderboards/xp')
  xp(@CurrentUser() u: AuthUser, @Query() q: PeriodQueryDto) {
    return this.game.xpLeaderboard(u.id, q.period ?? 'week');
  }

  @Get('leaderboards/mock-exams/:templateId')
  mock(@CurrentUser() u: AuthUser, @Param('templateId', ParseUUIDPipe) templateId: string) {
    return this.game.mockLeaderboard(u.id, templateId);
  }

  @Get('leaderboards/daily-challenge')
  dailyBoard() {
    return this.game.dailyLeaderboard();
  }

  @Get('questions/bookmarks')
  bookmarks(@CurrentUser() u: AuthUser, @Query() q: BookmarkQueryDto) {
    return this.game.bookmarks(u.id, q);
  }

  @Put('questions/:id/bookmark')
  @ApiOperation({ summary: 'Bookmark a published question with an optional personal note and folder' })
  bookmark(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookmarkDto) {
    return this.game.bookmark(u.id, id, dto.note, dto.folder);
  }

  @Delete('questions/:id/bookmark')
  unbookmark(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.game.unbookmark(u.id, id);
  }
}

@Global()
@Module({
  controllers: [GamificationController],
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
