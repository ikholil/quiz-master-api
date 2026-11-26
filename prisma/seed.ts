/**
 * Development seed data.
 *
 * IMPORTANT: every question, mock exam and notice created here is DEMONSTRATION CONTENT
 * (isDemo = true, source type DEMONSTRATION). None of it is, or may be presented as, an official
 * examination paper, answer key, circular or eligibility rule. Exam patterns are illustrative and must
 * be verified against the recruiting authority's official circular before real use.
 *
 * Idempotent: safe to run repeatedly (upserts by natural keys).
 */
import {
  ContentStatus,
  Difficulty,
  Prisma,
  PrismaClient,
  PublishStatus,
  QuestionSourceType,
  QuestionType,
  SelectionMode,
  UserStatus,
} from '@prisma/client';
import { randomBytes, scrypt } from 'node:crypto';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/modules/rbac/permissions';

const prisma = new PrismaClient();

function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const params = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, 64, params, (err, key) =>
      err
        ? reject(err)
        : resolve(
            `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`,
          ),
    ),
  );
}

async function syncRbac() {
  for (const key of ALL_PERMISSIONS)
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      update: { name: def.name, isSystem: true },
      create: { key, name: def.name, description: def.description, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((p) => ({ roleId: role.id, permissionId: perms.get(p)! })),
    });
  }
}

async function user(email: string, name: string, roles: string[], password: string, phone?: string) {
  const u = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      phone,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: phone ? new Date() : null,
      passwordHash: await hashPassword(password),
      status: UserStatus.ACTIVE,
      profile: { create: { fullName: name, displayName: name.split(' ')[0] } },
    },
  });
  for (const key of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: u.id, roleId: role.id } },
      update: {},
      create: { userId: u.id, roleId: role.id },
    });
  }
  return u;
}

type DemoQ = {
  stem: string;
  options: string[];
  correct: number;
  explanation: string;
  difficulty?: Difficulty;
  topic: string;
};

/** Arithmetic items are generated so their answers are verifiably correct. */
function arithmeticQuestions(): DemoQ[] {
  const out: DemoQ[] = [];
  const pct = [
    [15, 240],
    [12, 350],
    [25, 480],
    [8, 750],
    [40, 135],
    [35, 260],
  ];
  for (const [p, n] of pct) {
    const ans = (p * n) / 100;
    out.push({
      stem: `${n} এর ${p}% কত? (What is ${p}% of ${n}?)`,
      options: [ans, ans + 6, ans - 4, ans * 2].map(String),
      correct: 0,
      explanation: `${p}% of ${n} = ${n} × ${p}/100 = ${ans}.`,
      topic: 'percentage',
      difficulty: Difficulty.EASY,
    });
  }
  const sp = [
    [60, 2.5],
    [45, 4],
    [72, 1.5],
    [50, 3.2],
  ];
  for (const [speed, hours] of sp) {
    const d = speed * hours;
    out.push({
      stem: `A train runs at ${speed} km/h for ${hours} hours. How far does it travel?`,
      options: [`${d} km`, `${d + 15} km`, `${d - 10} km`, `${speed + hours} km`],
      correct: 0,
      explanation: `Distance = speed × time = ${speed} × ${hours} = ${d} km.`,
      topic: 'time-speed-distance',
      difficulty: Difficulty.MEDIUM,
    });
  }
  const avg = [
    [12, 18, 24, 30],
    [45, 55, 65],
    [7, 14, 21, 28, 35],
  ];
  for (const nums of avg) {
    const a = nums.reduce((s, x) => s + x, 0) / nums.length;
    out.push({
      stem: `${nums.join(', ')} — সংখ্যাগুলোর গড় কত? (Find the average.)`,
      options: [a, a + 2, a - 3, a + 5].map(String),
      correct: 0,
      explanation: `Sum = ${nums.reduce((s, x) => s + x, 0)}, count = ${nums.length}, average = ${a}.`,
      topic: 'average',
      difficulty: Difficulty.EASY,
    });
  }
  return out;
}

const GK: DemoQ[] = [
  {
    stem: 'বাংলাদেশের রাজধানী কোনটি? (What is the capital of Bangladesh?)',
    options: ['ঢাকা (Dhaka)', 'চট্টগ্রাম (Chattogram)', 'খুলনা (Khulna)', 'রাজশাহী (Rajshahi)'],
    correct: 0,
    explanation: 'Dhaka is the capital of Bangladesh.',
    topic: 'bangladesh-basics',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'ভাষা আন্দোলন কোন সালে সংঘটিত হয়? (In which year did the Language Movement culminate on 21 February?)',
    options: ['1952', '1948', '1966', '1971'],
    correct: 0,
    explanation: 'The Language Movement culminated on 21 February 1952.',
    topic: 'history',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'বাংলাদেশ কত সালে স্বাধীনতা লাভ করে? (In which year did Bangladesh achieve independence?)',
    options: ['1971', '1947', '1952', '1975'],
    correct: 0,
    explanation: 'Bangladesh achieved independence in 1971.',
    topic: 'history',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'বাংলাদেশের জাতীয় ফুল কোনটি? (What is the national flower of Bangladesh?)',
    options: ['শাপলা (Water lily)', 'গোলাপ (Rose)', 'শিউলি (Night jasmine)', 'জবা (Hibiscus)'],
    correct: 0,
    explanation: 'The water lily (Shapla) is the national flower.',
    topic: 'bangladesh-basics',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'আন্তর্জাতিক মাতৃভাষা দিবস কোন তারিখে পালিত হয়? (International Mother Language Day is observed on…)',
    options: ['21 February', '26 March', '16 December', '1 May'],
    correct: 0,
    explanation: 'UNESCO observes International Mother Language Day on 21 February.',
    topic: 'history',
    difficulty: Difficulty.MEDIUM,
  },
  {
    stem: 'বাংলাদেশের মুদ্রার নাম কী? (What is the currency of Bangladesh?)',
    options: ['টাকা (Taka)', 'রুপি (Rupee)', 'ডলার (Dollar)', 'রিয়াল (Riyal)'],
    correct: 0,
    explanation: 'The Bangladeshi Taka (BDT).',
    topic: 'bangladesh-basics',
    difficulty: Difficulty.EASY,
  },
];

const ENGLISH: DemoQ[] = [
  {
    stem: 'Choose the synonym of "abundant".',
    options: ['Plentiful', 'Scarce', 'Narrow', 'Silent'],
    correct: 0,
    explanation: '"Abundant" means existing in large quantities — plentiful.',
    topic: 'vocabulary',
  },
  {
    stem: 'Choose the antonym of "ancient".',
    options: ['Modern', 'Old', 'Historic', 'Aged'],
    correct: 0,
    explanation: 'The opposite of ancient is modern.',
    topic: 'vocabulary',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'She ___ to school every day.',
    options: ['goes', 'go', 'going', 'gone'],
    correct: 0,
    explanation: 'Third-person singular present simple takes "goes".',
    topic: 'grammar',
    difficulty: Difficulty.EASY,
  },
  {
    stem: 'If I ___ you, I would accept the offer.',
    options: ['were', 'am', 'was being', 'be'],
    correct: 0,
    explanation: 'Second conditional uses the subjunctive "were".',
    topic: 'grammar',
  },
  {
    stem: 'Choose the correctly spelt word.',
    options: ['Accommodation', 'Acommodation', 'Accomodation', 'Acomodation'],
    correct: 0,
    explanation: '"Accommodation" has double c and double m.',
    topic: 'vocabulary',
    difficulty: Difficulty.HARD,
  },
];

async function main() {
  console.log('Seeding demonstration data…');
  await syncRbac();

  const devPassword = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
  if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD)
    throw new Error('Set SEED_PASSWORD to seed in production');
  const admin = await user(
    process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com',
    'Demo Super Admin',
    ['SUPER_ADMIN'],
    devPassword,
  );
  const editor = await user('editor@example.com', 'Demo Content Editor', ['CONTENT_EDITOR'], devPassword);
  const reviewer = await user(
    'reviewer@example.com',
    'Demo Content Reviewer',
    ['CONTENT_REVIEWER'],
    devPassword,
  );
  await user('student@example.com', 'Demo Student', ['STUDENT'], devPassword, '+8801700000001');

  // Catalogue
  const cats = [
    ['bcs', 'BCS', 'বিসিএস'],
    ['bank', 'Bank recruitment', 'ব্যাংক নিয়োগ'],
    ['ntrca', 'NTRCA teacher registration', 'শিক্ষক নিবন্ধন'],
    ['primary-teacher', 'Primary teacher recruitment', 'প্রাথমিক শিক্ষক নিয়োগ'],
    ['admission', 'University admission', 'বিশ্ববিদ্যালয় ভর্তি'],
    ['govt-jobs', 'Government jobs', 'সরকারি চাকরি'],
  ];
  const catIds: Record<string, string> = {};
  for (const [i, [slug, name, nameBn]] of cats.entries()) {
    catIds[slug] = (
      await prisma.examCategory.upsert({
        where: { slug },
        update: {},
        create: { slug, name, nameBn, sortOrder: i },
      })
    ).id;
  }
  const auths = [
    [
      'bpsc',
      'Bangladesh Public Service Commission',
      'বাংলাদেশ সরকারি কর্ম কমিশন',
      'BPSC',
      'https://bpsc.gov.bd',
    ],
    [
      'ntrca',
      'Non-Government Teachers Registration & Certification Authority',
      'বেসরকারি শিক্ষক নিবন্ধন ও প্রত্যয়ন কর্তৃপক্ষ',
      'NTRCA',
      'https://ntrca.gov.bd',
    ],
    [
      'bsc-bank',
      "Bankers' Selection Committee",
      'ব্যাংকার্স সিলেকশন কমিটি',
      'BSC',
      'https://erecruitment.bb.org.bd',
    ],
  ];
  const authIds: Record<string, string> = {};
  for (const [slug, name, nameBn, shortName, website] of auths) {
    authIds[slug] = (
      await prisma.recruitingAuthority.upsert({
        where: { slug },
        update: {},
        create: { slug, name, nameBn, shortName, website },
      })
    ).id;
  }

  const exam = await prisma.exam.upsert({
    where: { slug: 'bcs-demo' },
    update: {},
    create: {
      slug: 'bcs-demo',
      name: 'BCS Examination (demo profile)',
      nameBn: 'বিসিএস পরীক্ষা (ডেমো)',
      shortName: 'BCS',
      categoryId: catIds.bcs,
      authorityId: authIds.bpsc,
      description:
        'Demonstration exam profile for development. Verify every detail against the latest official BPSC circular.',
      eligibility: {
        note: 'DEMONSTRATION DATA — not an official eligibility rule. Always consult the official circular.',
        sourceRequired: true,
      },
      pattern: { note: 'Illustrative structure only', stages: ['Preliminary (MCQ)', 'Written', 'Viva voce'] },
      officialUrl: 'https://bpsc.gov.bd',
      status: PublishStatus.PUBLISHED,
      isFeatured: true,
    },
  });
  const prelim = await prisma.examStage.upsert({
    where: { examId_sequence: { examId: exam.id, sequence: 1 } },
    update: {},
    create: {
      examId: exam.id,
      name: 'Preliminary (demo)',
      nameBn: 'প্রিলিমিনারি (ডেমো)',
      sequence: 1,
      totalMarks: 200,
      durationMinutes: 120,
      negativeMarking: 0.5,
      description: 'Illustrative MCQ stage.',
    },
  });
  await prisma.examStage.upsert({
    where: { examId_sequence: { examId: exam.id, sequence: 2 } },
    update: {},
    create: { examId: exam.id, name: 'Written (demo)', sequence: 2 },
  });

  // Curriculum
  const curriculum: Record<
    string,
    {
      name: string;
      nameBn: string;
      chapters: Record<string, { name: string; topics: Record<string, string> }>;
    }
  > = {
    mathematics: {
      name: 'Mathematics',
      nameBn: 'গণিত',
      chapters: {
        arithmetic: {
          name: 'Arithmetic',
          topics: {
            percentage: 'Percentage',
            'time-speed-distance': 'Time, speed & distance',
            average: 'Average',
          },
        },
      },
    },
    'general-knowledge': {
      name: 'Bangladesh affairs',
      nameBn: 'বাংলাদেশ বিষয়াবলি',
      chapters: {
        general: {
          name: 'General',
          topics: { 'bangladesh-basics': 'Bangladesh basics', history: 'History' },
        },
      },
    },
    english: {
      name: 'English language',
      nameBn: 'ইংরেজি ভাষা',
      chapters: { language: { name: 'Language', topics: { vocabulary: 'Vocabulary', grammar: 'Grammar' } } },
    },
  };
  const topicIds: Record<string, { id: string; subjectId: string }> = {};
  for (const [i, [sslug, s]] of Object.entries(curriculum).entries()) {
    const subject = await prisma.subject.upsert({
      where: { slug: sslug },
      update: {},
      create: { slug: sslug, name: s.name, nameBn: s.nameBn, sortOrder: i },
    });
    for (const [cslug, c] of Object.entries(s.chapters)) {
      const chapter = await prisma.chapter.upsert({
        where: { subjectId_slug: { subjectId: subject.id, slug: cslug } },
        update: {},
        create: { subjectId: subject.id, slug: cslug, name: c.name },
      });
      for (const [j, [tslug, tname]] of Object.entries(c.topics).entries()) {
        const t = await prisma.topic.upsert({
          where: { chapterId_slug: { chapterId: chapter.id, slug: tslug } },
          update: {},
          create: { chapterId: chapter.id, slug: tslug, name: tname, sortOrder: j },
        });
        topicIds[tslug] = { id: t.id, subjectId: subject.id };
      }
    }
  }
  await prisma.topicRelationship.upsert({
    where: {
      fromTopicId_toTopicId_type: {
        fromTopicId: topicIds.percentage.id,
        toTopicId: topicIds['time-speed-distance'].id,
        type: 'RELATED',
      },
    },
    update: {},
    create: {
      fromTopicId: topicIds.percentage.id,
      toTopicId: topicIds['time-speed-distance'].id,
      type: 'RELATED',
    },
  });

  const syllabus = await prisma.syllabusVersion.upsert({
    where: { examId_label: { examId: exam.id, label: 'Demo syllabus v1' } },
    update: {},
    create: {
      examId: exam.id,
      stageId: prelim.id,
      label: 'Demo syllabus v1',
      status: PublishStatus.PUBLISHED,
      isCurrent: true,
      notes: 'Demonstration mapping; weights are illustrative.',
    },
  });
  const weights: Record<string, number> = {
    percentage: 0.6,
    'time-speed-distance': 0.5,
    average: 0.4,
    'bangladesh-basics': 0.7,
    history: 0.8,
    vocabulary: 0.6,
    grammar: 0.7,
  };
  for (const [slug, w] of Object.entries(weights)) {
    await prisma.examTopicMapping.upsert({
      where: { syllabusVersionId_topicId: { syllabusVersionId: syllabus.id, topicId: topicIds[slug].id } },
      update: {},
      create: {
        examId: exam.id,
        syllabusVersionId: syllabus.id,
        topicId: topicIds[slug].id,
        weight: new Prisma.Decimal(w),
        marks: 10,
      },
    });
  }

  // Demo questions (published through the same draft → reviewed → published states the API uses)
  const source =
    (await prisma.questionSource.findFirst({
      where: { type: QuestionSourceType.DEMONSTRATION, title: 'Demonstration content' },
    })) ??
    (await prisma.questionSource.create({
      data: {
        type: QuestionSourceType.DEMONSTRATION,
        title: 'Demonstration content',
        reference: 'Seed data — not from any official paper',
        isOfficial: false,
      },
    }));
  const existing = await prisma.question.count({ where: { isDemo: true } });
  const all = [...arithmeticQuestions(), ...GK, ...ENGLISH];
  if (!existing) {
    for (const [n, q] of all.entries()) {
      const t = topicIds[q.topic];
      await prisma.$transaction(async (tx) => {
        const question = await tx.question.create({
          data: {
            code: `DEMO-${String(n + 1).padStart(4, '0')}`,
            type: QuestionType.SINGLE_CHOICE,
            difficulty: q.difficulty ?? Difficulty.MEDIUM,
            subjectId: t.subjectId,
            topicId: t.id,
            sourceId: source.id,
            isDemo: true,
            createdById: editor.id,
            status: ContentStatus.PUBLISHED,
            publishedAt: new Date(),
          },
        });
        const version = await tx.questionVersion.create({
          data: {
            questionId: question.id,
            versionNumber: 1,
            stem: q.stem,
            status: ContentStatus.PUBLISHED,
            createdById: editor.id,
            options: {
              create: q.options.map((text, i) => ({
                key: 'ABCD'[i],
                text,
                isCorrect: i === q.correct,
                sortOrder: i,
              })),
            },
            explanation: { create: { content: q.explanation } },
          },
        });
        await tx.contentReview.create({
          data: {
            entityType: 'QUESTION',
            entityId: question.id,
            questionVersionId: version.id,
            reviewerId: reviewer.id,
            decision: 'APPROVED',
            comments: 'Seed demonstration content',
          },
        });
        await tx.question.update({
          where: { id: question.id },
          data: { latestVersionId: version.id, publishedVersionId: version.id },
        });
        await tx.examQuestionMapping.create({ data: { examId: exam.id, questionId: question.id } });
      });
    }
  }

  // Demo mock exam (frozen version)
  const mockSlug = 'bcs-demo-mini-mock';
  let mock = await prisma.mockExamTemplate.findUnique({ where: { slug: mockSlug } });
  if (!mock) {
    const config = {
      durationMinutes: 20,
      passMarks: 8,
      shuffleQuestions: true,
      shuffleOptions: true,
      multiSelectPolicy: 'EXACT',
      allowNegativeTotal: false,
      resultVisibility: 'IMMEDIATE',
      sections: [
        {
          title: 'Mathematics',
          subjectId: topicIds.percentage.subjectId,
          selectionMode: 'RANDOM',
          questionCount: 6,
          marksPerQuestion: 1,
          negativeMarks: 0.5,
        },
        {
          title: 'Bangladesh affairs',
          subjectId: topicIds.history.subjectId,
          selectionMode: 'RANDOM',
          questionCount: 4,
          marksPerQuestion: 1,
          negativeMarks: 0.5,
        },
        {
          title: 'English',
          subjectId: topicIds.grammar.subjectId,
          selectionMode: 'RANDOM',
          questionCount: 4,
          marksPerQuestion: 1,
          negativeMarks: 0.5,
        },
      ],
    };
    mock = await prisma.mockExamTemplate.create({
      data: {
        slug: mockSlug,
        title: 'Demo mini mock (BCS-style practice)',
        titleBn: 'ডেমো মিনি মক',
        description: 'Demonstration mock built from demo questions. Not an official paper.',
        examId: exam.id,
        stageId: prelim.id,
        isDemo: true,
        draftConfig: config as Prisma.InputJsonValue,
        createdById: editor.id,
      },
    });
    const version = await prisma.mockExamTemplateVersion.create({
      data: {
        templateId: mock.id,
        versionNumber: 1,
        durationMinutes: 20,
        totalMarks: 14,
        passMarks: 8,
        configSnapshot: config as Prisma.InputJsonValue,
        publishedById: admin.id,
        sections: {
          create: config.sections.map((s, i) => ({
            title: s.title,
            sequence: i + 1,
            subjectId: s.subjectId,
            selectionMode: SelectionMode.RANDOM,
            questionCount: s.questionCount,
            marksPerQuestion: 1,
            negativeMarks: 0.5,
          })),
        },
      },
    });
    await prisma.mockExamTemplate.update({
      where: { id: mock.id },
      data: { currentVersionId: version.id, status: PublishStatus.PUBLISHED },
    });
  }

  // Subscription plans (prices in paisa)
  const plans: Array<{
    code: string;
    name: string;
    nameBn: string;
    priceMinor: number;
    durationDays: number;
    features: Array<[string, number | null]>;
  }> = [
    {
      code: 'premium-monthly',
      name: 'Premium monthly',
      nameBn: 'প্রিমিয়াম মাসিক',
      priceMinor: 29900,
      durationDays: 30,
      features: [
        ['mock.premium', null],
        ['practice.questions', null],
        ['ai.assistant', 100],
        ['materials.premium', null],
        ['analytics.advanced', null],
        ['knowledge.premium', null],
      ],
    },
    {
      code: 'premium-yearly',
      name: 'Premium yearly',
      nameBn: 'প্রিমিয়াম বার্ষিক',
      priceMinor: 249900,
      durationDays: 365,
      features: [
        ['mock.premium', null],
        ['practice.questions', null],
        ['ai.assistant', 200],
        ['materials.premium', null],
        ['analytics.advanced', null],
        ['knowledge.premium', null],
      ],
    },
  ];
  for (const [i, p] of plans.entries()) {
    const plan = await prisma.subscriptionPlan.upsert({
      where: { code: p.code },
      update: {},
      create: {
        code: p.code,
        name: p.name,
        nameBn: p.nameBn,
        priceMinor: p.priceMinor,
        durationDays: p.durationDays,
        sortOrder: i,
      },
    });
    for (const [featureKey, limitValue] of p.features) {
      await prisma.planFeature.upsert({
        where: { planId_featureKey: { planId: plan.id, featureKey } },
        update: {},
        create: { planId: plan.id, featureKey, limitValue },
      });
    }
  }

  // Public configuration
  const settings: Array<[string, unknown, boolean, string]> = [
    ['app.android.min_version', '1.0.0', true, 'Minimum supported Android app version'],
    ['app.maintenance_mode', false, true, 'Show maintenance banner in clients'],
    ['content.require_distinct_reviewer', true, false, 'Reviewer must differ from the author'],
    ['practice.free_daily_questions', 50, false, 'Free-tier practice quota per day'],
  ];
  for (const [key, value, isPublic, description] of settings) {
    await prisma.systemSetting.upsert({
      where: { key },
      update: {},
      create: { key, value: value as Prisma.InputJsonValue, isPublic, description },
    });
  }

  // System flashcards
  if (!(await prisma.flashcard.count({ where: { ownerId: null } }))) {
    await prisma.flashcard.createMany({
      data: [
        {
          front: 'Percentage formula',
          back: 'x% of N = N × x / 100',
          topicId: topicIds.percentage.id,
          deck: 'maths-formulas',
          isPublic: true,
        },
        {
          front: 'Distance formula',
          back: 'Distance = Speed × Time',
          topicId: topicIds['time-speed-distance'].id,
          deck: 'maths-formulas',
          isPublic: true,
        },
        {
          front: 'Average',
          back: 'Average = Sum of values ÷ Number of values',
          topicId: topicIds.average.id,
          deck: 'maths-formulas',
          isPublic: true,
        },
      ],
    });
  }

  // Knowledge source awaiting review (approve it via the admin API to index it)
  if (!(await prisma.knowledgeSource.count())) {
    await prisma.knowledgeSource.create({
      data: {
        title: 'Demo study note: percentages',
        mimeType: 'text/markdown',
        rawText:
          '# Percentages\n\nA percentage is a fraction of 100. To find x% of N, multiply N by x and divide by 100.\n\nFor example, 15% of 240 is 240 × 15 / 100 = 36.\n\n# Average\n\nThe average (arithmetic mean) is the sum of the values divided by how many values there are.',
        examId: exam.id,
        createdById: editor.id,
      },
    });
  }

  console.log(`Seed complete: ${all.length} demonstration questions, 1 demo mock, ${plans.length} plans.`);
  console.log(
    `Demo accounts (password from SEED_PASSWORD, default "ChangeMe123!"): admin@example.com, editor@example.com, reviewer@example.com, student@example.com`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
