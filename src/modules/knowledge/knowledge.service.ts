import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeSourceStatus, KnowledgeVisibility, Prisma, ReviewEntityType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PageResult, pageArgs } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { chunkText, extractText } from './chunking';
import { CreateKnowledgeSourceDto, KnowledgeQueryDto, UpdateKnowledgeSourceDto } from './knowledge.dto';

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  title: string;
  content: string;
  score: number;
  isAuthoritative: boolean;
  sourceUrl: string | null;
}

const EMBED_BATCH = 64;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly files: FilesService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.KNOWLEDGE) private readonly queue: Queue,
  ) {}

  // ───────── Admin ─────────

  async create(dto: CreateKnowledgeSourceDto, actorId: string, ctx: RequestContext) {
    if (!dto.fileId && !dto.rawText) throw AppError.badRequest('CONTENT_REQUIRED', 'Provide fileId or rawText');
    let mimeType = dto.mimeType ?? 'text/plain';
    if (dto.fileId) {
      const file = await this.prisma.storedFile.findUnique({ where: { id: dto.fileId } });
      if (!file || file.purpose !== 'KNOWLEDGE') throw AppError.badRequest('INVALID_FILE', 'Upload the document with purpose KNOWLEDGE first');
      mimeType = file.mimeType;
    }
    if (dto.visibility === KnowledgeVisibility.ENTITLED && !dto.requiredFeature) {
      throw AppError.badRequest('FEATURE_REQUIRED', 'ENTITLED sources need requiredFeature');
    }
    const source = await this.prisma.knowledgeSource.create({ data: { ...dto, mimeType, createdById: actorId, status: KnowledgeSourceStatus.PENDING_REVIEW } });
    await this.audit.record({ actorId, action: 'knowledge.create', entityType: 'KnowledgeSource', entityId: source.id, after: { title: dto.title }, ctx });
    return source;
  }

  async update(id: string, dto: UpdateKnowledgeSourceDto, actorId: string, ctx: RequestContext) {
    const s = await this.get(id);
    const updated = await this.prisma.knowledgeSource.update({ where: { id: s.id }, data: dto });
    await this.audit.record({ actorId, action: 'knowledge.update', entityType: 'KnowledgeSource', entityId: id, after: dto, ctx });
    return updated;
  }

  /** Only approved content is ever indexed and retrievable. Approval enqueues background indexing. */
  async approve(id: string, actorId: string, ctx: RequestContext) {
    const s = await this.get(id);
    if (s.createdById === actorId) throw AppError.forbidden('Authors cannot approve their own sources', 'SELF_REVIEW_FORBIDDEN');
    if (!([KnowledgeSourceStatus.PENDING_REVIEW, KnowledgeSourceStatus.FAILED] as KnowledgeSourceStatus[]).includes(s.status)) {
      throw AppError.conflict('INVALID_TRANSITION', `Cannot approve a source in ${s.status}`);
    }
    await this.prisma.$transaction([
      this.prisma.knowledgeSource.update({ where: { id }, data: { status: KnowledgeSourceStatus.APPROVED, approvedById: actorId, approvedAt: new Date(), error: null } }),
      this.prisma.contentReview.create({ data: { entityType: ReviewEntityType.KNOWLEDGE_SOURCE, entityId: id, reviewerId: actorId, decision: 'APPROVED' } }),
    ]);
    await this.queue.add(JOBS.INDEX_SOURCE, { sourceId: id }, { jobId: `index-${id}-${Date.now()}` });
    await this.audit.record({ actorId, action: 'knowledge.approve', entityType: 'KnowledgeSource', entityId: id, ctx });
    return { id, status: KnowledgeSourceStatus.APPROVED, indexing: 'queued' };
  }

  async reindex(id: string, actorId: string, ctx: RequestContext) {
    const s = await this.get(id);
    if (!s.approvedAt) throw AppError.conflict('NOT_APPROVED', 'Approve the source first');
    await this.queue.add(JOBS.INDEX_SOURCE, { sourceId: id }, { jobId: `index-${id}-${Date.now()}` });
    await this.audit.record({ actorId, action: 'knowledge.reindex', entityType: 'KnowledgeSource', entityId: id, ctx });
    return { id, indexing: 'queued' };
  }

  async archive(id: string, actorId: string, ctx: RequestContext) {
    await this.get(id);
    await this.prisma.$transaction([
      this.prisma.documentChunk.deleteMany({ where: { sourceId: id } }),
      this.prisma.knowledgeSource.update({ where: { id }, data: { status: KnowledgeSourceStatus.ARCHIVED, chunkCount: 0 } }),
    ]);
    await this.audit.record({ actorId, action: 'knowledge.archive', entityType: 'KnowledgeSource', entityId: id, ctx });
    return { id, status: KnowledgeSourceStatus.ARCHIVED };
  }

  async list(q: KnowledgeQueryDto) {
    const where: Prisma.KnowledgeSourceWhereInput = { status: q.status, examId: q.examId, visibility: q.visibility, title: q.q ? { contains: q.q, mode: 'insensitive' } : undefined };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.knowledgeSource.findMany({ where, orderBy: { updatedAt: 'desc' }, ...pageArgs(q), omit: { rawText: true } }),
      this.prisma.knowledgeSource.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async get(id: string) {
    const s = await this.prisma.knowledgeSource.findUnique({ where: { id } });
    if (!s) throw AppError.notFound('Knowledge source');
    return s;
  }

  // ───────── Indexing (background) ─────────

  async index(sourceId: string): Promise<number> {
    const source = await this.prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
    if (!source || !source.approvedAt || source.status === KnowledgeSourceStatus.ARCHIVED) return 0;
    await this.prisma.knowledgeSource.update({ where: { id: sourceId }, data: { status: KnowledgeSourceStatus.INDEXING, error: null } });
    try {
      const raw = source.fileId ? (await this.files.readBuffer(source.fileId)).body.toString('utf8') : source.rawText ?? '';
      const text = extractText(source.mimeType, raw);
      if (text === null) throw new Error(`Unsupported format ${source.mimeType}: upload the document as text, Markdown or HTML`);
      const chunks = chunkText(text);
      if (!chunks.length) throw new Error('Document contains no text');

      const model = this.gateway.embeddingModelKey();
      await this.prisma.documentChunk.deleteMany({ where: { sourceId } });
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const emb = await this.gateway.embed(batch.map((c) => (c.heading ? `${c.heading}\n${c.content}` : c.content)), { feature: 'knowledge.index' });
        await this.prisma.$transaction(async (tx) => {
          for (const [j, c] of batch.entries()) {
            const chunk = await tx.documentChunk.create({
              data: { sourceId, ordinal: c.ordinal, content: c.content, tokenCount: c.tokenCount, metadata: { heading: c.heading ?? null } },
            });
            const literal = `[${emb.vectors[j].join(',')}]`;
            await tx.$executeRaw`INSERT INTO chunk_embeddings ("chunkId", provider, model, dimensions, embedding)
              VALUES (${chunk.id}::uuid, ${emb.provider}, ${emb.model}, ${emb.vectors[j].length}, ${literal}::vector)`;
          }
        });
      }
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: KnowledgeSourceStatus.INDEXED, chunkCount: chunks.length, indexedAt: new Date() },
      });
      this.logger.log(`Indexed ${source.title}: ${chunks.length} chunks with ${model}`);
      return chunks.length;
    } catch (err) {
      await this.prisma.knowledgeSource.update({ where: { id: sourceId }, data: { status: KnowledgeSourceStatus.FAILED, error: (err as Error).message.slice(0, 500) } });
      throw err;
    }
  }

  // ───────── Retrieval ─────────

  /**
   * Vector retrieval restricted to indexed, approved sources the user may see (visibility + entitlements),
   * optionally filtered by exam/topic. Authoritative sources get a small ranking boost.
   */
  async retrieve(query: string, opts: { userId: string; examId?: string | null; topicId?: string | null; limit?: number; minScore?: number }): Promise<RetrievedChunk[]> {
    const ents = await this.entitlements.getActive(opts.userId);
    const features = ents.map((e) => e.featureKey);
    const emb = await this.gateway.embed([query], { userId: opts.userId, feature: 'knowledge.retrieve' });
    const literal = `[${emb.vectors[0].join(',')}]`;
    const limit = Math.min(opts.limit ?? 6, 20);
    const rows = await this.prisma.$queryRaw<Array<{ chunkId: string; sourceId: string; title: string; content: string; distance: number; isAuthoritative: boolean; sourceUrl: string | null }>>`
      SELECT c.id AS "chunkId", s.id AS "sourceId", s.title, c.content, s."isAuthoritative", s."sourceUrl",
             (e.embedding <=> ${literal}::vector) AS distance
        FROM chunk_embeddings e
        JOIN document_chunks c ON c.id = e."chunkId"
        JOIN knowledge_sources s ON s.id = c."sourceId"
       WHERE s.status = 'INDEXED'
         AND e.model = ${emb.model}
         AND (s.visibility = 'PUBLIC' OR (s.visibility = 'ENTITLED' AND s."requiredFeature" = ANY(${features}::text[])))
         AND (${opts.examId ?? null}::uuid IS NULL OR s."examId" IS NULL OR s."examId" = ${opts.examId ?? null}::uuid)
         AND (${opts.topicId ?? null}::uuid IS NULL OR s."topicId" IS NULL OR s."topicId" = ${opts.topicId ?? null}::uuid)
       ORDER BY e.embedding <=> ${literal}::vector
       LIMIT ${limit * 2}`;
    const minScore = opts.minScore ?? 0.15;
    return rows
      .map((r) => ({
        chunkId: r.chunkId,
        sourceId: r.sourceId,
        title: r.title,
        content: r.content,
        isAuthoritative: r.isAuthoritative,
        sourceUrl: r.sourceUrl,
        score: Math.round((1 - Number(r.distance) + (r.isAuthoritative ? 0.05 : 0)) * 10000) / 10000,
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
