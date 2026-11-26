import { QuestionType } from '@prisma/client';
import { validateQuestionContent } from './question-content';
import { parseImportFile } from './question-import';
import { toStudentView } from './question-views';

const opts = (correct: number[], n = 4) => Array.from({ length: n }, (_, i) => ({ key: 'ABCDEFGH'[i], text: `Option ${i}`, isCorrect: correct.includes(i) }));

describe('validateQuestionContent', () => {
  it('accepts a valid single choice question', () => {
    expect(validateQuestionContent(QuestionType.SINGLE_CHOICE, { stem: 'Q?', options: opts([1]) })).toEqual([]);
  });
  it('rejects single choice with zero or two correct options', () => {
    expect(validateQuestionContent(QuestionType.SINGLE_CHOICE, { stem: 'Q?', options: opts([]) })).not.toEqual([]);
    expect(validateQuestionContent(QuestionType.SINGLE_CHOICE, { stem: 'Q?', options: opts([0, 1]) })).not.toEqual([]);
  });
  it('requires exactly two options for true/false', () => {
    expect(validateQuestionContent(QuestionType.TRUE_FALSE, { stem: 'Q?', options: opts([0], 3) })).not.toEqual([]);
    expect(validateQuestionContent(QuestionType.TRUE_FALSE, { stem: 'Q?', options: opts([0], 2) })).toEqual([]);
  });
  it('requires accepted answers for short answer and forbids options', () => {
    expect(validateQuestionContent(QuestionType.SHORT_ANSWER, { stem: 'Q?' })).not.toEqual([]);
    expect(validateQuestionContent(QuestionType.SHORT_ANSWER, { stem: 'Q?', acceptedAnswers: ['x'] })).toEqual([]);
    expect(validateQuestionContent(QuestionType.SHORT_ANSWER, { stem: 'Q?', acceptedAnswers: ['x'], options: opts([0]) })).not.toEqual([]);
  });
  it('rejects duplicate option keys', () => {
    const o = opts([0]);
    o[1].key = 'A';
    expect(validateQuestionContent(QuestionType.SINGLE_CHOICE, { stem: 'Q?', options: o }).join()).toContain('unique');
  });
});

describe('bulk import parsing', () => {
  it('parses CSV rows and reports invalid ones with line numbers', () => {
    const csv = [
      'type,difficulty,subject,topic,stem,option_a,option_b,option_c,option_d,correct,explanation,tags',
      'single_choice,easy,mathematics,arithmetic/percentage,"What is 10% of 50?",5,10,15,20,A,"50 × 10/100 = 5","pct;easy"',
      'single_choice,easy,mathematics,,Broken,1,2,,,C,,',
    ].join('\n');
    const { rows } = parseImportFile(csv, 'csv');
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].row!.content.options!.find((o) => o.isCorrect)!.text).toBe('5');
    expect(rows[0].row!.tags).toEqual(['pct', 'easy']);
    expect(rows[1].line).toBe(3);
    expect(rows[1].errors.length).toBeGreaterThan(0);
  });

  it('never marks imported sources as official and flags demonstration rows', () => {
    const { rows } = parseImportFile(JSON.stringify([{ type: 'TRUE_FALSE', subject: 'gk', stem: 'Dhaka is the capital', option_a: 'True', option_b: 'False', correct: 'A', source_type: 'DEMONSTRATION' }]), 'json');
    expect(rows[0].row!.isDemo).toBe(true);
  });
});

describe('toStudentView', () => {
  it('never exposes correctness, accepted answers, rubric or explanation', () => {
    const version = {
      id: 'v1',
      stem: 'Q',
      stemBn: null,
      imageFileId: null,
      acceptedAnswers: ['secret'],
      rubric: 'secret rubric',
      options: [
        { id: 'o1', key: 'A', text: 'x', textBn: null, imageFileId: null, isCorrect: true, sortOrder: 0, versionId: 'v1' },
        { id: 'o2', key: 'B', text: 'y', textBn: null, imageFileId: null, isCorrect: false, sortOrder: 1, versionId: 'v1' },
      ],
      explanation: { content: 'secret explanation' },
      question: { id: 'q1', code: 'Q1', type: 'SINGLE_CHOICE', difficulty: 'EASY', subjectId: 's', topicId: null, isDemo: true, passage: null, source: null },
    } as never;
    const view = toStudentView(version, ['o2', 'o1']);
    const json = JSON.stringify(view);
    expect(json).not.toContain('isCorrect');
    expect(json).not.toContain('secret');
    expect(view.options.map((o) => o.id)).toEqual(['o2', 'o1']);
    expect(view.sourceLabel).toBe('Demonstration question');
  });
});
