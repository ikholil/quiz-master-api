import type { UserStats } from '@prisma/client';

/** XP awarded per event. Effort is rewarded too, so weaker students are not discouraged. */
export const XP = {
  PRACTICE_CORRECT: 3,
  PRACTICE_ATTEMPT: 1,
  MOCK_COMPLETED: 20,
  DAILY_CORRECT: 10,
  DAILY_ATTEMPT: 3,
  STREAK_WEEK_BONUS: 25,
} as const;

/** Level n starts at 50·(n−1)² XP: 1→0, 2→50, 3→200, 4→450, 10→4050 … */
export function xpForLevel(level: number): number {
  return 50 * (level - 1) ** 2;
}
export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
}

export interface AchievementContext {
  stats: Pick<
    UserStats,
    'xp' | 'level' | 'currentStreak' | 'longestStreak' | 'questionsAnswered' | 'correctAnswers'
  >;
  mocksCompleted: number;
  dailyChallengesCorrect: number;
  mockCompleted?: boolean;
  mockPercent?: number;
  mockQuestions?: number;
}

export interface Achievement {
  key: string;
  name: string;
  nameBn: string;
  description: string;
  icon: string;
  check: (c: AchievementContext) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  {
    key: 'FIRST_STEP',
    name: 'First step',
    nameBn: 'প্রথম পদক্ষেপ',
    description: 'Answer your first question',
    icon: 'footprints',
    check: (c) => c.stats.questionsAnswered >= 1,
  },
  {
    key: 'CENTURY',
    name: 'Century',
    nameBn: 'সেঞ্চুরি',
    description: 'Answer 100 questions',
    icon: 'hundred',
    check: (c) => c.stats.questionsAnswered >= 100,
  },
  {
    key: 'THOUSAND',
    name: 'Marathoner',
    nameBn: 'ম্যারাথনার',
    description: 'Answer 1,000 questions',
    icon: 'medal',
    check: (c) => c.stats.questionsAnswered >= 1000,
  },
  {
    key: 'SHARPSHOOTER',
    name: 'Sharpshooter',
    nameBn: 'নিখুঁত নিশানা',
    description: 'Keep 80% accuracy over at least 200 answers',
    icon: 'target',
    check: (c) =>
      c.stats.questionsAnswered >= 200 && c.stats.correctAnswers / c.stats.questionsAnswered >= 0.8,
  },
  {
    key: 'STREAK_7',
    name: 'One-week streak',
    nameBn: '৭ দিনের ধারাবাহিকতা',
    description: 'Study 7 days in a row',
    icon: 'flame',
    check: (c) => c.stats.longestStreak >= 7,
  },
  {
    key: 'STREAK_30',
    name: 'Unstoppable',
    nameBn: 'অপ্রতিরোধ্য',
    description: 'Study 30 days in a row',
    icon: 'fire',
    check: (c) => c.stats.longestStreak >= 30,
  },
  {
    key: 'FIRST_MOCK',
    name: 'Exam ready',
    nameBn: 'পরীক্ষার প্রস্তুতি',
    description: 'Complete your first mock exam',
    icon: 'clipboard',
    check: (c) => c.mocksCompleted >= 1,
  },
  {
    key: 'TEN_MOCKS',
    name: 'Mock veteran',
    nameBn: 'মক অভিজ্ঞ',
    description: 'Complete 10 mock exams',
    icon: 'trophy',
    check: (c) => c.mocksCompleted >= 10,
  },
  {
    key: 'PERFECT_MOCK',
    name: 'Perfectionist',
    nameBn: 'পূর্ণ নম্বর',
    description: 'Score 100% in a mock of at least 10 questions',
    icon: 'star',
    check: (c) => !!c.mockCompleted && (c.mockQuestions ?? 0) >= 10 && (c.mockPercent ?? 0) >= 0.9999,
  },
  {
    key: 'DAILY_10',
    name: 'Daily devotee',
    nameBn: 'প্রতিদিনের চ্যালেঞ্জার',
    description: 'Get 10 daily challenges right',
    icon: 'calendar',
    check: (c) => c.dailyChallengesCorrect >= 10,
  },
  {
    key: 'LEVEL_10',
    name: 'Scholar',
    nameBn: 'বিদ্বান',
    description: 'Reach level 10',
    icon: 'crown',
    check: (c) => c.stats.level >= 10,
  },
];
