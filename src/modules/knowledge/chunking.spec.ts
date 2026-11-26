import { chunkText, extractText } from './chunking';
import { allocate, pickWithMix } from '../mock-exams/question-selector';
import { validateMockConfig } from '../mock-exams/mock-exams.service';
import { seededRandom } from '../../common/utils/random.util';

describe('chunking', () => {
  it('splits long text into bounded chunks with headings kept as metadata', () => {
    const para = 'This is a sentence about percentages and averages. '.repeat(40);
    const chunks = chunkText(
      `# Arithmetic\n\n${para}\n\n${para}\n\n# History\n\nShort history note about 1952.`,
      200,
      30,
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.tokenCount <= 260)).toBe(true);
    expect(chunks[0].heading).toBe('Arithmetic');
    expect(chunks.some((c) => c.content.includes('1952'))).toBe(true);
  });

  it('strips HTML and refuses unsupported binary formats', () => {
    const html = extractText('text/html', '<p>Hello <b>world</b></p><script>x()</script>')!;
    expect(html.replace(/\s+/g, ' ')).toContain('Hello world');
    expect(html).not.toContain('x()');
    expect(extractText('application/pdf', '%PDF')).toBeNull();
  });
});

describe('mock exam question selection', () => {
  it('allocates difficulty mix exactly (largest remainder)', () => {
    expect(allocate(10, { EASY: 0.3, MEDIUM: 0.5, HARD: 0.2 })).toEqual({ EASY: 3, MEDIUM: 5, HARD: 2 });
    const a = allocate(7, { EASY: 1, MEDIUM: 1, HARD: 1 });
    expect(a.EASY + a.MEDIUM + a.HARD).toBe(7);
  });

  it('fills shortfalls from other difficulties and never duplicates', () => {
    const pool = [
      ...Array.from({ length: 2 }, (_, i) => ({
        questionId: `h${i}`,
        versionId: `vh${i}`,
        difficulty: 'HARD' as const,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        questionId: `e${i}`,
        versionId: `ve${i}`,
        difficulty: 'EASY' as const,
      })),
    ];
    const picked = pickWithMix(pool, 6, { HARD: 1 }, seededRandom('x'));
    expect(picked).toHaveLength(6);
    expect(new Set(picked.map((p) => p.questionId)).size).toBe(6);
    expect(picked.filter((p) => p.difficulty === 'HARD')).toHaveLength(2);
  });
});

describe('mock config validation', () => {
  const base = {
    durationMinutes: 60,
    sections: [
      {
        title: 'A',
        selectionMode: 'RANDOM' as const,
        questionCount: 10,
        marksPerQuestion: 1,
        negativeMarks: 0.25,
      },
    ],
  };
  it('accepts a sane config', () => expect(validateMockConfig(base as never)).toEqual([]));
  it('rejects impossible marks', () => {
    expect(
      validateMockConfig({ ...base, sections: [{ ...base.sections[0], negativeMarks: 2 }] } as never).join(),
    ).toContain('negative marks');
    expect(validateMockConfig({ ...base, passMarks: 50 } as never).join()).toContain('passMarks');
  });
  it('requires FIXED sections to list exactly questionCount ids', () => {
    expect(
      validateMockConfig({
        ...base,
        sections: [
          {
            ...base.sections[0],
            selectionMode: 'FIXED',
            questionIds: ['00000000-0000-4000-8000-000000000001'],
          },
        ],
      } as never),
    ).not.toEqual([]);
  });
});
