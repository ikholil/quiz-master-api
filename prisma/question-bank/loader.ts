import {
  ContentStatus,
  Prisma,
  PrismaClient,
  PublishStatus,
  QuestionSourceType,
  SelectionMode,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { buildQuestionBank, TAXONOMY } from './index';
import { BankQuestion, ExamFit, contentHash } from './types';

export interface LoadOptions {
  /** `review` (default) puts every question in the review queue; `published` publishes immediately (dev/staging). */
  status: 'review' | 'published';
  /** Also create exam profiles, syllabus mappings and full-length practice mocks (only when status = published). */
  withMocks?: boolean;
  log?: (msg: string) => void;
}

const SOURCE_TITLE = 'Quiz Master original practice bank';

/** Illustrative exam profiles (clearly labelled demo; verify patterns against official circulars). */
const PROFILES: Array<{
  slug: string;
  category: ExamFit;
  name: string;
  nameBn: string;
  mock?: { title: string; minutes: number; negative: number; sections: Array<[string, number]> };
}> = [
  {
    slug: 'bcs-demo',
    category: 'bcs',
    name: 'BCS Examination (demo profile)',
    nameBn: 'বিসিএস পরীক্ষা (ডেমো)',
    mock: {
      title: 'BCS-style full practice mock (original questions)',
      minutes: 120,
      negative: 0.5,
      sections: [
        ['bangla-language', 10],
        ['bangla-literature', 10],
        ['english', 20],
        ['mathematics', 15],
        ['mental-ability', 10],
        ['bangladesh-affairs', 10],
        ['international-affairs', 10],
        ['general-science', 8],
        ['ict', 7],
      ],
    },
  },
  {
    slug: 'bank-officer-demo',
    category: 'bank',
    name: 'Bank officer recruitment (demo profile)',
    nameBn: 'ব্যাংক অফিসার নিয়োগ (ডেমো)',
    mock: {
      title: 'Bank-style practice mock (original questions)',
      minutes: 60,
      negative: 0.25,
      sections: [
        ['english', 25],
        ['mathematics', 25],
        ['mental-ability', 10],
        ['bangladesh-affairs', 5],
        ['international-affairs', 5],
        ['ict', 10],
      ],
    },
  },
  {
    slug: 'ntrca-demo',
    category: 'ntrca',
    name: 'NTRCA teacher registration (demo profile)',
    nameBn: 'শিক্ষক নিবন্ধন (ডেমো)',
    mock: {
      title: 'NTRCA-style practice mock (original questions)',
      minutes: 60,
      negative: 0.25,
      sections: [
        ['bangla-language', 10],
        ['bangla-literature', 10],
        ['english', 25],
        ['mathematics', 20],
        ['bangladesh-affairs', 15],
        ['international-affairs', 10],
        ['general-science', 10],
      ],
    },
  },
  {
    slug: 'primary-teacher-demo',
    category: 'primary-teacher',
    name: 'Primary assistant teacher recruitment (demo profile)',
    nameBn: 'প্রাথমিক সহকারী শিক্ষক নিয়োগ (ডেমো)',
    mock: {
      title: 'Primary-teacher-style practice mock (original questions)',
      minutes: 60,
      negative: 0,
      sections: [
        ['bangla-language', 10],
        ['bangla-literature', 10],
        ['english', 20],
        ['mathematics', 20],
        ['bangladesh-affairs', 10],
        ['general-science', 10],
      ],
    },
  },
  {
    slug: 'admission-demo',
    category: 'admission',
    name: 'University admission — general knowledge (demo profile)',
    nameBn: 'বিশ্ববিদ্যালয় ভর্তি — সাধারণ জ্ঞান (ডেমো)',
    mock: {
      title: 'Admission-style GK practice mock (original questions)',
      minutes: 45,
      negative: 0.25,
      sections: [
        ['bangladesh-affairs', 15],
        ['international-affairs', 20],
        ['general-science', 15],
        ['ict', 10],
        ['english', 15],
      ],
    },
  },
];

export async function loadQuestionBank(prisma: PrismaClient, opts: LoadOptions) {
  const log = opts.log ?? (() => undefined);
  const bank = buildQuestionBank();
  log(`Built ${bank.length} questions`);

  // 1. Taxonomy
  const topicIds = new Map<string, { id: string; subjectId: string }>();
  const subjectIds = new Map<string, string>();
  for (const [i, [sslug, s]] of Object.entries(TAXONOMY).entries()) {
    const subject = await prisma.subject.upsert({
      where: { slug: sslug },
      update: {},
      create: { slug: sslug, name: s.name, nameBn: s.nameBn, sortOrder: i },
    });
    subjectIds.set(sslug, subject.id);
    for (const [cslug, c] of Object.entries(s.chapters)) {
      const chapter = await prisma.chapter.upsert({
        where: { subjectId_slug: { subjectId: subject.id, slug: cslug } },
        update: {},
        create: { subjectId: subject.id, slug: cslug, name: c.name, nameBn: c.nameBn },
      });
      for (const [j, [tslug, tname]] of Object.entries(c.topics).entries()) {
        const t = await prisma.topic.upsert({
          where: { chapterId_slug: { chapterId: chapter.id, slug: tslug } },
          update: {},
          create: { chapterId: chapter.id, slug: tslug, name: tname, sortOrder: j },
        });
        topicIds.set(`${sslug}/${cslug}/${tslug}`, { id: t.id, subjectId: subject.id });
      }
    }
  }

  // 2. Exam profiles (categories → exams) so questions can be mapped to exams.
  const examsByCategory = new Map<ExamFit, string[]>();
  for (const p of PROFILES) {
    const category = await prisma.examCategory.upsert({
      where: { slug: p.category },
      update: {},
      create: { slug: p.category, name: p.category },
    });
    const exam = await prisma.exam.upsert({
      where: { slug: p.slug },
      update: {},
      create: {
        slug: p.slug,
        name: p.name,
        nameBn: p.nameBn,
        categoryId: category.id,
        description:
          'Demonstration exam profile. Patterns are illustrative — verify every detail against the official circular.',
        eligibility: { note: 'DEMONSTRATION DATA — not an official eligibility rule.' },
        status: PublishStatus.PUBLISHED,
      },
    });
    if (!(await prisma.examStage.count({ where: { examId: exam.id } }))) {
      await prisma.examStage.create({
        data: {
          examId: exam.id,
          name: 'Preliminary / MCQ (demo)',
          sequence: 1,
          negativeMarking: p.mock?.negative ?? 0,
        },
      });
    }
    const all = await prisma.exam.findMany({
      where: { category: { slug: p.category } },
      select: { id: true },
    });
    examsByCategory.set(
      p.category,
      all.map((e) => e.id),
    );
  }
  for (const cat of ['govt-jobs'] as ExamFit[]) {
    examsByCategory.set(
      cat,
      (await prisma.exam.findMany({ where: { category: { slug: cat } }, select: { id: true } })).map(
        (e) => e.id,
      ),
    );
  }

  // 3. Source
  const source =
    (await prisma.questionSource.findFirst({
      where: { type: QuestionSourceType.ORIGINAL, title: SOURCE_TITLE },
    })) ??
    (await prisma.questionSource.create({
      data: {
        type: QuestionSourceType.ORIGINAL,
        title: SOURCE_TITLE,
        reference: 'Original practice content written for this platform. Not taken from any official paper.',
        isOfficial: false,
      },
    }));

  // 4. Questions (idempotent by content hash), inserted in batches.
  const existing = new Set(
    (
      await prisma.question.findMany({ where: { contentHash: { not: null } }, select: { contentHash: true } })
    ).map((r) => r.contentHash!),
  );
  const pending = bank.filter((b) => !existing.has(contentHash(b.key)));
  const published = opts.status === 'published';
  const qStatus = published ? ContentStatus.PUBLISHED : ContentStatus.IN_REVIEW;
  const tagIds = new Map<string, string>();
  for (const name of ['qm-original', ...new Set(bank.map((b) => b.topic))]) {
    tagIds.set(name, (await prisma.questionTag.upsert({ where: { name }, update: {}, create: { name } })).id);
  }

  const BATCH = 250;
  let inserted = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    const rows = chunk.map((b) => ({
      b,
      qid: randomUUID(),
      vid: randomUUID(),
      topic: topicIds.get(`${b.subject}/${b.chapter}/${b.topic}`)!,
    }));
    await prisma.$transaction(
      async (tx) => {
        await tx.question.createMany({
          data: rows.map(({ b, qid, topic }, n) => ({
            id: qid,
            code: `QM-${b.subject.slice(0, 3).toUpperCase()}-${contentHash(b.key).slice(0, 10).toUpperCase()}`,
            type: 'SINGLE_CHOICE',
            difficulty: b.difficulty,
            status: qStatus,
            subjectId: topic.subjectId,
            topicId: topic.id,
            sourceId: source.id,
            contentHash: contentHash(b.key),
            publishedAt: published ? new Date(Date.now() - (pending.length - i - n) * 1000) : null,
          })),
        });
        await tx.questionVersion.createMany({
          data: rows.map(({ b, qid, vid }) => ({
            id: vid,
            questionId: qid,
            versionNumber: 1,
            stem: b.stem,
            status: qStatus,
            changeNote: 'Imported from the original practice bank',
          })),
        });
        await tx.questionOption.createMany({
          data: rows.flatMap(({ b, vid }) =>
            b.options.map((text, k) => ({
              versionId: vid,
              key: 'ABCD'[k],
              text,
              isCorrect: k === b.correct,
              sortOrder: k,
            })),
          ),
        });
        await tx.questionExplanation.createMany({
          data: rows.map(({ b, vid }) => ({ versionId: vid, content: b.explanation })),
        });
        await tx.questionTagLink.createMany({
          data: rows.flatMap(({ b, qid }) => [
            { questionId: qid, tagId: tagIds.get('qm-original')! },
            { questionId: qid, tagId: tagIds.get(b.topic)! },
          ]),
          skipDuplicates: true,
        });
        await tx.examQuestionMapping.createMany({
          data: rows.flatMap(({ b, qid }) =>
            [...new Set(b.exams.flatMap((e) => examsByCategory.get(e) ?? []))].map((examId) => ({
              examId,
              questionId: qid,
            })),
          ),
          skipDuplicates: true,
        });
        const ids = rows.map((r) => r.qid);
        const vids = rows.map((r) => r.vid);
        await tx.$executeRaw`
        UPDATE questions q SET "latestVersionId" = v.vid, "publishedVersionId" = CASE WHEN ${published} THEN v.vid ELSE NULL END
          FROM (SELECT unnest(${ids}::uuid[]) AS qid, unnest(${vids}::uuid[]) AS vid) v
         WHERE q.id = v.qid`;
      },
      { timeout: 60000 },
    );
    inserted += chunk.length;
    log(`Inserted ${inserted}/${pending.length}`);
  }

  // 5. Syllabus mappings + practice mocks for each exam profile.
  let mocks = 0;
  if (published && opts.withMocks !== false) {
    for (const p of PROFILES) {
      const exam = await prisma.exam.findUniqueOrThrow({ where: { slug: p.slug } });
      let syllabus = await prisma.syllabusVersion.findFirst({ where: { examId: exam.id, isCurrent: true } });
      if (!syllabus) {
        syllabus = await prisma.syllabusVersion.create({
          data: {
            examId: exam.id,
            label: 'Practice bank syllabus (demo)',
            status: PublishStatus.PUBLISHED,
            isCurrent: true,
            notes:
              'Auto-created by the bank loader; weights are illustrative until past-paper frequencies are available.',
          },
        });
      }
      const subjects = new Set(p.mock?.sections.map((s) => s[0]) ?? []);
      const mappings = [...topicIds.entries()].filter(([path]) => subjects.has(path.split('/')[0]));
      await prisma.examTopicMapping.createMany({
        data: mappings.map(([, t]) => ({
          examId: exam.id,
          syllabusVersionId: syllabus!.id,
          topicId: t.id,
          weight: new Prisma.Decimal(0.5),
        })),
        skipDuplicates: true,
      });
      if (
        p.mock &&
        !(await prisma.mockExamTemplate.findUnique({ where: { slug: `${p.slug}-full-practice` } }))
      ) {
        await createMock(prisma, exam.id, `${p.slug}-full-practice`, p.mock, subjectIds);
        mocks++;
      }
    }
  }
  log(
    `Done: ${inserted} new questions (${bank.length - pending.length} already present), ${mocks} mocks created`,
  );
  return { built: bank.length, inserted, skipped: bank.length - pending.length, mocks };
}

async function createMock(
  prisma: PrismaClient,
  examId: string,
  slug: string,
  m: { title: string; minutes: number; negative: number; sections: Array<[string, number]> },
  subjectIds: Map<string, string>,
) {
  const sections = m.sections.map(([subject, count]) => ({
    title: TAXONOMY[subject].name,
    subjectId: subjectIds.get(subject)!,
    selectionMode: SelectionMode.RANDOM,
    questionCount: count,
    marksPerQuestion: 1,
    negativeMarks: m.negative,
    difficultyMix: { EASY: 0.3, MEDIUM: 0.5, HARD: 0.2 },
  }));
  const total = sections.reduce((n, s) => n + s.questionCount, 0);
  const config = {
    durationMinutes: m.minutes,
    shuffleQuestions: false,
    shuffleOptions: true,
    multiSelectPolicy: 'EXACT',
    allowNegativeTotal: false,
    resultVisibility: 'IMMEDIATE',
    sections,
  };
  const t = await prisma.mockExamTemplate.create({
    data: {
      slug,
      title: m.title,
      description: 'Full-length practice mock assembled from original questions. Not an official paper.',
      examId,
      draftConfig: config as Prisma.InputJsonValue,
    },
  });
  const v = await prisma.mockExamTemplateVersion.create({
    data: {
      templateId: t.id,
      versionNumber: 1,
      durationMinutes: m.minutes,
      totalMarks: total,
      configSnapshot: config as Prisma.InputJsonValue,
      shuffleQuestions: false,
      sections: {
        create: sections.map((s, i) => ({
          ...s,
          sequence: i + 1,
          difficultyMix: s.difficultyMix as Prisma.InputJsonValue,
        })),
      },
    },
  });
  await prisma.mockExamTemplate.update({
    where: { id: t.id },
    data: { currentVersionId: v.id, status: PublishStatus.PUBLISHED },
  });
}

export type { BankQuestion };
