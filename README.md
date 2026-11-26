# Quiz Master API

Backend for a Bangladesh competitive-examination preparation platform — BCS, government jobs, bank recruitment,
NTRCA teacher registration, teacher recruitment, university admission and any other exam an administrator defines.

It serves two clients through one versioned REST contract (`/api/v1`, OpenAPI in [`openapi/openapi.json`](openapi/openapi.json)):

- the **Kotlin Android** student app, and
- the **Next.js** administration dashboard.

**Stack:** NestJS 11 · TypeScript · PostgreSQL 16 + pgvector + pg_trgm · Prisma 6 · Redis · BullMQ · JWT · Swagger · Jest · pino.
A modular monolith: one deployable, 27 domain modules, API and workers can run as separate processes of the same image.

---

## Quick start (local)

Requirements: Node 22, PostgreSQL 16 with the `vector` extension (or `docker compose up postgres redis`), Redis 7.

```bash
npm ci
```

```bash
cp .env.example .env
```

```bash
npx prisma migrate deploy && npm run db:seed
```

```bash
npm run start:dev
```

- API: <http://localhost:3000/api/v1> · Swagger UI: <http://localhost:3000/api/docs> · JSON: `/api/docs-json`
- Health: `/api/v1/health/live`, `/api/v1/health/ready` (DB, Redis, storage)
- Seeded accounts (password `ChangeMe123!` or `SEED_PASSWORD`): `admin@example.com` (super admin),
  `editor@example.com`, `reviewer@example.com`, `student@example.com` / `01700000001`.
- In development the OTP endpoints return `devCode` so you can sign in without an SMS gateway.

**Everything the seed creates is demonstration content.** Questions carry `isDemo: true` and a `DEMONSTRATION` source,
the sample exam is labelled “demo profile”, and nothing in it is an official paper, answer key, circular or eligibility rule.

### Full stack with Docker Compose

```bash
cp .env.docker.example .env.docker
```

```bash
docker compose up --build
```

Brings up PostgreSQL (pgvector), Redis, MinIO (S3-compatible storage), a one-shot `migrate` job, an `api`
container (`WORKERS_ENABLED=false`) and a `worker` container running every BullMQ processor and scheduler.

---

## Tests

| Command | What it runs |
|---|---|
| `npm test` | 72 unit tests: scoring engine, negative marking, adaptive engine, SM-2, plan generation, content validation, CSV import, AI fallback & guardrails, payment signature verification, chunking, utilities |
| `npm run test:integration` | 28 API tests against real PostgreSQL + Redis (`quiz_master_test`, Redis DB 15): OTP auth, refresh rotation & reuse detection, brute-force lockout, RBAC, account deletion/export, question review/publication, answer hiding, full attempts, idempotent concurrent submission, rule & question versioning, auto-submit, manual evaluation, payment webhooks (forged / duplicate / amount mismatch), entitlements, renewal, refunds, practice → mastery → recommendations → study plan, RAG with citations |
| `npm run test:all` | both |

Integration tests set `WORKERS_ENABLED=false` and call job handlers directly, so assertions are deterministic.
Configure `TEST_DATABASE_URL` / `TEST_REDIS_URL` if your services are elsewhere.

---

## Architecture

```
src/
  main.ts / bootstrap.ts      HTTP setup shared by the server, OpenAPI generator and tests
  config/                     typed, validated env config (refuses weak secrets in production)
  common/                     envelope interceptor, exception filter, guards' decorators, pagination, utils
  prisma/ redis/ queue/       infrastructure + BullMQ queues and cron schedulers
  modules/
    auth  users  rbac  audit  system-config  files  health
    exams  syllabus  questions  mock-exams  attempts  practice
    learning  study-plans  revision  materials
    ai  knowledge  courses  subscriptions  payments
    notifications  community  moderation  support  analytics  maintenance
```

Requests pass through: rate limiter (Redis-backed, multi-instance safe) → JWT guard (verifies token **and** that the
session is not revoked) → permission guard → entitlement guard → strict DTO validation → service → envelope.

### Key design decisions

**Backend-authoritative exam engine.** Start time, deadline, remaining time, scoring and status are computed only on the
server. When an attempt starts, the engine copies the template's frozen rules (`rulesSnapshot`) and pins every question to an
immutable `QuestionVersion`; option order and question order are randomised from a stored seed. Editing a question or a
template creates a new version, so **existing attempts are never silently re-scored**.

**Exactly-once submission.** Submission is a conditional `IN_PROGRESS → SUBMITTED` update inside the scoring transaction,
`AttemptResult.attemptId` is unique, and a partial unique index allows one in-progress attempt per user per version. Retries
(with or without `Idempotency-Key`), double taps and the delayed auto-submit job all converge on one result.

**Exact marks.** Scoring runs on integer hundredths, so `63 correct − 37 × 0.25 = 53.75` exactly. Database CHECK
constraints reject impossible marks (awarded > max, negative > per-question marks, …).

**Answers are never leaked.** Student views are built by a projection that has no access to `isCorrect`, accepted
answers, rubrics or explanations; answer keys are only returned for submitted attempts (and after the exam window for
`AFTER_WINDOW` exams) or after a practice answer is locked in.

**Content workflow.** `DRAFT → IN_REVIEW → APPROVED → PUBLISHED`, with four-eyes review (authors cannot approve their own
content; enforced always for AI drafts). Only published, non-deleted questions reach student APIs.

**Deterministic adaptive learning.** Topic mastery (difficulty-weighted EWMA + overall accuracy + speed, discounted by
evidence), topic priority (weakness, syllabus weight, staleness, coverage, revision due, decline, prerequisite gaps — each
returned as an explainable factor), SM-2 spaced repetition and a daily-plan generator with missed-task recovery. No AI
provider is involved, so learning features keep working when AI is unavailable.

**AI with guardrails.** Provider chain (`AI_PROVIDERS=anthropic,openai,local`) with automatic fallback, token/cost
accounting per call, per-plan daily quotas, prompt templates versioned in the DB, and RAG over **approved** sources only
(pgvector HNSW, visibility/entitlement filters, authoritative-source boost, citations). Questions about official dates,
eligibility, notices or answer keys are answered only from authoritative sources; otherwise the assistant declines.
AI-generated questions are saved as drafts and need human review. Chat generation runs in a worker (clients poll).

**Payments.** Provider abstraction (SSLCommerz implemented — cards, bKash, Nagad, Rocket via its hosted checkout; sandbox
for dev/tests). Price always comes from the server catalogue; webhooks are signature-verified, de-duplicated by
`(provider, eventId)`, and only trigger a server-to-server verification; fulfilment (subscription/enrolment + entitlements)
happens in the same transaction as the status change. A reconciliation job re-verifies stale pending payments.

---

## API contract for the clients

- **Base URL:** `/api/v1`. Groups: `/public/*` (no auth), `/*` (student, bearer token), `/admin/*` (staff + permissions).
- **Success:** `{ "success": true, "data": …, "meta": { "requestId", "pagination?" } }`
- **Error:** `{ "success": false, "error": { "code": "ATTEMPT_EXPIRED", "message": "…", "details?": … }, "meta": { "requestId" } }` —
  switch on `error.code` (stable), show `message`.
- **Pagination:** `?page=1&pageSize=20&sortOrder=desc` → `meta.pagination { page, pageSize, total, totalPages }`.
- **Auth flow:** `POST /auth/otp/request` → `POST /auth/otp/verify` (phone or email, sign-up included) or
  `POST /auth/login` (password). Access tokens live 15 min; rotate with `POST /auth/refresh` (each refresh token is
  single-use; replaying an old one revokes the session). Admin dashboard: send `platform: "ADMIN_WEB"` (password login, 1-day
  refresh TTL). Common codes: `TOKEN_EXPIRED` → refresh; `SESSION_REVOKED` / `REFRESH_TOKEN_REUSED` → sign in again;
  `ENTITLEMENT_REQUIRED` (HTTP 402) → show the paywall for `details.feature`.
- **Exams:** `POST /mock-exams/{id}/attempts` (start/resume) → `PUT /attempts/{id}/answers` (batch, offline sync) →
  `POST /attempts/{id}/submit` with an `Idempotency-Key` header → `GET /attempts/{id}/result` / `review`. Drive the countdown
  from `serverTime`/`expiresAt`, never from the device clock.
- **Payments:** `POST /payments` (with `Idempotency-Key`) → open `redirectUrl` in a Custom Tab / browser → on return call
  `POST /payments/{id}/verify`; access is granted only after server verification.
- **Push:** register FCM tokens with `POST /notifications/devices`.

Regenerate the contract after API changes (CI fails if it is stale):

```bash
npm run openapi:generate
```

Client generation examples: `openapi-generator-cli generate -i openapi/openapi.json -g kotlin -o android-client` and
`npx openapi-typescript openapi/openapi.json -o src/api/schema.ts` in the Next.js app.

---

## Operations

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for production configuration, scaling, backups, monitoring and the
security checklist. Environment variables are documented in [`.env.example`](.env.example).
