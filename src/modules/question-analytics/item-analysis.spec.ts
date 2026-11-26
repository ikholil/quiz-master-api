import { analyseItem, calibrate, MIN_SAMPLE } from './item-analysis';
import { levelForXp, xpForLevel } from '../gamification/rules';

const resp = (n: number, f: (i: number) => { correct: boolean; attemptScore: number }) =>
  Array.from({ length: n }, (_, i) => f(i));

describe('item analysis', () => {
  it('needs a minimum sample', () => {
    expect(analyseItem(resp(MIN_SAMPLE - 1, () => ({ correct: true, attemptScore: 1 })))).toBeNull();
  });

  it('computes p-value and positive discrimination for a good item', () => {
    // Strong students (high score) answer correctly, weak ones do not.
    const s = analyseItem(resp(100, (i) => ({ correct: i >= 40, attemptScore: i / 100 })))!;
    expect(s.pValue).toBe(0.6);
    expect(s.discrimination).toBe(1);
    expect(s.calibratedDifficulty).toBe('MEDIUM');
    expect(s.flags).toEqual([]);
  });

  it('flags a probable wrong answer key (hard item answered correctly mostly by weak students)', () => {
    const s = analyseItem(resp(100, (i) => ({ correct: i < 20, attemptScore: i / 100 })))!;
    expect(s.discrimination).toBeLessThan(0);
    expect(s.flags).toEqual(expect.arrayContaining(['NEGATIVE_DISCRIMINATION', 'POSSIBLE_KEY_ERROR']));
    expect(s.calibratedDifficulty).toBe('HARD');
  });

  it('flags trivially easy items', () => {
    expect(analyseItem(resp(50, (i) => ({ correct: true, attemptScore: i / 50 })))!.flags).toContain(
      'TOO_EASY',
    );
    expect(calibrate(0.8)).toBe('EASY');
  });
});

describe('levels', () => {
  it('is monotonic and consistent', () => {
    for (let l = 1; l < 30; l++) {
      expect(levelForXp(xpForLevel(l))).toBe(l);
      expect(levelForXp(xpForLevel(l + 1) - 1)).toBe(l);
    }
  });
});
