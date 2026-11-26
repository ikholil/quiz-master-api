import { QuestionType } from '@prisma/client';

export interface OptionInput {
  key: string;
  text: string;
  textBn?: string;
  imageFileId?: string;
  isCorrect: boolean;
}

export interface ContentInput {
  stem: string;
  stemBn?: string;
  imageFileId?: string;
  defaultMarks?: number;
  options?: OptionInput[];
  acceptedAnswers?: string[];
  rubric?: string;
  explanation?: { content: string; contentBn?: string; references?: string[] };
}

export const OBJECTIVE_TYPES: QuestionType[] = [
  QuestionType.SINGLE_CHOICE,
  QuestionType.MULTIPLE_CHOICE,
  QuestionType.TRUE_FALSE,
];
export const AUTO_GRADED_TYPES: QuestionType[] = [...OBJECTIVE_TYPES, QuestionType.SHORT_ANSWER];
export const MANUAL_TYPES: QuestionType[] = [QuestionType.WRITTEN, QuestionType.VIVA];

/**
 * Validates question content against its type. Pure function so it is shared by the API, bulk import
 * and unit tests. Returns a list of human-readable problems (empty = valid).
 */
export function validateQuestionContent(type: QuestionType, c: ContentInput): string[] {
  const errors: string[] = [];
  if (!c.stem || c.stem.trim().length < 2) errors.push('stem is required');
  if (c.defaultMarks !== undefined && (!(c.defaultMarks > 0) || c.defaultMarks > 100))
    errors.push('defaultMarks must be between 0 and 100');
  const options = c.options ?? [];
  const keys = options.map((o) => o.key.trim().toUpperCase());
  if (new Set(keys).size !== keys.length) errors.push('option keys must be unique');
  if (options.some((o) => !o.text?.trim() && !o.imageFileId))
    errors.push('every option needs text or an image');
  const correct = options.filter((o) => o.isCorrect).length;

  switch (type) {
    case QuestionType.SINGLE_CHOICE:
      if (options.length < 2 || options.length > 8) errors.push('single choice questions need 2–8 options');
      if (correct !== 1) errors.push('single choice questions need exactly one correct option');
      break;
    case QuestionType.MULTIPLE_CHOICE:
      if (options.length < 2 || options.length > 8) errors.push('multiple choice questions need 2–8 options');
      if (correct < 1) errors.push('multiple choice questions need at least one correct option');
      break;
    case QuestionType.TRUE_FALSE:
      if (options.length !== 2) errors.push('true/false questions need exactly two options');
      if (correct !== 1) errors.push('true/false questions need exactly one correct option');
      break;
    case QuestionType.SHORT_ANSWER:
      if (options.length) errors.push('short answer questions cannot have options');
      if (!c.acceptedAnswers?.some((a) => a.trim()))
        errors.push('short answer questions need at least one accepted answer');
      break;
    case QuestionType.WRITTEN:
    case QuestionType.VIVA:
      if (options.length) errors.push(`${type.toLowerCase()} questions cannot have options`);
      break;
  }
  if (type !== QuestionType.SHORT_ANSWER && c.acceptedAnswers?.length)
    errors.push('acceptedAnswers only apply to short answer questions');
  return errors;
}
