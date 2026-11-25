import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Job } from 'bullmq';
import { AdminOnly, Authenticated, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import { CreateConversationDto, FeedbackDto, GenerateQuestionsDto, PromptTemplateDto, SendMessageDto, UsageQueryDto } from './ai.dto';
import { AssistantService } from './assistant.service';

@ApiTags('AI assistant')
@Authenticated()
@Controller('ai')
export class AiController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('quota')
  quota(@CurrentUser() u: AuthUser) {
    return this.assistant.quota(u.id);
  }

  @Post('conversations')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConversationDto) {
    return this.assistant.createConversation(u.id, dto);
  }

  @Get('conversations')
  list(@CurrentUser() u: AuthUser, @Query() q: PaginationQueryDto) {
    return this.assistant.listConversations(u.id, q);
  }

  @Get('conversations/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.getConversation(u.id, id);
  }

  @Delete('conversations/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.deleteConversation(u.id, id);
  }

  @Post('conversations/:id/messages')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a question; the reply is generated in the background — poll GET /ai/messages/:id' })
  send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.assistant.sendMessage(u.id, id, dto);
  }

  @Get('messages/:id')
  message(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.getMessage(u.id, id);
  }

  @Post('messages/:id/feedback')
  @HttpCode(200)
  feedback(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FeedbackDto) {
    return this.assistant.feedback(u.id, id, dto);
  }
}

@ApiTags('Admin · AI')
@Controller('admin/ai')
export class AdminAiController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('usage')
  @AdminOnly(PERMISSIONS.AI_MANAGE)
  usage(@Query() q: UsageQueryDto) {
    return this.assistant.usageSummary(q.days ?? 30);
  }

  @Get('prompts')
  @AdminOnly(PERMISSIONS.AI_MANAGE)
  prompts() {
    return this.assistant.listPrompts();
  }

  @Post('prompts')
  @AdminOnly(PERMISSIONS.AI_MANAGE)
  createPrompt(@Body() dto: PromptTemplateDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.assistant.createPrompt(dto, u.id, ctx);
  }

  @Post('prompts/:id/activate')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.AI_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.assistant.activatePrompt(id, u.id, ctx);
  }

  @Post('generate-questions')
  @AdminOnly(PERMISSIONS.QUESTIONS_CREATE, PERMISSIONS.AI_MANAGE)
  @ApiOperation({ summary: 'Draft questions with AI (saved as DRAFT; human review required before publishing)' })
  generate(@Body() dto: GenerateQuestionsDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.assistant.requestQuestionGeneration(dto, u, ctx);
  }
}

@Processor(QUEUES.AI, { concurrency: 4 })
export class AiProcessor extends WorkerHost {
  constructor(private readonly assistant: AssistantService) {
    super();
  }
  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.AI_REPLY) return this.assistant.generateReply(job.data.messageId as string);
    if (job.name === 'generate-questions') return this.assistant.generateQuestions(job.data);
    return undefined;
  }
}

@Module({ controllers: [AiController, AdminAiController], providers: [AssistantService, ...workers(AiProcessor)] })
export class AiModule {}
