import { QuestionType } from '@prisma/client';
import type { Centi } from '../../common/utils/marks.util';
import { normalizeAnswer } from '../../common/utils/text.util';

/**
 * Deterministic, side-effect-free scoring engine. All marks are integer hundredths ("centi") so the
 * result is exact and reproducible. Bump SCORING_VERSION whenever the rules below change; it is stored
 * on every result so historic scores can always be explained.
 */
export const SCORING_VERSION = '2026.1';

export type MultiSelectPolicy = 'EXACT' | 'PARTIAL';

export interface ScoringRules {
  multiSelectPolicy: MultiSelectPolicy;
  allowNegativeTotal: boolean;
  passMarksCenti: Centi | null;
}

export interface ScoringItem {
  id: string;
  sectionId: string;
  type: QuestionType;
  optionIds: string[];
  correctOptionIds: string[];
  acceptedAnswers: string[];
  maxMarksCenti: Centi;
  negativeCenti: Centi;
  selectedOptionIds: string[];
  textAnswer: string | null;
  /** Evaluator-awarded marks for WRITTEN/VIVA (null = not evaluated yet). */
  manualAwardCenti: Centi | null;
}

export type ItemOutcome = 'CORRECT' | 'PARTIAL' | 'WRONG' | 'SKIPPED' | 'PENDING_MANUAL' | 'MANUAL';

export interface ItemScore {
  id: string;
  outcome: ItemOutcome;
  awardedCenti: Centi | null;
  isCorrect: boolean | null;
}

export interface SectionScore {
  sectionId: string;
  maxCenti: Centi;
  obtainedCenti: Centi;
  correct: number;
  partial: number;
  wrong: number;
  skipped: number;
  pending: number;
}

export interface AttemptScore {
  totalCenti: Centi;
  obtainedCenti: Centi;
  correct: number;
  partial: number;
  wrong: number;
  skipped: number;
  pending: number;
  /** Percentage of attempted objective items answered fully correctly (0–100, 2dp). */
  accuracy: number;
  passed: boolean | null;
  sections: SectionScore[];
  items: ItemScore[];
}

const setEq = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function scoreItem(item: ScoringItem, policy: MultiSelectPolicy): ItemScore {
  const base = { id: item.id };
  const selected = [...new Set(item.selectedOptionIds)];

  switch (item.type) {
    case QuestionType.SINGLE_CHOICE:
    case QuestionType.TRUE_FALSE:
    case QuestionType.MULTIPLE_CHOICE: {
      if (!selected.length) return { ...base, outcome: 'SKIPPED', awardedCenti: 0, isCorrect: null };
      // Any id that does not belong to the question version is treated as wrong (defence in depth).
      const invalid = selected.some((id) => !item.optionIds.includes(id));
      if (!invalid && setEq(selected, item.correctOptionIds)) {
        return { ...base, outcome: 'CORRECT', awardedCenti: item.maxMarksCenti, isCorrect: true };
      }
      if (item.type === QuestionType.MULTIPLE_CHOICE && policy === 'PARTIAL' && !invalid) {
        const wrongPicked = selected.some((id) => !item.correctOptionIds.includes(id));
        if (!wrongPicked) {
          const award = Math.floor((item.maxMarksCenti * selected.length) / item.correctOptionIds.length);
          return { ...base, outcome: 'PARTIAL', awardedCenti: award, isCorrect: false };
        }
      }
      return { ...base, outcome: 'WRONG', awardedCenti: -item.negativeCenti, isCorrect: false };
    }
    case QuestionType.SHORT_ANSWER: {
      const text = item.textAnswer?.trim();
      if (!text) return { ...base, outcome: 'SKIPPED', awardedCenti: 0, isCorrect: null };
      const ok = item.acceptedAnswers.some((a) => normalizeAnswer(a) === normalizeAnswer(text));
      return ok
        ? { ...base, outcome: 'CORRECT', awardedCenti: item.maxMarksCenti, isCorrect: true }
        : { ...base, outcome: 'WRONG', awardedCenti: -item.negativeCenti, isCorrect: false };
    }
    case QuestionType.WRITTEN:
    case QuestionType.VIVA: {
      const answered = !!item.textAnswer?.trim() || item.type === QuestionType.VIVA;
      if (!answered) return { ...base, outcome: 'SKIPPED', awardedCenti: 0, isCorrect: null };
      if (item.manualAwardCenti === null) return { ...base, outcome: 'PENDING_MANUAL', awardedCenti: null, isCorrect: null };
      const award = Math.min(Math.max(item.manualAwardCenti, 0), item.maxMarksCenti);
      return { ...base, outcome: 'MANUAL', awardedCenti: award, isCorrect: null };
    }
  }
}

export function scoreAttempt(items: ScoringItem[], rules: ScoringRules, sectionOrder: string[]): AttemptScore {
  const scored = items.map((i) => scoreItem(i, rules.multiSelectPolicy));
  const sections = new Map<string, SectionScore>(
    sectionOrder.map((id) => [id, { sectionId: id, maxCenti: 0, obtainedCenti: 0, correct: 0, partial: 0, wrong: 0, skipped: 0, pending: 0 }]),
  );
  items.forEach((item, idx) => {
    const s = scored[idx];
    let sec = sections.get(item.sectionId);
    if (!sec) {
      sec = { sectionId: item.sectionId, maxCenti: 0, obtainedCenti: 0, correct: 0, partial: 0, wrong: 0, skipped: 0, pending: 0 };
      sections.set(item.sectionId, sec);
    }
    sec.maxCenti += item.maxMarksCenti;
    sec.obtainedCenti += s.awardedCenti ?? 0;
    if (s.outcome === 'CORRECT') sec.correct++;
    else if (s.outcome === 'PARTIAL') sec.partial++;
    else if (s.outcome === 'WRONG') sec.wrong++;
    else if (s.outcome === 'SKIPPED') sec.skipped++;
    else if (s.outcome === 'PENDING_MANUAL') sec.pending++;
  });

  const list = [...sections.values()];
  if (!rules.allowNegativeTotal) for (const s of list) s.obtainedCenti = Math.max(0, s.obtainedCenti);
  const totalCenti = list.reduce((n, s) => n + s.maxCenti, 0);
  let obtainedCenti = list.reduce((n, s) => n + s.obtainedCenti, 0);
  if (!rules.allowNegativeTotal) obtainedCenti = Math.max(0, obtainedCenti);
  obtainedCenti = Math.min(obtainedCenti, totalCenti);

  const sum = (k: keyof Omit<SectionScore, 'sectionId' | 'maxCenti' | 'obtainedCenti'>) => list.reduce((n, s) => n + s[k], 0);
  const correct = sum('correct');
  const wrong = sum('wrong');
  const partial = sum('partial');
  const attempted = correct + wrong + partial;
  const pending = sum('pending');

  return {
    totalCenti,
    obtainedCenti,
    correct,
    partial,
    wrong,
    skipped: sum('skipped'),
    pending,
    accuracy: attempted ? Math.round((correct / attempted) * 10000) / 100 : 0,
    passed: rules.passMarksCenti === null || pending > 0 ? null : obtainedCenti >= rules.passMarksCenti,
    sections: list,
    items: scored,
  };
}
