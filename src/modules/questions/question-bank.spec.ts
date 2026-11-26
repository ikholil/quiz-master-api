import { buildQuestionBank, TAXONOMY } from '../../../prisma/question-bank';

/**
 * Independent re-verification of the generated bank: answers are recomputed from the stem with code that is
 * separate from the generators, so a generator bug cannot silently ship wrong keys.
 */
describe('original question bank', () => {
  const bank = buildQuestionBank();
  const answer = (q: (typeof bank)[number]) => q.options[q.correct];

  it('is large and covers every taxonomy subject', () => {
    expect(bank.length).toBeGreaterThan(2500);
    const subjects = new Set(bank.map((q) => q.subject));
    for (const s of Object.keys(TAXONOMY)) expect(subjects).toContain(s);
  });

  it('has exactly four unique options and one valid key per question', () => {
    for (const q of bank) {
      expect(new Set(q.options).size).toBe(4);
      expect(q.correct).toBeGreaterThanOrEqual(0);
      expect(q.correct).toBeLessThan(4);
      expect(q.explanation.length).toBeGreaterThan(3);
    }
  });

  it('spreads the correct answer evenly across positions', () => {
    const counts = [0, 0, 0, 0];
    bank.forEach((q) => counts[q.correct]++);
    for (const c of counts) expect(c / bank.length).toBeGreaterThan(0.2);
  });

  it('percent-of questions are arithmetically correct', () => {
    const items = bank.filter((q) => q.key.startsWith('math:percentage:of-'));
    expect(items.length).toBeGreaterThan(100);
    for (const q of items) {
      const [, p, n] = /What is ([\d.]+)% of (\d+)\?/.exec(q.stem)!;
      expect(Number(answer(q))).toBeCloseTo((Number(p) * Number(n)) / 100, 6);
    }
  });

  it('simple-interest questions are correct', () => {
    for (const q of bank.filter((x) => x.key.startsWith('math:interest:si-'))) {
      const [, p, r, t] = /on (\d+) taka at (\d+)% per annum for (\d+) years/.exec(q.stem)!;
      expect(answer(q)).toBe(`${(Number(p) * Number(r) * Number(t)) / 100} taka`);
    }
  });

  it('binary/hex conversions are correct', () => {
    for (const q of bank.filter((x) => x.topic === 'number-systems')) {
      let m = /binary representation of decimal (\d+)/.exec(q.stem);
      if (m) expect(answer(q)).toBe(Number(m[1]).toString(2));
      m = /^Binary ([01]+) equals/.exec(q.stem);
      if (m) expect(Number(answer(q))).toBe(parseInt(m[1], 2));
      m = /decimal (\d+) in hexadecimal/.exec(q.stem);
      if (m) expect(answer(q)).toBe(Number(m[1]).toString(16).toUpperCase());
    }
  });

  it('logic-gate outputs are correct', () => {
    const f: Record<string, (a: number, b: number) => number> = {
      AND: (a, b) => a & b,
      OR: (a, b) => a | b,
      NAND: (a, b) => 1 - (a & b),
      NOR: (a, b) => 1 - (a | b),
      XOR: (a, b) => a ^ b,
      XNOR: (a, b) => 1 - (a ^ b),
    };
    for (const q of bank.filter((x) => x.topic === 'logic-gates' && /inputs are/.test(x.stem))) {
      const [, g, a, b] = /2-input (\w+) gate when the inputs are A = (\d) and B = (\d)/.exec(q.stem)!;
      expect(Number(answer(q))).toBe(f[g](Number(a), Number(b)));
    }
  });

  it('squares, roots and LCM/HCF are correct', () => {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    for (const q of bank) {
      let m = /^(\d+)² = \?$/.exec(q.stem);
      if (m) expect(Number(answer(q))).toBe(Number(m[1]) ** 2);
      m = /^√(\d+) = \?$/.exec(q.stem);
      if (m) expect(Number(answer(q)) ** 2).toBe(Number(m[1]));
      m = /HCF \(GCD\) of (\d+) and (\d+)/.exec(q.stem);
      if (m) expect(Number(answer(q))).toBe(gcd(Number(m[1]), Number(m[2])));
      m = /LCM of (\d+) and (\d+)\?/.exec(q.stem);
      if (m) expect(Number(answer(q))).toBe((Number(m[1]) * Number(m[2])) / gcd(Number(m[1]), Number(m[2])));
    }
  });

  it('never claims to be an official past-paper question', () => {
    for (const q of bank) expect(q.stem.toLowerCase()).not.toMatch(/bcs \d{2}|previous year|official paper/);
  });
});
