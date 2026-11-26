import { Difficulty, QuestionSourceType, QuestionType } from '@prisma/client';
import { csvToObjects } from '../../common/utils/csv.util';
import { ContentInput, validateQuestionContent } from './question-content';

/**
 * Bulk import row format (CSV headers / JSON keys):
 *   type, difficulty, subject (slug), topic ("chapter-slug/topic-slug"), stem, stem_bn,
 *   option_a … option_h, correct ("A" or "A|C"), accepted_answers ("x|y"), explanation, marks,
 *   tags ("a;b"), exams ("bcs-46;bank-so"), source_type, source_title, source_year, is_demo
 */
export interface ImportRow {
  type: QuestionType;
  difficulty: Difficulty;
  subjectSlug: string;
  topicPath?: string;
  examSlugs: string[];
  tags: string[];
  isDemo: boolean;
  source?: { type: QuestionSourceType; title: string; year?: number };
  content: ContentInput;
}

export interface ParsedImport {
  rows: Array<{ line: number; row?: ImportRow; errors: string[] }>;
}

const OPTION_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function enumValue<T extends string>(
  values: readonly T[],
  raw: string | undefined,
  fallback?: T,
): T | undefined {
  if (!raw) return fallback;
  const up = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_') as T;
  return values.includes(up) ? up : undefined;
}

export function parseImportRecord(
  rec: Record<string, unknown>,
  line: number,
): { line: number; row?: ImportRow; errors: string[] } {
  const get = (k: string) => {
    const v = rec[k];
    return v === undefined || v === null ? undefined : String(v).trim() || undefined;
  };
  const errors: string[] = [];
  const type = enumValue(Object.values(QuestionType), get('type'));
  if (!type) errors.push(`invalid type "${get('type') ?? ''}"`);
  const difficulty = enumValue(Object.values(Difficulty), get('difficulty'), Difficulty.MEDIUM);
  if (!difficulty) errors.push(`invalid difficulty "${get('difficulty')}"`);
  const subjectSlug = get('subject');
  if (!subjectSlug) errors.push('subject is required');

  const correct = new Set(
    (get('correct') ?? '')
      .split(/[|,;\s]+/)
      .filter(Boolean)
      .map((c) => c.toUpperCase()),
  );
  const options = OPTION_KEYS.filter((k) => get(`option_${k}`)).map((k) => ({
    key: k.toUpperCase(),
    text: get(`option_${k}`)!,
    isCorrect: correct.has(k.toUpperCase()),
  }));
  const marksRaw = get('marks');
  const marks = marksRaw ? Number(marksRaw) : undefined;
  if (marksRaw && !Number.isFinite(marks)) errors.push('marks must be a number');

  const content: ContentInput = {
    stem: get('stem') ?? '',
    stemBn: get('stem_bn'),
    defaultMarks: marks,
    options,
    acceptedAnswers: get('accepted_answers')
      ?.split('|')
      .map((s) => s.trim())
      .filter(Boolean),
    rubric: get('rubric'),
    explanation: get('explanation') ? { content: get('explanation')! } : undefined,
  };
  if (type) errors.push(...validateQuestionContent(type, content));

  let source: ImportRow['source'];
  const sourceType = enumValue(Object.values(QuestionSourceType), get('source_type'));
  if (get('source_type') && !sourceType) errors.push(`invalid source_type "${get('source_type')}"`);
  if (sourceType) {
    const year = get('source_year') ? Number(get('source_year')) : undefined;
    source = {
      type: sourceType,
      title: get('source_title') ?? sourceType,
      year: Number.isInteger(year) ? year : undefined,
    };
  }
  const isDemo =
    ['1', 'true', 'yes'].includes((get('is_demo') ?? '').toLowerCase()) ||
    sourceType === QuestionSourceType.DEMONSTRATION;

  if (errors.length || !type || !difficulty || !subjectSlug) return { line, errors };
  return {
    line,
    errors: [],
    row: {
      type,
      difficulty,
      subjectSlug,
      topicPath: get('topic'),
      examSlugs: (get('exams') ?? '')
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      tags: (get('tags') ?? '')
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      isDemo,
      source,
      content,
    },
  };
}

export function parseImportFile(body: string, format: 'csv' | 'json'): ParsedImport {
  let records: Record<string, unknown>[];
  if (format === 'json') {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) throw new Error('JSON import must be an array of question objects');
    records = parsed as Record<string, unknown>[];
  } else {
    records = csvToObjects(body).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])),
    );
  }
  // Line numbers are 1-based data rows (+1 for CSV header).
  return { rows: records.map((r, i) => parseImportRecord(r, format === 'csv' ? i + 2 : i + 1)) };
}
