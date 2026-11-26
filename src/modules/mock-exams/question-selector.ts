import { Injectable } from '@nestjs/common';
import { Difficulty, Prisma, QuestionType, SelectionMode } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import { sample, shuffle } from '../../common/utils/random.util';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AUTO_GRADED_TYPES } from '../questions/question-content';
import { PUBLISHED_QUESTION } from '../questions/questions.service';

export interface SectionPoolSpec {
  subjectId?: string | null;
  topicIds?: string[];
  questionTypes?: QuestionType[];
  difficultyMix?: Partial<Record<Difficulty, number>> | null;
}

export interface Candidate {
  questionId: string;
  versionId: string;
  difficulty: Difficulty;
}

/** Splits n across weights using the largest-remainder method (sums exactly to n). */
export function allocate(
  n: number,
  weights: Partial<Record<Difficulty, number>>,
): Record<Difficulty, number> {
  const keys = [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD];
  const total = keys.reduce((s, k) => s + (weights[k] ?? 0), 0);
  if (total <= 0) return { EASY: 0, MEDIUM: n, HARD: 0 };
  const raw = keys.map((k) => ((weights[k] ?? 0) / total) * n);
  const floors = raw.map(Math.floor);
  let rest = n - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest-- <= 0) break;
    floors[i]++;
  }
  return { EASY: floors[0], MEDIUM: floors[1], HARD: floors[2] };
}

/**
 * Picks `count` candidates honouring the difficulty mix where possible; any shortfall in one difficulty
 * is filled from the remaining pool so the section is always complete.
 */
export function pickWithMix(
  pool: Candidate[],
  count: number,
  mix: Partial<Record<Difficulty, number>> | null | undefined,
  rand: () => number,
): Candidate[] {
  if (pool.length < count) throw new Error('pool too small');
  if (!mix) return sample(pool, count, rand);
  const target = allocate(count, mix);
  const chosen: Candidate[] = [];
  const used = new Set<string>();
  for (const d of [Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD]) {
    const picks = sample(
      pool.filter((c) => c.difficulty === d),
      target[d],
      rand,
    );
    picks.forEach((p) => {
      chosen.push(p);
      used.add(p.questionId);
    });
  }
  if (chosen.length < count) {
    chosen.push(
      ...sample(
        pool.filter((c) => !used.has(c.questionId)),
        count - chosen.length,
        rand,
      ),
    );
  }
  return shuffle(chosen, rand);
}

@Injectable()
export class QuestionSelector {
  constructor(private readonly prisma: PrismaService) {}

  poolWhere(spec: SectionPoolSpec, excludeIds: string[] = []): Prisma.QuestionWhereInput {
    const types = spec.questionTypes?.length ? spec.questionTypes : AUTO_GRADED_TYPES;
    return {
      ...PUBLISHED_QUESTION,
      id: excludeIds.length ? { notIn: excludeIds } : undefined,
      subjectId: spec.subjectId ?? undefined,
      type: { in: types },
      OR: spec.topicIds?.length
        ? [{ topicId: { in: spec.topicIds } }, { topics: { some: { topicId: { in: spec.topicIds } } } }]
        : undefined,
    };
  }

  async poolSize(spec: SectionPoolSpec, client: PrismaService | Tx = this.prisma): Promise<number> {
    return client.question.count({ where: this.poolWhere(spec) });
  }

  async candidates(
    spec: SectionPoolSpec,
    excludeIds: string[],
    client: PrismaService | Tx = this.prisma,
  ): Promise<Candidate[]> {
    const rows = await client.question.findMany({
      where: this.poolWhere(spec, excludeIds),
      select: { id: true, publishedVersionId: true, difficulty: true },
      take: 5000,
    });
    return rows.map((r) => ({
      questionId: r.id,
      versionId: r.publishedVersionId!,
      difficulty: r.difficulty,
    }));
  }

  /** Builds the concrete question list for one section of a new attempt. */
  async selectForSection(
    section: {
      id: string;
      selectionMode: SelectionMode;
      questionCount: number;
      subjectId: string | null;
      topicIds: string[];
      questionTypes: QuestionType[];
      difficultyMix: Prisma.JsonValue;
      questions: { questionVersionId: string; position: number; questionVersion: { questionId: string } }[];
    },
    exclude: Set<string>,
    rand: () => number,
    tx: Tx,
  ): Promise<Array<{ questionId: string; versionId: string }>> {
    if (section.selectionMode === SelectionMode.FIXED) {
      return [...section.questions]
        .sort((a, b) => a.position - b.position)
        .map((q) => ({ questionId: q.questionVersion.questionId, versionId: q.questionVersionId }));
    }
    const pool = await this.candidates(
      {
        subjectId: section.subjectId,
        topicIds: section.topicIds,
        questionTypes: section.questionTypes,
        difficultyMix: section.difficultyMix as never,
      },
      [...exclude],
      tx,
    );
    if (pool.length < section.questionCount) {
      throw AppError.conflict(
        'QUESTION_POOL_EXHAUSTED',
        'Not enough published questions are currently available for this exam; please try later',
      );
    }
    return pickWithMix(
      pool,
      section.questionCount,
      section.difficultyMix as Partial<Record<Difficulty, number>> | null,
      rand,
    ).map((c) => ({ questionId: c.questionId, versionId: c.versionId }));
  }
}
