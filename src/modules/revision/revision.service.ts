import { Injectable } from '@nestjs/common';
import { Prisma, RevisionItemType } from '@prisma/client';
import { PageResult, pageArgs, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { AppError } from '../../common/errors/app-error';
import type { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../prisma/prisma.service';
import { sm2 } from '../learning/engine';
import { NotificationsService } from '../notifications/notifications.service';
import { toAnswerKey, toStudentView } from '../questions/question-views';
import { QuestionsService } from '../questions/questions.service';
import { PERMISSIONS } from '../rbac/permissions';
import { FlashcardDto, FlashcardQueryDto, UpdateFlashcardDto } from './revision.dto';

@Injectable()
export class RevisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly questions: QuestionsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Items due now (topics, wrong-answer questions, flashcards), most overdue first. */
  async due(userId: string, limit = 50, type?: RevisionItemType) {
    const items = await this.prisma.revisionSchedule.findMany({
      where: { userId, dueAt: { lte: new Date() }, itemType: type },
      orderBy: { dueAt: 'asc' },
      take: Math.min(limit, 200),
      include: { topic: { select: { id: true, name: true, nameBn: true } }, flashcard: true },
    });
    const questionIds = items.filter((i) => i.questionId).map((i) => i.questionId!);
    const qs = await this.prisma.question.findMany({ where: { id: { in: questionIds }, publishedVersionId: { not: null }, deletedAt: null }, select: { id: true, publishedVersionId: true } });
    const versions = await this.questions.loadVersions(qs.map((q) => q.publishedVersionId!));
    const vByQ = new Map(qs.map((q) => [q.id, versions.get(q.publishedVersionId!)!]));
    const total = await this.prisma.revisionSchedule.count({ where: { userId, dueAt: { lte: new Date() }, itemType: type } });
    return {
      totalDue: total,
      items: items
        .map((i) => ({
          id: i.id,
          itemType: i.itemType,
          dueAt: i.dueAt,
          intervalDays: i.intervalDays,
          repetitions: i.repetitions,
          lapses: i.lapses,
          topic: i.topic,
          flashcard: i.flashcard ? { id: i.flashcard.id, front: i.flashcard.front, back: i.flashcard.back, deck: i.flashcard.deck } : null,
          // The student already answered this question before; showing the key here supports revision.
          question: i.questionId && vByQ.get(i.questionId) ? { ...toStudentView(vByQ.get(i.questionId)!), answerKey: toAnswerKey(vByQ.get(i.questionId)!) } : null,
        }))
        .filter((i) => i.itemType !== RevisionItemType.QUESTION || i.question),
    };
  }

  async review(userId: string, itemId: string, quality: number) {
    const item = await this.prisma.revisionSchedule.findUnique({ where: { id: itemId } });
    if (!item || item.userId !== userId) throw AppError.notFound('Revision item');
    const now = new Date();
    const next = sm2(item, quality, now);
    const updated = await this.prisma.revisionSchedule.update({ where: { id: itemId }, data: { ...next, lastReviewedAt: now, lastQuality: quality } });
    if (item.topicId && item.itemType === RevisionItemType.TOPIC) {
      await this.prisma.topicMastery.updateMany({ where: { userId, topicId: item.topicId }, data: { lastRevisedAt: now } });
    }
    return { id: updated.id, dueAt: updated.dueAt, intervalDays: updated.intervalDays, easeFactor: updated.easeFactor, repetitions: updated.repetitions };
  }

  /** Wrong-answer history across practice and exams (latest first). */
  async wrongAnswers(userId: string, q: PaginationQueryDto) {
    const rows = await this.prisma.$queryRaw<Array<{ questionId: string; versionId: string; source: string; answeredAt: Date; total: bigint }>>`
      SELECT * , COUNT(*) OVER() AS total FROM (
        SELECT pa."questionId", pa."questionVersionId" AS "versionId", 'PRACTICE' AS source, pa."answeredAt"
          FROM practice_answers pa JOIN practice_sessions ps ON ps.id = pa."sessionId"
          WHERE ps."userId" = ${userId}::uuid AND pa."isCorrect" = false
        UNION ALL
        SELECT aa."questionId", aa."questionVersionId", 'EXAM', COALESCE(aa."answeredAt", ea."submittedAt")
          FROM attempt_answers aa JOIN exam_attempts ea ON ea.id = aa."attemptId"
          WHERE ea."userId" = ${userId}::uuid AND aa."isCorrect" = false AND ea.status IN ('EVALUATED','PENDING_MANUAL_REVIEW')
      ) w ORDER BY "answeredAt" DESC NULLS LAST
      OFFSET ${(q.page - 1) * q.pageSize} LIMIT ${q.pageSize}`;
    const versions = await this.questions.loadVersions(rows.map((r) => r.versionId));
    return PageResult.of(
      rows.map((r) => {
        const v = versions.get(r.versionId)!;
        return { source: r.source, answeredAt: r.answeredAt, question: toStudentView(v), answerKey: toAnswerKey(v) };
      }),
      rows.length ? Number(rows[0].total) : 0,
      q,
    );
  }

  /** Scheduled: nudge users who have revision items due. */
  async sendDueReminders(): Promise<number> {
    const groups = await this.prisma.revisionSchedule.groupBy({
      by: ['userId'],
      where: { dueAt: { lte: new Date() }, user: { status: 'ACTIVE' } },
      _count: { _all: true },
    });
    const day = new Date().toISOString().slice(0, 10);
    for (const g of groups) {
      await this.notifications.notify(g.userId, {
        type: 'revision.due',
        title: 'আজকের রিভিশন অপেক্ষা করছে',
        body: `You have ${g._count._all} item(s) due for revision today.`,
        data: { count: g._count._all },
        channels: ['IN_APP', 'PUSH'],
        dedupeKey: `revision:${g.userId}:${day}`,
      });
    }
    return groups.length;
  }

  // ───────── Flashcards ─────────

  async listFlashcards(user: AuthUser, q: FlashcardQueryDto) {
    const where: Prisma.FlashcardWhereInput = {
      OR: q.scope === 'mine' ? [{ ownerId: user.id }] : q.scope === 'public' ? [{ isPublic: true, ownerId: null }] : [{ ownerId: user.id }, { isPublic: true, ownerId: null }],
      topicId: q.topicId,
      deck: q.deck,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.flashcard.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
      this.prisma.flashcard.count({ where }),
    ]);
    return PageResult.of(items, total, q);
  }

  async decks(userId: string) {
    const rows = await this.prisma.flashcard.groupBy({
      by: ['deck', 'ownerId'],
      where: { OR: [{ ownerId: userId }, { isPublic: true, ownerId: null }] },
      _count: { _all: true },
    });
    return rows.map((r) => ({ deck: r.deck, system: r.ownerId === null, cardCount: r._count._all }));
  }

  /** Students create private cards; staff with flashcards.manage create public system cards. */
  async createFlashcard(user: AuthUser, dto: FlashcardDto) {
    const system = !!dto.isPublic;
    if (system && !user.permissions.includes(PERMISSIONS.FLASHCARDS_MANAGE)) throw AppError.forbidden('Only staff can create public flashcards');
    if (dto.topicId && !(await this.prisma.topic.count({ where: { id: dto.topicId } }))) throw AppError.badRequest('INVALID_TOPIC', 'Topic not found');
    const card = await this.prisma.flashcard.create({
      data: { ownerId: system ? null : user.id, topicId: dto.topicId, deck: dto.deck ?? 'default', front: dto.front, back: dto.back, isPublic: system },
    });
    if (!system) await this.schedule(user.id, card.id);
    return card;
  }

  async updateFlashcard(user: AuthUser, id: string, dto: UpdateFlashcardDto) {
    const card = await this.editable(user, id);
    return this.prisma.flashcard.update({ where: { id: card.id }, data: dto });
  }

  async deleteFlashcard(user: AuthUser, id: string) {
    const card = await this.editable(user, id);
    await this.prisma.flashcard.delete({ where: { id: card.id } });
    return { ok: true };
  }

  /** Adds cards (own or public) to the user's spaced-repetition schedule. */
  async study(userId: string, cardIds: string[]) {
    const cards = await this.prisma.flashcard.findMany({ where: { id: { in: cardIds }, OR: [{ ownerId: userId }, { isPublic: true, ownerId: null }] }, select: { id: true } });
    for (const c of cards) await this.schedule(userId, c.id);
    return { scheduled: cards.length };
  }

  private async schedule(userId: string, flashcardId: string) {
    const itemKey = `FLASHCARD:${flashcardId}`;
    await this.prisma.revisionSchedule.upsert({
      where: { userId_itemKey: { userId, itemKey } },
      create: { userId, itemType: RevisionItemType.FLASHCARD, itemKey, flashcardId, dueAt: new Date() },
      update: {},
    });
  }

  private async editable(user: AuthUser, id: string) {
    const card = await this.prisma.flashcard.findUnique({ where: { id } });
    if (!card) throw AppError.notFound('Flashcard');
    const isOwner = card.ownerId === user.id;
    const isStaff = card.ownerId === null && user.permissions.includes(PERMISSIONS.FLASHCARDS_MANAGE);
    if (!isOwner && !isStaff) throw AppError.notFound('Flashcard');
    return card;
  }
}
