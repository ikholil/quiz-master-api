import { QuestionType } from '@prisma/client';
import { ScoringItem, ScoringRules, scoreAttempt, scoreItem } from './scoring';

const rules: ScoringRules = { multiSelectPolicy: 'EXACT', allowNegativeTotal: false, passMarksCenti: null };

function mcq(id: string, selected: string[], over: Partial<ScoringItem> = {}): ScoringItem {
  return {
    id,
    sectionId: 's1',
    type: QuestionType.SINGLE_CHOICE,
    optionIds: ['a', 'b', 'c', 'd'],
    correctOptionIds: ['a'],
    acceptedAnswers: [],
    maxMarksCenti: 100,
    negativeCenti: 50,
    selectedOptionIds: selected,
    textAnswer: null,
    manualAwardCenti: null,
    ...over,
  };
}

describe('scoreItem', () => {
  it('awards full marks for a correct single choice', () => {
    expect(scoreItem(mcq('1', ['a']), 'EXACT')).toMatchObject({
      outcome: 'CORRECT',
      awardedCenti: 100,
      isCorrect: true,
    });
  });

  it('applies negative marking for a wrong answer', () => {
    expect(scoreItem(mcq('1', ['b']), 'EXACT')).toMatchObject({
      outcome: 'WRONG',
      awardedCenti: -50,
      isCorrect: false,
    });
  });

  it('gives zero (no penalty) for skipped questions', () => {
    expect(scoreItem(mcq('1', []), 'EXACT')).toMatchObject({
      outcome: 'SKIPPED',
      awardedCenti: 0,
      isCorrect: null,
    });
  });

  it('treats option ids that are not part of the question as wrong', () => {
    expect(scoreItem(mcq('1', ['zzz']), 'EXACT').outcome).toBe('WRONG');
  });

  it('requires an exact set match for multiple choice under EXACT policy', () => {
    const item = mcq('1', ['a', 'b'], { type: QuestionType.MULTIPLE_CHOICE, correctOptionIds: ['a', 'b'] });
    expect(scoreItem(item, 'EXACT').outcome).toBe('CORRECT');
    expect(scoreItem({ ...item, selectedOptionIds: ['a'] }, 'EXACT').outcome).toBe('WRONG');
  });

  it('awards proportional credit under PARTIAL policy only when no wrong option is selected', () => {
    const item = mcq('1', ['a'], { type: QuestionType.MULTIPLE_CHOICE, correctOptionIds: ['a', 'b', 'c'] });
    expect(scoreItem(item, 'PARTIAL')).toMatchObject({ outcome: 'PARTIAL', awardedCenti: 33 });
    expect(scoreItem({ ...item, selectedOptionIds: ['a', 'd'] }, 'PARTIAL')).toMatchObject({
      outcome: 'WRONG',
      awardedCenti: -50,
    });
  });

  it('matches short answers case/punctuation-insensitively and folds Bangla digits', () => {
    const item = mcq('1', [], {
      type: QuestionType.SHORT_ANSWER,
      optionIds: [],
      correctOptionIds: [],
      acceptedAnswers: ['1971'],
      textAnswer: '১৯৭১।',
    });
    expect(scoreItem(item, 'EXACT').outcome).toBe('CORRECT');
    expect(scoreItem({ ...item, textAnswer: '1952' }, 'EXACT').outcome).toBe('WRONG');
  });

  it('leaves written answers pending until evaluated, then clamps to the allowed range', () => {
    const item = mcq('1', [], {
      type: QuestionType.WRITTEN,
      optionIds: [],
      correctOptionIds: [],
      textAnswer: 'essay',
      maxMarksCenti: 1000,
    });
    expect(scoreItem(item, 'EXACT').outcome).toBe('PENDING_MANUAL');
    expect(scoreItem({ ...item, manualAwardCenti: 750 }, 'EXACT')).toMatchObject({
      outcome: 'MANUAL',
      awardedCenti: 750,
    });
    expect(scoreItem({ ...item, manualAwardCenti: 5000 }, 'EXACT').awardedCenti).toBe(1000);
  });
});

describe('scoreAttempt', () => {
  it('computes exact totals with 0.25 negative marking (no floating point drift)', () => {
    // 100 questions × 1 mark, 0.25 negative: 63 correct, 37 wrong → 63 − 9.25 = 53.75
    const items = Array.from({ length: 100 }, (_, i) =>
      mcq(String(i), [i < 63 ? 'a' : 'b'], { negativeCenti: 25 }),
    );
    const s = scoreAttempt(items, rules, ['s1']);
    expect(s.obtainedCenti).toBe(5375);
    expect(s.totalCenti).toBe(10000);
    expect(s.correct).toBe(63);
    expect(s.wrong).toBe(37);
    expect(s.accuracy).toBe(63);
  });

  it('clamps negative totals to zero unless allowed', () => {
    const items = [mcq('1', ['b']), mcq('2', ['c'])];
    expect(scoreAttempt(items, rules, ['s1']).obtainedCenti).toBe(0);
    expect(scoreAttempt(items, { ...rules, allowNegativeTotal: true }, ['s1']).obtainedCenti).toBe(-100);
  });

  it('reports per-section breakdown and pass/fail', () => {
    const items = [mcq('1', ['a']), mcq('2', ['a'], { sectionId: 's2' }), mcq('3', [], { sectionId: 's2' })];
    const s = scoreAttempt(items, { ...rules, passMarksCenti: 150 }, ['s1', 's2']);
    expect(s.sections.map((x) => [x.sectionId, x.obtainedCenti, x.skipped])).toEqual([
      ['s1', 100, 0],
      ['s2', 100, 1],
    ]);
    expect(s.passed).toBe(true);
  });

  it('does not decide pass/fail while manual evaluation is pending', () => {
    const items = [
      mcq('1', ['a']),
      mcq('2', [], { type: QuestionType.WRITTEN, optionIds: [], textAnswer: 'x' }),
    ];
    const s = scoreAttempt(items, { ...rules, passMarksCenti: 50 }, ['s1']);
    expect(s.pending).toBe(1);
    expect(s.passed).toBeNull();
  });

  it('is deterministic for identical input', () => {
    const items = [mcq('1', ['a']), mcq('2', ['b']), mcq('3', [])];
    expect(scoreAttempt(items, rules, ['s1'])).toEqual(scoreAttempt(items, rules, ['s1']));
  });
});
