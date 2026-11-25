import { Body, Controller, Delete, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Authenticated, CurrentUser } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types/auth-user';
import { DueQueryDto, FlashcardDto, FlashcardQueryDto, ReviewItemDto, StudyCardsDto, UpdateFlashcardDto } from './revision.dto';
import { RevisionService } from './revision.service';

@ApiTags('Revision & flashcards')
@Authenticated()
@Controller()
export class RevisionController {
  constructor(private readonly revision: RevisionService) {}

  @Get('revision/due')
  due(@CurrentUser() user: AuthUser, @Query() q: DueQueryDto) {
    return this.revision.due(user.id, q.limit ?? 50, q.type);
  }

  @Post('revision/items/:id/review')
  @HttpCode(200)
  review(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewItemDto) {
    return this.revision.review(user.id, id, dto.quality);
  }

  @Get('revision/wrong-answers')
  wrong(@CurrentUser() user: AuthUser, @Query() q: PaginationQueryDto) {
    return this.revision.wrongAnswers(user.id, q);
  }

  @Get('flashcards')
  list(@CurrentUser() user: AuthUser, @Query() q: FlashcardQueryDto) {
    return this.revision.listFlashcards(user, q);
  }

  @Get('flashcards/decks')
  decks(@CurrentUser() user: AuthUser) {
    return this.revision.decks(user.id);
  }

  @Post('flashcards')
  create(@CurrentUser() user: AuthUser, @Body() dto: FlashcardDto) {
    return this.revision.createFlashcard(user, dto);
  }

  @Post('flashcards/study')
  @HttpCode(200)
  study(@CurrentUser() user: AuthUser, @Body() dto: StudyCardsDto) {
    return this.revision.study(user.id, dto.flashcardIds);
  }

  @Patch('flashcards/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFlashcardDto) {
    return this.revision.updateFlashcard(user, id, dto);
  }

  @Delete('flashcards/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.revision.deleteFlashcard(user, id);
  }
}

@Global()
@Module({ controllers: [RevisionController], providers: [RevisionService], exports: [RevisionService] })
export class RevisionModule {}
