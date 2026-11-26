# Question bank & past-paper archive

## 1. Original practice bank (ships with the platform)

`prisma/question-bank/` generates **~2,700 original multiple-choice questions** across 9 subjects and 50+ topics:

| Subject | Questions | How correctness is guaranteed |
|---|---|---|
| Mathematics (percentage, profit/loss, interest, ratio, average, speed, work, LCM/HCF, number system, fractions, ages, boats, units, equations, powers, mensuration, clock angles) | ~1,450 | Computed by code from parameters; explanation shows the working |
| Mental ability (number/letter series, coding–decoding, directions, calendar, ranking) | ~160 | Computed |
| ICT (number systems, logic gates, acronyms, computing facts) | ~170 | Computed / curated |
| English (synonyms, antonyms, one-word substitution, idioms, spelling, verb forms, plurals, comparison, articles) | ~280 | Curated lists; distractors drawn from semantically unrelated entries |
| Bangla language & literature (সমার্থক/বিপরীত শব্দ, গ্রন্থ ও রচয়িতা, উপাধি) | ~110 | Curated; works with more than one well-known author are excluded |
| Bangladesh affairs, international affairs, general science | ~500 | Curated **stable** facts only — no office holders, statistics or other facts that change |

Guarantees enforced at build time (`buildQuestionBank()` throws otherwise) and re-checked by `question-bank.spec.ts`,
which recomputes answers independently of the generators:

- exactly four unique options and one correct key; correct position spread evenly across A–D;
- every computed answer (percentages, interest, binary/hex, logic gates, squares/roots, LCM/HCF …) is recomputed;
- no question claims to come from an official or previous-year paper.

Questions carry the source **"Quiz Master original practice bank"** (`type = ORIGINAL`, `isOfficial = false`), the tag
`qm-original`, and a content hash so loading is idempotent.

```bash
npm run bank:summary
```

```bash
npm run bank:sample -- 25
```

```bash
npm run bank:load
```

`bank:load` puts questions in the **review queue** (production default). For development/staging,
`npm run bank:load -- --published` publishes them and creates five illustrative exam profiles (BCS, bank, NTRCA, primary
teacher, admission) with a syllabus mapping and a **full-length practice mock** each (e.g. 100 questions / 120 minutes /
0.5 negative marking for the BCS-style mock). The dev seed does this automatically (`SEED_QUESTION_BANK=false` to skip).

To grow the bank, add a generator or a curated list under `prisma/question-bank/generators/`, then add an
independent recomputation check to `question-bank.spec.ts` for anything computed.

## 2. Real previous-year papers

The platform **does not ship official past papers**. They are the recruiting authorities' material: obtain them from a
source you have the right to use, and import them through the archive. Nothing is shown as official until a staff
member verifies it against evidence.

### Workflow

1. **Create the paper** — `POST /admin/previous-papers` with exam, year, title, duration, total marks and negative marking.
   This also creates the paper's `PREVIOUS_YEAR` source (not official yet).
2. **Import the questions** — upload a CSV/JSON file (`POST /files`, purpose `QUESTION_IMPORT`), then
   `POST /admin/previous-papers/{id}/import`. Required extra column: `question_number`. Optional: `section`.
   Questions that already exist in the bank (≥ 95 % trigram similarity) are **linked**, not duplicated.
   Imported questions enter the review queue by default.
3. **Review and publish** the questions through the normal four-eyes workflow.
4. **Verify** — `POST /admin/previous-papers/{id}/verify` with `status: VERIFIED`, `answerKeyType` (`OFFICIAL` only
   if the authority published a key; otherwise `EXPERT`) and `evidenceUrl` or `evidenceFileId`. Verification is
   required before questions show a "BCS 2019"-style source label to students.
5. **Mark disputed keys** — `PATCH /admin/previous-papers/{id}/questions/{questionId}/dispute` when an answer key
   was contested or later corrected; students see the note.
6. **Publish** the paper (`PATCH /admin/previous-papers/{id}/details`, `status: PUBLISHED`) and optionally create a
   **timed replay** (`POST /admin/previous-papers/{id}/replay-mock`) that keeps the original order, timing and
   negative marking.

Students then get `GET /public/previous-papers`, the numbered paper (no answers) with a verification disclaimer,
`PAPER` practice mode (original order, instant feedback) and the replay mock with leaderboards.

### CSV columns

`question_number, type, difficulty, subject, topic, stem, stem_bn, option_a … option_h, correct, accepted_answers,
explanation, marks, tags, exams, source_type, source_title, source_year, section`

- `subject` is a subject slug; `topic` is `chapter-slug/topic-slug` (see `prisma/question-bank/taxonomy.ts`);
- `correct` is `A` or `A|C`; `exams` is `slug;slug`.

### Topic frequency → adaptive engine

`GET /public/exams/{examId}/topic-frequency` reports how often each topic appears across **verified** papers
(appearances, share, coverage, last year asked). `POST /admin/syllabus-versions/{id}/weights-from-papers` turns that
into syllabus weights (normalised 0.1–1.0), which the adaptive learning engine uses to prioritise study plans.

## 3. Quality control after launch

- **Item analysis** (nightly, or `POST /admin/question-quality/run`): p-value, upper–lower discrimination index,
  empirically calibrated difficulty and quality flags (`POSSIBLE_KEY_ERROR`, `NEGATIVE_DISCRIMINATION`,
  `LOW_DISCRIMINATION`, `TOO_EASY`, `TOO_HARD`) from final exam results (minimum 30 responses).
- **Distractor analysis**: `GET /admin/question-quality/questions/{id}/distractors` — pick rate of every option, overall and
  among the top 27 % of students.
- **Calibration**: `POST /admin/question-quality/apply-calibration` (explicit, audited) replaces authored difficulty with
  the measured one once enough responses exist.
- **Duplicates**: `POST /admin/question-quality/similar` while authoring; the admin question view also lists
  `possibleDuplicates`; imports skip near-duplicates (≥ 90 %).
- Student error reports (`POST /questions/{id}/reports`) feed the existing report queue.
