import { Difficulty } from '@prisma/client';

/**
 * Classical test theory item statistics (pure functions, unit-tested).
 *  - p-value: proportion of examinees answering correctly (skips count as incorrect).
 *  - discrimination (D): p(upper 27%) − p(lower 27%) by total attempt score.
 */
export const MIN_SAMPLE = 30;

export interface ItemResponse {
  correct: boolean;
  /** Attempt score fraction (0–1) used to split upper/lower groups. */
  attemptScore: number;
}

export interface ItemStats {
  sampleSize: number;
  pValue: number;
  discrimination: number | null;
  calibratedDifficulty: Difficulty;
  flags: QualityFlag[];
}

export type QualityFlag =
  'POSSIBLE_KEY_ERROR' | 'NEGATIVE_DISCRIMINATION' | 'LOW_DISCRIMINATION' | 'TOO_EASY' | 'TOO_HARD';

export function calibrate(p: number): Difficulty {
  if (p >= 0.7) return Difficulty.EASY;
  if (p >= 0.3) return Difficulty.MEDIUM;
  return Difficulty.HARD;
}

export function analyseItem(responses: ItemResponse[]): ItemStats | null {
  const n = responses.length;
  if (n < MIN_SAMPLE) return null;
  const p = responses.filter((r) => r.correct).length / n;
  const sorted = [...responses].sort((a, b) => b.attemptScore - a.attemptScore);
  const k = Math.max(1, Math.round(n * 0.27));
  const pu = sorted.slice(0, k).filter((r) => r.correct).length / k;
  const pl = sorted.slice(n - k).filter((r) => r.correct).length / k;
  const d = Math.round((pu - pl) * 1000) / 1000;
  const flags: QualityFlag[] = [];
  if (d < 0) flags.push('NEGATIVE_DISCRIMINATION');
  else if (d < 0.1) flags.push('LOW_DISCRIMINATION');
  // Strong students failing more than weak ones on a "hard" item is the classic signature of a wrong key.
  if (p < 0.25 && d < 0) flags.push('POSSIBLE_KEY_ERROR');
  if (p > 0.95) flags.push('TOO_EASY');
  if (p < 0.1) flags.push('TOO_HARD');
  return {
    sampleSize: n,
    pValue: Math.round(p * 1000) / 1000,
    discrimination: d,
    calibratedDifficulty: calibrate(p),
    flags,
  };
}
