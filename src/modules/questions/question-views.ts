import { Prisma } from '@prisma/client';

export const VERSION_INCLUDE = {
  options: { orderBy: { sortOrder: 'asc' as const } },
  explanation: true,
  question: { include: { passage: true, source: true } },
} satisfies Prisma.QuestionVersionInclude;

export type VersionWithContent = Prisma.QuestionVersionGetPayload<{ include: typeof VERSION_INCLUDE }>;

function sourceLabel(v: VersionWithContent): string | null {
  const s = v.question.source;
  if (!s) return v.question.isDemo ? 'Demonstration question' : null;
  if (s.type === 'DEMONSTRATION') return 'Demonstration question';
  if (s.type === 'PREVIOUS_YEAR' && s.isOfficial) return s.year ? `${s.title} (${s.year})` : s.title;
  return null;
}

/**
 * Student-safe projection: correctness flags, accepted answers, rubric and explanation are stripped.
 * `optionOrder` (array of option ids) applies the attempt/practice randomisation.
 */
export function toStudentView(v: VersionWithContent, optionOrder?: string[]) {
  const byId = new Map(v.options.map((o) => [o.id, o]));
  const ordered = optionOrder?.length ? optionOrder.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o) : v.options;
  const q = v.question;
  return {
    questionId: q.id,
    versionId: v.id,
    code: q.code,
    type: q.type,
    difficulty: q.difficulty,
    stem: v.stem,
    stemBn: v.stemBn,
    imageFileId: v.imageFileId,
    passage: q.passage ? { id: q.passage.id, title: q.passage.title, content: q.passage.content, imageFileId: q.passage.imageFileId } : null,
    options: ordered.map((o) => ({ id: o.id, text: o.text, textBn: o.textBn, imageFileId: o.imageFileId })),
    subjectId: q.subjectId,
    topicId: q.topicId,
    isDemo: q.isDemo,
    sourceLabel: sourceLabel(v),
  };
}

/** Only returned after an answer is final (practice feedback / submitted attempt review). */
export function toAnswerKey(v: VersionWithContent) {
  return {
    correctOptionIds: v.options.filter((o) => o.isCorrect).map((o) => o.id),
    acceptedAnswers: v.acceptedAnswers,
    explanation: v.explanation?.content ?? null,
    explanationBn: v.explanation?.contentBn ?? null,
    references: v.explanation?.references ?? [],
  };
}

/** Snapshot consumed by the scoring engine. */
export function toScoringQuestion(v: VersionWithContent) {
  return {
    type: v.question.type,
    optionIds: v.options.map((o) => o.id),
    correctOptionIds: v.options.filter((o) => o.isCorrect).map((o) => o.id),
    acceptedAnswers: v.acceptedAnswers,
  };
}
