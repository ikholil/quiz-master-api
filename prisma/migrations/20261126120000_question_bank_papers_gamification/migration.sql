
-- CreateEnum
CREATE TYPE "PaperVerification" AS ENUM ('UNVERIFIED', 'VERIFIED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "AnswerKeyType" AS ENUM ('OFFICIAL', 'EXPERT', 'NONE');

-- CreateEnum
CREATE TYPE "ExamEventType" AS ENUM ('CIRCULAR', 'APPLICATION_START', 'APPLICATION_DEADLINE', 'ADMIT_CARD', 'EXAM_DATE', 'RESULT', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PracticeMode" ADD VALUE 'PAPER';
ALTER TYPE "PracticeMode" ADD VALUE 'BOOKMARKS';




-- AlterTable
ALTER TABLE "previous_year_papers" ADD COLUMN     "answerKeyType" "AnswerKeyType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "durationMinutes" INTEGER,
ADD COLUMN     "evidenceFileId" UUID,
ADD COLUMN     "evidenceUrl" TEXT,
ADD COLUMN     "heldOn" DATE,
ADD COLUMN     "negativeMarking" DECIMAL(6,2),
ADD COLUMN     "stageId" UUID,
ADD COLUMN     "totalMarks" DECIMAL(8,2),
ADD COLUMN     "verificationStatus" "PaperVerification" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "verifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "verifiedById" UUID;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "calibratedDifficulty" "Difficulty",
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "discrimination" DOUBLE PRECISION,
ADD COLUMN     "pValue" DOUBLE PRECISION,
ADD COLUMN     "qualityFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "statsSampleSize" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "statsUpdatedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "paper_questions" (
    "paperId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "questionNumber" INTEGER NOT NULL,
    "section" TEXT,
    "marks" DECIMAL(8,2),
    "answerDisputed" BOOLEAN NOT NULL DEFAULT false,
    "disputeNote" TEXT,

    CONSTRAINT "paper_questions_pkey" PRIMARY KEY ("paperId","questionId")
);

-- CreateTable
CREATE TABLE "exam_events" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "type" "ExamEventType" NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "sourceUrl" TEXT,
    "noticeId" UUID,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exam_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_bookmarks" (
    "userId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "note" TEXT,
    "folder" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "question_bookmarks_pkey" PRIMARY KEY ("userId","questionId")
);

-- CreateTable
CREATE TABLE "user_stats" (
    "userId" UUID NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" DATE,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "correctAnswers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_stats_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "xp_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_achievements" (
    "userId" UUID NOT NULL,
    "achievementKey" TEXT NOT NULL,
    "earnedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("userId","achievementKey")
);

-- CreateTable
CREATE TABLE "daily_challenges" (
    "date" DATE NOT NULL,
    "questionId" UUID NOT NULL,
    "questionVersionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_challenges_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "daily_challenge_answers" (
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "selectedOptionIds" UUID[],
    "isCorrect" BOOLEAN NOT NULL,
    "timeSpentMs" INTEGER,
    "answeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_challenge_answers_pkey" PRIMARY KEY ("userId","date")
);

-- CreateIndex
CREATE INDEX "paper_questions_questionId_idx" ON "paper_questions"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "paper_questions_paperId_questionNumber_key" ON "paper_questions"("paperId", "questionNumber");

-- CreateIndex
CREATE INDEX "exam_events_examId_startsAt_idx" ON "exam_events"("examId", "startsAt");

-- CreateIndex
CREATE INDEX "exam_events_status_startsAt_idx" ON "exam_events"("status", "startsAt");

-- CreateIndex
CREATE INDEX "question_bookmarks_userId_folder_idx" ON "question_bookmarks"("userId", "folder");

-- CreateIndex
CREATE INDEX "user_stats_xp_idx" ON "user_stats"("xp");

-- CreateIndex
CREATE INDEX "xp_events_createdAt_userId_idx" ON "xp_events"("createdAt", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "xp_events_userId_reason_refId_key" ON "xp_events"("userId", "reason", "refId");

-- CreateIndex
CREATE INDEX "daily_challenge_answers_date_isCorrect_timeSpentMs_idx" ON "daily_challenge_answers"("date", "isCorrect", "timeSpentMs");

-- CreateIndex
CREATE UNIQUE INDEX "questions_contentHash_key" ON "questions"("contentHash");

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "previous_year_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_questions" ADD CONSTRAINT "paper_questions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_events" ADD CONSTRAINT "exam_events_examId_fkey" FOREIGN KEY ("examId") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_bookmarks" ADD CONSTRAINT "question_bookmarks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_bookmarks" ADD CONSTRAINT "question_bookmarks_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_challenge_answers" ADD CONSTRAINT "daily_challenge_answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_challenge_answers" ADD CONSTRAINT "daily_challenge_answers_date_fkey" FOREIGN KEY ("date") REFERENCES "daily_challenges"("date") ON DELETE CASCADE ON UPDATE CASCADE;


-- Item-analysis values are proportions; XP awards are positive.
ALTER TABLE "questions" ADD CONSTRAINT "questions_pvalue_chk" CHECK ("pValue" IS NULL OR ("pValue" >= 0 AND "pValue" <= 1));
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_chk" CHECK ("xp" >= 0 AND "level" >= 1 AND "correctAnswers" <= "questionsAnswered");
