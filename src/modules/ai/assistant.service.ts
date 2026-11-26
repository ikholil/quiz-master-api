import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { AiMessageRole, AiMessageStatus, ContentStatus, Difficulty, Prisma, QuestionSourceType, QuestionType } from '@prisma/client';
import { Queue } from 'bullmq';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import { dhakaDate, dhakaDayStartUtc } from '../../common/utils/date.util';
import type { AuthUser, RequestContext } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { AuditService } from '../audit/audit.service';
import { KnowledgeService, RetrievedChunk } from '../knowledge/knowledge.service';
import { validateQuestionContent } from '../questions/question-content';
import { QuestionsService } from '../questions/questions.service';
import { RbacService } from '../rbac/rbac.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { FEATURES } from '../subscriptions/features';
import { AiGatewayService } from './ai-gateway.service';
import { CreateConversationDto, FeedbackDto, GenerateQuestionsDto, PromptTemplateDto, SendMessageDto } from './ai.dto';
import { DEFAULT_PROMPTS, OFFICIAL_FACT_FALLBACK, isOfficialFactQuestion, render } from './prompts';

const HISTORY_TURNS = 10;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly knowledge: KnowledgeService,
    private readonly entitlements: EntitlementsService,
    private readonly questions: QuestionsService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.AI) private readonly queue: Queue,
  ) {}

  // ───────── Conversations ─────────

  async createConversation(userId: string, dto: CreateConversationDto) {
    return this.prisma.aiConversation.create({ data: { userId, title: dto.title, examId: dto.examId, topicId: dto.topicId } });
  }

  async listConversations(userId: string, q: PaginationQueryDto) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aiConversation.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.aiConversation.count({ where: { userId } }),
    ]);
    return PageResult.of(items, total, q);
  }

  async getConversation(userId: string, id: string) {
    const c = await this.ownedConversation(userId, id);
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId: id, role: { not: AiMessageRole.SYSTEM } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true, status: true, citations: true, feedbackRating: true, createdAt: true, completedAt: true },
    });
    return { ...c, messages };
  }

  async deleteConversation(userId: string, id: string) {
    await this.ownedConversation(userId, id);
    await this.prisma.aiConversation.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Stores the student's message and a PENDING assistant message, then queues generation. The client polls
   * GET /ai/messages/:id (or the conversation) until status is COMPLETED/FAILED.
   */
  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const conv = await this.ownedConversation(userId, conversationId);
    const usage = await this.quota(userId);
    if (usage.remaining !== null && usage.remaining <= 0) throw AppError.paymentRequired(FEATURES.AI_ASSISTANT);
    const pending = await this.prisma.aiMessage.count({ where: { conversationId, status: AiMessageStatus.PENDING } });
    if (pending) throw AppError.conflict('REPLY_IN_PROGRESS', 'Wait for the current reply to finish');

    const [userMsg, assistantMsg] = await this.prisma.$transaction([
      this.prisma.aiMessage.create({ data: { conversationId, role: AiMessageRole.USER, content: dto.content } }),
      this.prisma.aiMessage.create({ data: { conversationId, role: AiMessageRole.ASSISTANT, content: '', status: AiMessageStatus.PENDING } }),
      this.prisma.aiConversation.update({ where: { id: conversationId }, data: { title: conv.title ?? dto.content.slice(0, 80), updatedAt: new Date() } }),
    ]);
    await this.queue.add(JOBS.AI_REPLY, { messageId: assistantMsg.id }, { jobId: `ai-reply-${assistantMsg.id}`, attempts: 2 });
    return { userMessageId: userMsg.id, assistantMessageId: assistantMsg.id, status: AiMessageStatus.PENDING, remainingToday: usage.remaining === null ? null : usage.remaining - 1 };
  }

  async getMessage(userId: string, messageId: string) {
    const m = await this.prisma.aiMessage.findUnique({ where: { id: messageId }, include: { conversation: { select: { userId: true } } } });
    if (!m || m.conversation.userId !== userId) throw AppError.notFound('Message');
    return { id: m.id, role: m.role, content: m.content, status: m.status, citations: m.citations, createdAt: m.createdAt, completedAt: m.completedAt };
  }

  async feedback(userId: string, messageId: string, dto: FeedbackDto) {
    const m = await this.prisma.aiMessage.findUnique({ where: { id: messageId }, include: { conversation: { select: { userId: true } } } });
    if (!m || m.conversation.userId !== userId || m.role !== AiMessageRole.ASSISTANT) throw AppError.notFound('Message');
    await this.prisma.aiMessage.update({ where: { id: messageId }, data: { feedbackRating: dto.rating, feedbackText: dto.comment } });
    return { ok: true };
  }

  async quota(userId: string) {
    const limit = await this.entitlements.dailyLimit(userId, FEATURES.AI_ASSISTANT);
    const used = await this.prisma.aiMessage.count({
      where: { role: AiMessageRole.USER, conversation: { userId }, createdAt: { gte: dhakaDayStartUtc(dhakaDate()) } },
    });
    return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
  }

  // ───────── Generation (background) ─────────

  async generateReply(messageId: string): Promise<void> {
    const msg = await this.prisma.aiMessage.findUnique({ where: { id: messageId }, include: { conversation: true } });
    if (!msg || msg.status !== AiMessageStatus.PENDING) return;
    const conv = msg.conversation;
    const history = await this.prisma.aiMessage.findMany({
      where: { conversationId: conv.id, createdAt: { lte: msg.createdAt }, id: { not: msg.id }, status: AiMessageStatus.COMPLETED, role: { in: [AiMessageRole.USER, AiMessageRole.ASSISTANT] } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_TURNS * 2,
    });
    const turns = history.reverse();
    const question = [...turns].reverse().find((t) => t.role === AiMessageRole.USER)?.content ?? '';

    try {
      const sources = await this.knowledge.retrieve(question, { userId: conv.userId, examId: conv.examId, topicId: conv.topicId, limit: 6 }).catch((err: Error) => {
        this.logger.warn(`Retrieval failed: ${err.message}`);
        return [] as RetrievedChunk[];
      });

      // Guardrail: official facts are answered only from authoritative sources, never generated.
      if (isOfficialFactQuestion(question) && !sources.some((s) => s.isAuthoritative)) {
        await this.complete(msg.id, OFFICIAL_FACT_FALLBACK, [], 'guardrail', 'none');
        return;
      }

      const prompt = await this.prompt('assistant.chat');
      const sourceBlock = sources.length
        ? `\n\nSOURCES:\n${sources.map((s, i) => `[${i + 1}] ${s.title}${s.isAuthoritative ? ' (AUTHORITATIVE)' : ''}\n${s.content}`).join('\n\n')}`
        : '\n\nSOURCES: none found for this question.';
      const messages = turns
        .filter((t) => t.content.trim())
        .map((t) => ({ role: t.role === AiMessageRole.USER ? ('user' as const) : ('assistant' as const), content: t.content }));
      // Ensure the conversation starts with a user turn.
      while (messages.length && messages[0].role !== 'user') messages.shift();

      const result = await this.gateway.chat(
        { system: prompt.system + sourceBlock, messages, maxTokens: 4000, contextPassages: sources.map((s) => s.content) },
        { userId: conv.userId, feature: 'assistant.chat' },
      );
      const text = result.refused
        ? 'দুঃখিত, এই অনুরোধে আমি সাহায্য করতে পারছি না। Sorry, I can’t help with that request. Please ask a study-related question.'
        : result.text || 'I could not produce an answer. Please rephrase your question.';
      const citations = sources.map((s, i) => ({ index: i + 1, sourceId: s.sourceId, chunkId: s.chunkId, title: s.title, score: s.score, sourceUrl: s.sourceUrl, authoritative: s.isAuthoritative }));
      await this.complete(msg.id, text, citations, result.provider, result.model);
    } catch (err) {
      this.logger.error(`AI reply ${messageId} failed: ${(err as Error).message}`);
      await this.prisma.aiMessage.update({
        where: { id: msg.id },
        data: { status: AiMessageStatus.FAILED, content: 'The assistant is temporarily unavailable. Please try again shortly.', error: (err as Error).message.slice(0, 500), completedAt: new Date() },
      });
    }
  }

  private async complete(id: string, content: string, citations: unknown[], provider: string, model: string) {
    await this.prisma.aiMessage.update({
      where: { id },
      data: { content, citations: citations as Prisma.InputJsonValue, provider, model, status: AiMessageStatus.COMPLETED, completedAt: new Date() },
    });
  }

  async prompt(key: string): Promise<{ system: string; userTemplate: string }> {
    const row = await this.prisma.promptTemplate.findFirst({ where: { key, isActive: true } });
    if (row) return { system: row.system, userTemplate: row.userTemplate };
    const def = DEFAULT_PROMPTS[key];
    if (!def) throw new Error(`Unknown prompt template ${key}`);
    return def;
  }

  // ───────── AI question drafting (admin) ─────────

  async requestQuestionGeneration(dto: GenerateQuestionsDto, actor: AuthUser, ctx: RequestContext) {
    const topic = await this.prisma.topic.findUnique({ where: { id: dto.topicId }, include: { chapter: { include: { subject: true } } } });
    if (!topic) throw AppError.notFound('Topic');
    const job = await this.queue.add('generate-questions', { ...dto, actorId: actor.id });
    await this.audit.record({ actorId: actor.id, action: 'ai.questions.generate', entityType: 'Topic', entityId: dto.topicId, metadata: { ...dto, jobId: job.id }, ctx });
    return { queued: true, jobId: job.id, note: 'Generated questions are saved as DRAFT, AI_GENERATED, and must be reviewed by a different staff member before publication.' };
  }

  async generateQuestions(data: GenerateQuestionsDto & { actorId: string }): Promise<{ created: number; rejected: number }> {
    const topic = await this.prisma.topic.findUniqueOrThrow({ where: { id: data.topicId }, include: { chapter: { include: { subject: true } } } });
    const prompt = await this.prompt('questions.generate');
    const context = await this.knowledge.retrieve(topic.name, { userId: data.actorId, topicId: topic.id, limit: 4 }).catch(() => []);
    const result = await this.gateway.chat(
      {
        system: prompt.system,
        messages: [
          {
            role: 'user',
            content: render(prompt.userTemplate, {
              topic: topic.name,
              subject: topic.chapter.subject.name,
              difficulty: data.difficulty ?? 'MEDIUM',
              language: data.language ?? 'bn',
              count: data.count,
              context: context.length ? `\n\nReference material:\n${context.map((c) => c.content).join('\n---\n')}` : '',
            }),
          },
        ],
        maxTokens: 8000,
      },
      { userId: data.actorId, feature: 'questions.generate' },
    );
    if (result.provider === 'local') throw new Error('Question generation requires an external AI provider');

    let items: Array<{ stem: string; options: Array<{ key: string; text: string }>; correct: string; explanation?: string }>;
    try {
      const json = result.text.slice(result.text.indexOf('['), result.text.lastIndexOf(']') + 1);
      items = JSON.parse(json);
      if (!Array.isArray(items)) throw new Error('not an array');
    } catch {
      throw new Error('AI response was not valid JSON');
    }

    const access = await this.rbac.getAccess(data.actorId);
    const actor = { id: data.actorId, sessionId: 'ai', roles: access.roles, permissions: access.permissions };
    let source = await this.prisma.questionSource.findFirst({ where: { type: QuestionSourceType.AI_GENERATED, title: 'AI draft' } });
    source ??= await this.prisma.questionSource.create({ data: { type: QuestionSourceType.AI_GENERATED, title: 'AI draft', isOfficial: false } });

    let created = 0;
    let rejected = 0;
    for (const item of items.slice(0, data.count)) {
      const content = {
        stem: String(item.stem ?? ''),
        options: (item.options ?? []).slice(0, 8).map((o) => ({ key: String(o.key).toUpperCase(), text: String(o.text ?? ''), isCorrect: String(o.key).toUpperCase() === String(item.correct).toUpperCase() })),
        explanation: item.explanation ? { content: String(item.explanation) } : undefined,
      };
      if (validateQuestionContent(QuestionType.SINGLE_CHOICE, content).length) {
        rejected++;
        continue;
      }
      await this.questions.create(
        {
          type: QuestionType.SINGLE_CHOICE,
          difficulty: (data.difficulty as Difficulty) ?? Difficulty.MEDIUM,
          subjectId: topic.chapter.subjectId,
          topicId: topic.id,
          sourceId: source.id,
          aiGenerated: true,
          tags: ['ai-draft'],
          content,
        },
        actor,
      );
      created++;
    }
    this.logger.log(`AI drafted ${created} questions for topic ${topic.name} (${rejected} rejected by validation)`);
    return { created, rejected };
  }

  // ───────── Admin: usage & prompts ─────────

  async usageSummary(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.aiUsageRecord.groupBy({
      by: ['provider', 'model', 'feature', 'status'],
      where: { createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true },
      _count: { _all: true },
      _avg: { latencyMs: true },
    });
    const feedback = await this.prisma.aiMessage.groupBy({ by: ['feedbackRating'], where: { createdAt: { gte: since }, feedbackRating: { not: null } }, _count: { _all: true } });
    return {
      since,
      rows: rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        feature: r.feature,
        status: r.status,
        calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        estimatedCostUsd: (r._sum.estimatedCostMicros ?? 0) / 1_000_000,
        avgLatencyMs: Math.round(r._avg.latencyMs ?? 0),
      })),
      feedback: Object.fromEntries(feedback.map((f) => [f.feedbackRating === 1 ? 'helpful' : 'notHelpful', f._count._all])),
    };
  }

  listPrompts() {
    return this.prisma.promptTemplate.findMany({ orderBy: [{ key: 'asc' }, { version: 'desc' }] });
  }

  async createPrompt(dto: PromptTemplateDto, actorId: string, ctx: RequestContext) {
    const latest = await this.prisma.promptTemplate.findFirst({ where: { key: dto.key }, orderBy: { version: 'desc' } });
    const row = await this.prisma.promptTemplate.create({ data: { ...dto, version: (latest?.version ?? 0) + 1, isActive: false } });
    await this.audit.record({ actorId, action: 'ai.prompt.create', entityType: 'PromptTemplate', entityId: row.id, after: { key: dto.key, version: row.version }, ctx });
    return row;
  }

  async activatePrompt(id: string, actorId: string, ctx: RequestContext) {
    const row = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Prompt template');
    await this.prisma.$transaction([
      this.prisma.promptTemplate.updateMany({ where: { key: row.key, isActive: true }, data: { isActive: false } }),
      this.prisma.promptTemplate.update({ where: { id }, data: { isActive: true } }),
    ]);
    await this.audit.record({ actorId, action: 'ai.prompt.activate', entityType: 'PromptTemplate', entityId: id, ctx });
    return { id, key: row.key, version: row.version, isActive: true };
  }

  private async ownedConversation(userId: string, id: string) {
    const c = await this.prisma.aiConversation.findUnique({ where: { id } });
    if (!c || c.userId !== userId) throw AppError.notFound('Conversation');
    return c;
  }
}

export { ContentStatus };
