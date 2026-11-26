import { Difficulty } from '@prisma/client';
import { DAY_MS, applyAnswers, emptyMastery, generateDailyPlan, rankTopics, sm2, speedFactor, topicPriority, TopicPriorityInput } from './engine';

const now = new Date('2026-06-01T06:00:00Z');

function input(over: Partial<TopicPriorityInput> = {}): TopicPriorityInput {
  return { topicId: 't1', topicName: 'Topic', examWeight: 0.5, mastery: null, lastPracticedAt: null, revisionDue: false, weakPrerequisites: 0, ...over };
}

describe('mastery', () => {
  it('increases with correct answers and decreases with wrong ones', () => {
    const up = applyAnswers(emptyMastery(), Array.from({ length: 10 }, () => ({ correct: true, difficulty: Difficulty.MEDIUM, responseMs: 20_000 })));
    const down = applyAnswers(up, Array.from({ length: 5 }, () => ({ correct: false, difficulty: Difficulty.MEDIUM, responseMs: 20_000 })));
    expect(up.masteryScore).toBeGreaterThan(0.8);
    expect(down.masteryScore).toBeLessThan(up.masteryScore);
    expect(down.totalAnswered).toBe(15);
    expect(down.totalCorrect).toBe(10);
  });

  it('discounts mastery when there is little evidence', () => {
    const one = applyAnswers(emptyMastery(), [{ correct: true, difficulty: Difficulty.MEDIUM }]);
    expect(one.masteryScore).toBeLessThan(0.2);
  });

  it('weights a correct HARD answer more than a correct EASY answer', () => {
    const base = applyAnswers(emptyMastery(), [{ correct: false, difficulty: Difficulty.MEDIUM }]);
    const hard = applyAnswers(base, [{ correct: true, difficulty: Difficulty.HARD }]);
    const easy = applyAnswers(base, [{ correct: true, difficulty: Difficulty.EASY }]);
    expect(hard.recentAccuracy).toBeGreaterThan(easy.recentAccuracy);
  });

  it('scores fast answers higher on speed', () => {
    expect(speedFactor(20_000)).toBe(1);
    expect(speedFactor(120_000)).toBe(0);
  });
});

describe('topic priority', () => {
  it('ranks weak, heavily weighted topics first and explains why', () => {
    const weak = applyAnswers(emptyMastery(), Array.from({ length: 10 }, (_, i) => ({ correct: i < 3, difficulty: Difficulty.MEDIUM })));
    const strong = applyAnswers(emptyMastery(), Array.from({ length: 10 }, () => ({ correct: true, difficulty: Difficulty.MEDIUM })));
    const ranked = rankTopics(
      [
        input({ topicId: 'strong', mastery: strong, examWeight: 0.5, lastPracticedAt: now }),
        input({ topicId: 'weak', mastery: weak, examWeight: 0.9, lastPracticedAt: now }),
      ],
      now,
    );
    expect(ranked[0].topicId).toBe('weak');
    expect(ranked[0].factors.find((f) => f.key === 'weakness')!.value).toBeGreaterThan(0.5);
    expect(ranked[0].reason).toContain('mastery');
    // Score equals the sum of factor contributions (fully explainable).
    const sum = ranked[0].factors.reduce((s, f) => s + f.contribution, 0);
    expect(Math.abs(sum - ranked[0].score)).toBeLessThan(1e-3);
  });

  it('boosts stale topics and topics due for revision', () => {
    const m = applyAnswers(emptyMastery(), Array.from({ length: 10 }, () => ({ correct: true, difficulty: Difficulty.MEDIUM })));
    const fresh = topicPriority(input({ mastery: m, lastPracticedAt: now }), now);
    const stale = topicPriority(input({ mastery: m, lastPracticedAt: new Date(now.getTime() - 20 * DAY_MS), revisionDue: true }), now);
    expect(stale.score).toBeGreaterThan(fresh.score);
  });

  it('deprioritises topics with weak prerequisites', () => {
    expect(topicPriority(input({ weakPrerequisites: 2 }), now).score).toBeLessThan(topicPriority(input(), now).score);
  });

  it('is deterministic', () => {
    const list = [input({ topicId: 'a' }), input({ topicId: 'b' })];
    expect(rankTopics(list, now)).toEqual(rankTopics(list, now));
  });
});

describe('sm2', () => {
  it('grows intervals on successful recall and resets on lapse', () => {
    let s = { easeFactor: 2.5, intervalDays: 0, repetitions: 0, lapses: 0 };
    const r1 = sm2(s, 5, now);
    const r2 = sm2(r1, 5, now);
    const r3 = sm2(r2, 4, now);
    expect([r1.intervalDays, r2.intervalDays]).toEqual([1, 3]);
    expect(r3.intervalDays).toBeGreaterThan(3);
    s = sm2(r3, 1, now);
    expect(s.intervalDays).toBe(1);
    expect(s.lapses).toBe(1);
    expect(s.easeFactor).toBeGreaterThanOrEqual(1.3);
  });
});

describe('daily plan', () => {
  const priorities = rankTopics([input({ topicId: 't1', topicName: 'A' }), input({ topicId: 't2', topicName: 'B' }), input({ topicId: 't3', topicName: 'C' })], now);

  it('fills the time budget without exceeding it', () => {
    const tasks = generateDailyPlan({ availableMinutes: 60, priorities, dueRevisionCount: 4, dueFlashcardCount: 0, carryOver: [], mockCandidate: null, daysSinceLastMock: 1, materials: new Map() });
    const total = tasks.reduce((n, t) => n + t.estimatedMinutes, 0);
    expect(total).toBeLessThanOrEqual(60);
    expect(tasks[0].type).toBe('REVISION');
    expect(tasks.filter((t) => t.type === 'PRACTICE').length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.reason.summary.length > 0)).toBe(true);
  });

  it('schedules a mock exam weekly when time allows', () => {
    const tasks = generateDailyPlan({ availableMinutes: 120, priorities, dueRevisionCount: 0, dueFlashcardCount: 0, carryOver: [], mockCandidate: { id: 'm', title: 'Mock', durationMinutes: 60 }, daysSinceLastMock: 8, materials: new Map() });
    expect(tasks[0].type).toBe('MOCK_EXAM');
  });

  it('recovers missed tasks within 40% of the day', () => {
    const carryOver = [1, 2, 3].map((i) => ({ id: `x${i}`, type: 'PRACTICE' as const, title: `Missed ${i}`, topicId: `m${i}`, mockTemplateId: null, materialId: null, estimatedMinutes: 20 }));
    const tasks = generateDailyPlan({ availableMinutes: 60, priorities, dueRevisionCount: 0, dueFlashcardCount: 0, carryOver, mockCandidate: null, daysSinceLastMock: 1, materials: new Map() });
    const recovered = tasks.filter((t) => t.reason.recovery);
    expect(recovered.length).toBe(1);
  });
});
