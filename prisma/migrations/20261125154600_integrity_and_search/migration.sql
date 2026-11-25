-- Integrity constraints that Prisma cannot express declaratively, plus search/vector indexes.

-- Marks and counts must never be negative / impossible.
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_default_marks_chk" CHECK ("defaultMarks" > 0);
ALTER TABLE "mock_exam_sections" ADD CONSTRAINT "mock_exam_sections_marks_chk" CHECK ("marksPerQuestion" > 0 AND "negativeMarks" >= 0 AND "negativeMarks" <= "marksPerQuestion" AND "questionCount" > 0);
ALTER TABLE "mock_exam_template_versions" ADD CONSTRAINT "mock_exam_template_versions_chk" CHECK ("durationMinutes" > 0 AND "totalMarks" > 0);
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_marks_chk" CHECK (
  "maxMarks" > 0 AND "negativeMarks" >= 0 AND
  ("awardedMarks" IS NULL OR ("awardedMarks" <= "maxMarks" AND "awardedMarks" >= -"negativeMarks"))
);
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_time_chk" CHECK ("timeSpentMs" >= 0);
ALTER TABLE "attempt_results" ADD CONSTRAINT "attempt_results_marks_chk" CHECK ("obtainedMarks" <= "totalMarks" AND "accuracy" >= 0 AND "accuracy" <= 100);
ALTER TABLE "exam_attempts" ADD CONSTRAINT "exam_attempts_window_chk" CHECK ("expiresAt" > "startedAt");
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("amountMinor" > 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_chk" CHECK ("amountMinor" > 0);
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_chk" CHECK ("priceMinor" >= 0 AND "durationDays" > 0);
ALTER TABLE "topic_mastery" ADD CONSTRAINT "topic_mastery_range_chk" CHECK ("masteryScore" >= 0 AND "masteryScore" <= 1 AND "recentAccuracy" >= 0 AND "recentAccuracy" <= 1);
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_feedback_chk" CHECK ("feedbackRating" IS NULL OR "feedbackRating" IN (-1, 1));

-- Only one IN_PROGRESS attempt per user per template version (prevents parallel attempts by double-tap).
CREATE UNIQUE INDEX "exam_attempts_one_active_idx" ON "exam_attempts" ("userId", "templateVersionId") WHERE "status" = 'IN_PROGRESS';
-- A submission idempotency key can only be used once per user.
CREATE UNIQUE INDEX "exam_attempts_submission_key_idx" ON "exam_attempts" ("userId", "submissionKey") WHERE "submissionKey" IS NOT NULL;
-- Only one current syllabus version per exam.
CREATE UNIQUE INDEX "syllabus_versions_current_idx" ON "syllabus_versions" ("examId") WHERE "isCurrent" = true;
-- Only one active prompt template per key.
CREATE UNIQUE INDEX "prompt_templates_active_idx" ON "prompt_templates" ("key") WHERE "isActive" = true;

-- Trigram search over question text.
CREATE INDEX "question_versions_stem_trgm_idx" ON "question_versions" USING gin ("stem" gin_trgm_ops);
CREATE INDEX "discussions_title_trgm_idx" ON "discussions" USING gin ("title" gin_trgm_ops);

-- Approximate nearest neighbour index for retrieval (cosine distance).
CREATE INDEX "chunk_embeddings_hnsw_idx" ON "chunk_embeddings" USING hnsw ("embedding" vector_cosine_ops);
