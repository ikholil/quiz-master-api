import { createHash } from 'node:crypto';
import { seededRandom, shuffle } from '../../src/common/utils/random.util';

export type Diff = 'EASY' | 'MEDIUM' | 'HARD';
export type ExamFit = 'bcs' | 'bank' | 'ntrca' | 'primary-teacher' | 'admission' | 'govt-jobs';

export interface BankQuestion {
  /** Stable key — the loader derives the content hash from it, so re-running never duplicates. */
  key: string;
  subject: string;
  chapter: string;
  topic: string;
  difficulty: Diff;
  stem: string;
  options: string[];
  /** Index into options of the single correct answer. */
  correct: number;
  explanation: string;
  tags?: string[];
  exams: ExamFit[];
}

export const ALL_EXAMS: ExamFit[] = ['bcs', 'bank', 'ntrca', 'primary-teacher', 'admission', 'govt-jobs'];
export const JOB_EXAMS: ExamFit[] = ['bcs', 'bank', 'ntrca', 'primary-teacher', 'govt-jobs'];

/**
 * Builds a question with the correct answer placed at a deterministic, key-dependent position.
 * Throws if options are not unique or the answer is among the distractors — generators are verified at build time.
 */
export function q(
  base: Omit<BankQuestion, 'options' | 'correct'> & { answer: string; distractors: string[] },
): BankQuestion {
  let distractors = [...new Set(base.distractors.map(String))].filter((d) => d !== base.answer);
  if (distractors.length < 3) {
    // Numeric answers with an optional unit ("40 km", "12%", "−3"): top up with computed near-miss values.
    const m = /^(-?\d+(?:\.\d+)?)(.*)$/.exec(base.answer);
    if (m) {
      const extra = numericDistractors(Number(m[1]), `${base.key}:topup`, {
        integer: Number.isInteger(Number(m[1])),
        min: -1e9,
      }).map((v) => `${v}${m[2]}`);
      distractors = [...new Set([...distractors, ...extra])].filter((d) => d !== base.answer);
    }
  }
  distractors = distractors.slice(0, 3);
  if (distractors.length < 3) throw new Error(`Not enough distractors for ${base.key}`);
  const options = shuffle([base.answer, ...distractors], seededRandom(base.key));
  const { answer, distractors: _d, ...rest } = base;
  return { ...rest, options, correct: options.indexOf(answer) };
}

/** Plausible, distinct numeric distractors (typical slips: off by a step, ×/÷ mistakes). */
export function numericDistractors(
  answer: number,
  key: string,
  opts: { integer?: boolean; min?: number } = {},
): string[] {
  const rand = seededRandom(`${key}:d`);
  const step = Math.max(1, Math.round(Math.abs(answer) * 0.1));
  // Realistic slips first (wrong step, doubling/halving, ±10); ±1 only as a last resort.
  const primary = shuffle(
    [
      answer + step,
      answer - step,
      answer + 2 * step,
      answer - 2 * step,
      answer * 2,
      Math.round(answer / 2),
      answer + 10,
      answer - 10,
    ],
    rand,
  );
  const fallback = [answer + 1, answer - 1, answer + 3, answer - 3, answer + 5];
  const min = opts.min ?? (answer > 0 ? 1 : -Infinity);
  const out: string[] = [];
  for (const c of [...primary, ...fallback]) {
    const v = opts.integer === false ? Math.round(c * 100) / 100 : Math.round(c);
    if (v !== answer && v >= min && !out.includes(fmt(v))) out.push(fmt(v));
    if (out.length === 3) break;
  }
  return out;
}

export function fmt(n: number): string {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US').replace(/,/g, '')
    : String(Math.round(n * 100) / 100);
}

/** Picks n items from pool excluding `exclude`, deterministically. */
export function pick<T>(
  pool: readonly T[],
  n: number,
  key: string,
  exclude: (x: T) => boolean = () => false,
): T[] {
  return shuffle(
    pool.filter((x) => !exclude(x)),
    seededRandom(key),
  ).slice(0, n);
}

export function contentHash(key: string): string {
  return createHash('sha256').update(`qm-bank:${key}`).digest('hex');
}

export function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b);
}
export function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}
