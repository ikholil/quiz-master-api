/**
 * Deterministic, explainable adaptive-learning engine. No AI provider is involved: the same inputs always
 * produce the same outputs, and every recommendation carries the factors that produced it.
 */
import { Difficulty } from '@prisma/client';

export const DAY_MS = 86_400_000;
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

// ───────────────────────── Topic mastery ─────────────────────────

export interface MasteryState {
  totalAnswered: number;
  totalCorrect: number;
  recentAccuracy: number;
  avgResponseMs: number | null;
  masteryScore: number;
}

export interface AnswerEvent {
  correct: boolean;
  difficulty: Difficulty;
  responseMs?: number | null;
}

export const EWMA_ALPHA = 0.3;
const DIFFICULTY_WEIGHT: Record<Difficulty, number> = { EASY: 0.8, MEDIUM: 1, HARD: 1.25 };
/** Answers faster than this are "fluent"; slower than SLOW_MS earn no speed credit. */
const FAST_MS = 30_000;
const SLOW_MS = 90_000;
/** Number of answers needed before mastery is fully trusted. */
const CONFIDENCE_N = 10;

export function emptyMastery(): MasteryState {
  return { totalAnswered: 0, totalCorrect: 0, recentAccuracy: 0, avgResponseMs: null, masteryScore: 0 };
}

export function speedFactor(avgMs: number | null): number {
  if (avgMs === null) return 0.5;
  return clamp(1 - (avgMs - FAST_MS) / (SLOW_MS - FAST_MS));
}

export function computeMasteryScore(s: Omit<MasteryState, 'masteryScore'>): number {
  if (!s.totalAnswered) return 0;
  const overall = s.totalCorrect / s.totalAnswered;
  const confidence = Math.min(1, s.totalAnswered / CONFIDENCE_N);
  return round(clamp(confidence * (0.6 * s.recentAccuracy + 0.25 * overall + 0.15 * speedFactor(s.avgResponseMs))));
}

/** Applies a sequence of answers (oldest first) to a topic's mastery state. */
export function applyAnswers(prev: MasteryState, events: AnswerEvent[]): MasteryState {
  let { totalAnswered, totalCorrect, recentAccuracy, avgResponseMs } = prev;
  for (const e of events) {
    // Step size depends on difficulty: a correct HARD answer moves the estimate up more than an EASY one,
    // and a missed EASY question pulls it down more than a missed HARD one.
    const w = DIFFICULTY_WEIGHT[e.difficulty];
    const alpha = totalAnswered === 0 ? 1 : clamp(EWMA_ALPHA * (e.correct ? w : 2 - w), 0.05, 0.6);
    recentAccuracy = clamp((1 - alpha) * recentAccuracy + alpha * (e.correct ? 1 : 0));
    totalAnswered += 1;
    totalCorrect += e.correct ? 1 : 0;
    if (e.responseMs && e.responseMs > 0) {
      const ms = Math.min(e.responseMs, 10 * 60_000);
      avgResponseMs = avgResponseMs === null ? ms : Math.round(avgResponseMs * 0.8 + ms * 0.2);
    }
  }
  const next = { totalAnswered, totalCorrect, recentAccuracy: round(recentAccuracy), avgResponseMs };
  return { ...next, masteryScore: computeMasteryScore(next) };
}

// ───────────────────────── Topic priority ─────────────────────────

export interface TopicPriorityInput {
  topicId: string;
  topicName: string;
  /** Syllabus weight for the target exam (0..1). */
  examWeight: number;
  mastery: MasteryState | null;
  lastPracticedAt: Date | null;
  revisionDue: boolean;
  /** Number of unmet prerequisite topics (mastery < 0.4). */
  weakPrerequisites: number;
}

export interface PriorityFactor {
  key: 'weakness' | 'exam_weight' | 'staleness' | 'not_started' | 'revision_due' | 'declining' | 'prerequisite_gap';
  value: number;
  weight: number;
  contribution: number;
  label: string;
}

export interface TopicPriority {
  topicId: string;
  topicName: string;
  score: number;
  masteryScore: number;
  factors: PriorityFactor[];
  /** Short human-readable explanation built from the strongest factors. */
  reason: string;
}

const PRIORITY_WEIGHTS = { weakness: 0.35, exam_weight: 0.25, staleness: 0.15, not_started: 0.15, revision_due: 0.1, declining: 0.1, prerequisite_gap: -0.15 } as const;

export function topicPriority(input: TopicPriorityInput, now: Date): TopicPriority {
  const m = input.mastery;
  const mastery = m?.masteryScore ?? 0;
  const days = input.lastPracticedAt ? (now.getTime() - input.lastPracticedAt.getTime()) / DAY_MS : null;
  const overall = m && m.totalAnswered ? m.totalCorrect / m.totalAnswered : null;

  const raw: Array<[PriorityFactor['key'], number, string]> = [
    ['weakness', m && m.totalAnswered ? 1 - mastery : 0.5, `mastery ${Math.round(mastery * 100)}%`],
    ['exam_weight', clamp(input.examWeight), `syllabus weight ${Math.round(input.examWeight * 100)}%`],
    ['staleness', days === null ? 0 : clamp(days / 14), days === null ? 'never practised' : `last practised ${Math.floor(days)} day(s) ago`],
    ['not_started', m && m.totalAnswered ? 0 : 1, 'not started yet'],
    ['revision_due', input.revisionDue ? 1 : 0, 'spaced revision is due'],
    ['declining', overall !== null && m!.totalAnswered >= 5 && m!.recentAccuracy + 0.15 < overall ? 1 : 0, 'recent accuracy is dropping'],
    // Topics whose prerequisites are weak are deprioritised: study the foundations first.
    ['prerequisite_gap', clamp(input.weakPrerequisites / 2), `${input.weakPrerequisites} weak prerequisite topic(s)`],
  ];
  const factors = raw.map(([key, value, label]) => {
    const weight = PRIORITY_WEIGHTS[key];
    return { key, value: round(value, 3), weight, contribution: round(value * weight, 4), label };
  });
  const score = round(factors.reduce((s, f) => s + f.contribution, 0));
  const reason = factors
    .filter((f) => f.contribution > 0.02)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)
    .map((f) => f.label)
    .join('; ');
  return { topicId: input.topicId, topicName: input.topicName, score, masteryScore: mastery, factors, reason: reason || 'balanced coverage' };
}

export function rankTopics(inputs: TopicPriorityInput[], now: Date): TopicPriority[] {
  return inputs.map((i) => topicPriority(i, now)).sort((a, b) => b.score - a.score || a.topicId.localeCompare(b.topicId));
}

// ───────────────────────── Spaced repetition (SM-2) ─────────────────────────

export interface Sm2State {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
}

/** quality: 0–5 (0 = blackout, 3 = correct with effort, 5 = perfect). */
export function sm2(state: Sm2State, quality: number, now: Date): Sm2State & { dueAt: Date } {
  const q = Math.round(clamp(quality, 0, 5));
  let { easeFactor, intervalDays, repetitions, lapses } = state;
  if (q < 3) {
    repetitions = 0;
    intervalDays = 1;
    lapses += 1;
  } else {
    repetitions += 1;
    intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 3 : Math.round(intervalDays * easeFactor);
  }
  easeFactor = Math.max(1.3, round(easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), 3));
  intervalDays = Math.min(intervalDays, 365);
  return { easeFactor, intervalDays, repetitions, lapses, dueAt: new Date(now.getTime() + intervalDays * DAY_MS) };
}

// ───────────────────────── Daily plan generation ─────────────────────────

export type PlannedTaskType = 'PRACTICE' | 'REVISION' | 'MOCK_EXAM' | 'READ_MATERIAL' | 'FLASHCARDS';

export interface PlannedTask {
  type: PlannedTaskType;
  title: string;
  topicId?: string;
  mockTemplateId?: string;
  materialId?: string;
  estimatedMinutes: number;
  priorityScore: number;
  reason: { summary: string; factors?: PriorityFactor[]; recovery?: boolean };
}

export interface CarryOverTask {
  id: string;
  type: PlannedTaskType;
  title: string;
  topicId: string | null;
  mockTemplateId: string | null;
  materialId: string | null;
  estimatedMinutes: number;
}

export interface DailyPlanInput {
  availableMinutes: number;
  priorities: TopicPriority[];
  dueRevisionCount: number;
  dueFlashcardCount: number;
  /** Missed tasks from recent days to recover (oldest first). */
  carryOver: CarryOverTask[];
  mockCandidate: { id: string; title: string; durationMinutes: number } | null;
  /** Days since the last mock attempt (null = never). */
  daysSinceLastMock: number | null;
  /** Materials for top weak topics (topicId → material). */
  materials: Map<string, { id: string; title: string; estimatedMinutes: number }>;
}

const PRACTICE_BLOCK_MIN = 20;
const MOCK_INTERVAL_DAYS = 7;

export function generateDailyPlan(input: DailyPlanInput): PlannedTask[] {
  let remaining = Math.max(15, input.availableMinutes);
  const tasks: PlannedTask[] = [];
  const take = (t: PlannedTask) => {
    tasks.push(t);
    remaining -= t.estimatedMinutes;
  };

  // 1. Mock exam: weekly cadence when there is enough time; it replaces most other work that day.
  if (input.mockCandidate && input.mockCandidate.durationMinutes <= remaining && (input.daysSinceLastMock === null || input.daysSinceLastMock >= MOCK_INTERVAL_DAYS)) {
    take({
      type: 'MOCK_EXAM',
      title: input.mockCandidate.title,
      mockTemplateId: input.mockCandidate.id,
      estimatedMinutes: input.mockCandidate.durationMinutes,
      priorityScore: 1,
      reason: { summary: input.daysSinceLastMock === null ? 'Take a first full mock to benchmark your level' : `No mock exam in the last ${input.daysSinceLastMock} days` },
    });
  }

  // 2. Recovery of missed tasks, capped at 40% of today's time so the plan stays achievable.
  let recoveryBudget = Math.floor(input.availableMinutes * 0.4);
  for (const c of input.carryOver) {
    if (c.estimatedMinutes > recoveryBudget || c.estimatedMinutes > remaining) continue;
    recoveryBudget -= c.estimatedMinutes;
    take({
      type: c.type,
      title: c.title,
      topicId: c.topicId ?? undefined,
      mockTemplateId: c.mockTemplateId ?? undefined,
      materialId: c.materialId ?? undefined,
      estimatedMinutes: c.estimatedMinutes,
      priorityScore: 0.9,
      reason: { summary: 'Recovered from a missed day', recovery: true },
    });
  }

  // 3. Spaced revision (≈1.5 min per due item, at most 25% of the day).
  if (input.dueRevisionCount > 0 && remaining >= 5) {
    const minutes = Math.min(Math.ceil(input.dueRevisionCount * 1.5), Math.floor(input.availableMinutes * 0.25), remaining);
    if (minutes >= 5) take({ type: 'REVISION', title: `Revise ${input.dueRevisionCount} due item(s)`, estimatedMinutes: minutes, priorityScore: 0.85, reason: { summary: 'Items are due in your spaced-repetition schedule' } });
  }
  if (input.dueFlashcardCount > 0 && remaining >= 5) {
    const minutes = Math.min(Math.ceil(input.dueFlashcardCount * 0.5), 15, remaining);
    if (minutes >= 5) take({ type: 'FLASHCARDS', title: `Review ${input.dueFlashcardCount} flashcard(s)`, estimatedMinutes: minutes, priorityScore: 0.8, reason: { summary: 'Flashcards are due for review' } });
  }

  // 4. Practice blocks on the highest-priority topics; weakest topics get a reading task first.
  const recoveredTopics = new Set(tasks.map((t) => t.topicId).filter(Boolean));
  for (const p of input.priorities) {
    if (remaining < 10) break;
    if (recoveredTopics.has(p.topicId)) continue;
    const material = input.materials.get(p.topicId);
    if (material && p.masteryScore < 0.4 && material.estimatedMinutes <= remaining - 10) {
      take({ type: 'READ_MATERIAL', title: material.title, topicId: p.topicId, materialId: material.id, estimatedMinutes: material.estimatedMinutes, priorityScore: p.score, reason: { summary: `Review the concept first: ${p.reason}`, factors: p.factors } });
    }
    const minutes = Math.min(PRACTICE_BLOCK_MIN, remaining);
    take({ type: 'PRACTICE', title: `Practise: ${p.topicName}`, topicId: p.topicId, estimatedMinutes: minutes, priorityScore: p.score, reason: { summary: p.reason, factors: p.factors } });
  }
  return tasks;
}
