import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Body, Controller, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Job } from 'bullmq';
import { AdminOnly, CurrentUser, ReqContext } from '../../common/decorators/auth.decorators';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { JOBS, QUEUES, workers } from '../../queue/queue.constants';
import { PERMISSIONS } from '../rbac/permissions';
import { CreateKnowledgeSourceDto, KnowledgeQueryDto, RetrievalTestDto, UpdateKnowledgeSourceDto } from './knowledge.dto';
import { KnowledgeService } from './knowledge.service';

@ApiTags('Admin · AI knowledge base')
@Controller('admin/knowledge-sources')
export class AdminKnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  list(@Query() q: KnowledgeQueryDto) {
    return this.knowledge.list(q);
  }

  @Post()
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  create(@Body() dto: CreateKnowledgeSourceDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.knowledge.create(dto, u.id, ctx);
  }

  @Get(':id')
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.get(id);
  }

  @Patch(':id')
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeSourceDto, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.knowledge.update(id, dto, u.id, ctx);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  @ApiOperation({ summary: 'Approve a source; indexing (chunking + embeddings) runs in the background' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.knowledge.approve(id, u.id, ctx);
  }

  @Post(':id/reindex')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  reindex(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.knowledge.reindex(id, u.id, ctx);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @ReqContext() ctx: RequestContext) {
    return this.knowledge.archive(id, u.id, ctx);
  }

  @Post('retrieval-test')
  @HttpCode(200)
  @AdminOnly(PERMISSIONS.KNOWLEDGE_MANAGE)
  @ApiOperation({ summary: 'Run a retrieval query as the current admin (debugging relevance)' })
  test(@Body() dto: RetrievalTestDto, @CurrentUser() u: AuthUser) {
    return this.knowledge.retrieve(dto.query, { userId: u.id, examId: dto.examId, limit: 10, minScore: 0 });
  }
}

@Processor(QUEUES.KNOWLEDGE, { concurrency: 2 })
export class KnowledgeProcessor extends WorkerHost {
  constructor(private readonly knowledge: KnowledgeService) {
    super();
  }
  async process(job: Job): Promise<unknown> {
    if (job.name === JOBS.INDEX_SOURCE) return this.knowledge.index(job.data.sourceId as string);
    return undefined;
  }
}

@Global()
@Module({ controllers: [AdminKnowledgeController], providers: [KnowledgeService, ...workers(KnowledgeProcessor)], exports: [KnowledgeService] })
export class KnowledgeModule {}
