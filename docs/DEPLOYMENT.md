# Production deployment

## Topology

```
            ┌──────────────┐        ┌──────────────────────┐
 Android ──►│              │        │ api  (N replicas)     │──┐
 Next.js ──►│ Load balancer│──────► │ WORKERS_ENABLED=false │  │
 Gateways ─►│ (TLS)        │        └──────────────────────┘  │   PostgreSQL 16 (+pgvector, pg_trgm)
            └──────────────┘        ┌──────────────────────┐  ├─► Redis 7 (noeviction, AOF)
                                    │ worker (1–M replicas) │──┘   S3-compatible object storage
                                    │ WORKERS_ENABLED=true  │
                                    └──────────────────────┘
```

The same image runs both roles. API replicas are stateless (sessions, rate limits and caches live in Redis/PostgreSQL)
and scale horizontally. Workers process BullMQ queues: `messaging`, `notifications`, `knowledge-indexing`,
`question-import`, `ai`, `learning`, `analytics`, `payments`, `attempts`, `maintenance`. Cron schedules (Asia/Dhaka) are
registered idempotently at boot by every instance with `SCHEDULERS_ENABLED=true`; BullMQ runs each tick once.

| Schedule | Job |
|---|---|
| every minute | sweep expired exam attempts (backup for delayed auto-submit jobs) |
| every 10 min | expire subscriptions and revoke entitlements |
| every 15 min | reconcile pending payments with the provider |
| 00:05 | generate daily study-plan tasks (missed-task recovery) |
| 00:30 | aggregate analytics for the previous day |
| 03:15 | cleanup (expired OTPs, used refresh tokens, old sessions, expired data exports) |
| 08:00 / 10:00 | revision reminders / subscription renewal reminders |

## Release procedure

1. Build and push the image (CI builds it on every push).
2. Run migrations once, before rolling the new version: `npx prisma migrate deploy` (as a release job / init container).
   Migrations are forward-only; write them to be backward compatible with the running version (expand → migrate → contract).
3. Roll API and worker replicas. On `SIGTERM` the process fails readiness (`/health/ready` → 503), waits
   `SHUTDOWN_DRAIN_MS` for the load balancer to stop routing, closes HTTP, lets workers finish active jobs, then disconnects.
   Give pods a termination grace period ≥ 30 s.
4. Probes: liveness `GET /api/v1/health/live`, readiness `GET /api/v1/health/ready`.

## Required production configuration

The process refuses to start in production if any of these are missing, shorter than 32 characters or still `dev-…`:
`JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `STORAGE_SIGNING_SECRET`, `WEBHOOK_SANDBOX_SECRET`. Wildcard CORS and the sandbox
payment provider are also rejected. Additionally set:

- `PUBLIC_BASE_URL` (public HTTPS origin; used for IPN URLs and signed links), `CORS_ORIGINS` (admin dashboard origin), `TRUST_PROXY=true`.
- `STORAGE_DRIVER=s3` and `S3_*` (private bucket; downloads use short-lived pre-signed URLs).
- `SMS_PROVIDER=http` + gateway credentials, `EMAIL_PROVIDER=smtp` + `SMTP_URL`, `PUSH_PROVIDER=fcm` + service-account fields.
- `PAYMENT_DEFAULT_PROVIDER=sslcommerz`, `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`, `SSLCOMMERZ_SANDBOX=false`,
  redirect URLs. Configure the IPN URL `https://<host>/api/v1/payments/webhooks/sslcommerz` in the merchant panel.
- Optional AI: `AI_PROVIDERS=anthropic,openai,local` with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Keep `local` last so the
  assistant degrades instead of failing. Keys are only read server-side and never returned to clients.
- Generate secrets with `openssl rand -base64 48`. Store them in the platform secret manager, not in images.

Never set `EXPOSE_DEV_OTP` in production (it is ignored when `NODE_ENV=production`).

## PostgreSQL

- Version 16+ with extensions `vector` and `pg_trgm` (created by the first migration; the role needs permission, or
  create them beforehand). Managed options: AWS RDS / Aurora, Google Cloud SQL, Azure Flexible Server, Supabase, Neon.
- Use a connection pooler (PgBouncer in transaction mode) when running many replicas; add `?pgbouncer=true&connection_limit=…`
  to `DATABASE_URL`. Budget roughly `replicas × connection_limit` ≤ server max connections.
- Timestamps are `timestamptz` (UTC). Student calendar days (study plans, quotas) use Asia/Dhaka.

### Backups and recovery

- Enable automated daily snapshots **and** point-in-time recovery (WAL archiving) with ≥ 14 days retention.
- Logical backups for portability, e.g. nightly
  `pg_dump --format=custom --no-owner "$DATABASE_URL" > quiz-$(date +%F).dump`, encrypted and copied to a different
  account/region. Keep 30 daily + 12 monthly copies.
- Test restores monthly into a staging database: `pg_restore --clean --no-owner -d "$STAGING_URL" quiz-YYYY-MM-DD.dump`,
  then run `npx prisma migrate status` and the smoke checks below.
- Object storage: enable bucket versioning and lifecycle rules; replicate to a second region for disaster recovery.
- Redis holds queues and short-lived caches. Use AOF persistence and `maxmemory-policy noeviction` (BullMQ requirement).
  Losing Redis loses queued jobs; schedulers re-register at boot and the attempt/payment sweepers reconcile state.

## Monitoring

- **Logs:** structured JSON (pino) with `requestId` (also returned as `meta.requestId` and accepted via `X-Request-Id`),
  user id, latency and status. Authorization headers, cookies, passwords, OTPs and refresh tokens are redacted.
  Ship stdout to your log platform.
- **Errors:** every 5xx is logged with stack and request context; set `ERROR_WEBHOOK_URL` for alerting, or replace
  `ErrorReporter` (`src/common/monitoring/error-reporter.ts`) with a Sentry/Datadog implementation.
- **Suggested alerts:** readiness failures; 5xx rate > 1 %; p95 latency of `/attempts/*/submit` > 1 s; BullMQ failed-job
  growth or waiting > 1 000 in `payments`, `messaging`, `attempts`; payments stuck in `PENDING` > 30 min;
  AI fallback rate (`ai_usage_records` with `status=FAILED`) and daily AI cost (`/admin/ai/usage`).
- **Audit:** administrative and security events are in `audit_logs` (`GET /admin/audit-logs`). Retain ≥ 1 year.

## Smoke checks after a deploy

```bash
curl -fsS https://<host>/api/v1/health/ready
```

```bash
curl -fsS https://<host>/api/v1/public/exam-categories
```

Then sign in to the admin dashboard and confirm the queue dashboards (or `GET /admin/analytics/overview`) respond.

## Security checklist

- TLS everywhere; HSTS via Helmet; the API only trusts `X-Forwarded-*` when `TRUST_PROXY=true`.
- Rate limiting is Redis-backed (global + stricter limits on auth). OTPs are HMAC-hashed with purpose binding, single-use,
  5 attempts, 5-minute expiry, resend cooldown and hourly caps per identifier and per IP. Password logins lock for 15
  minutes after 5 failures. Refresh tokens are stored as SHA-256 hashes and rotated with reuse detection.
- Admin dashboard sessions require password login and have a 1-day refresh lifetime; every admin mutation is audited.
- Uploads are restricted by purpose, MIME allow-list, magic-number sniffing and size; files are private by default.
- Payment webhooks are signature-verified and always confirmed server-to-server before access is granted.
- Run the container as the non-root `node` user (the image does this) with a read-only root filesystem where possible.
- Review `GET /admin/roles` regularly; only `SUPER_ADMIN` can grant `SUPER_ADMIN`; nobody can change their own roles.
- Data subject rights: users can export (`POST /me/data-export`) and delete (`DELETE /me`) their data. Payment records are
  retained (detached from personal identifiers) for financial compliance.

## Known limitations / extension points

- PDF knowledge sources are not text-extracted yet: upload text, Markdown or HTML (the parser registry in
  `src/modules/knowledge/chunking.ts` is where a PDF extractor would plug in).
- bKash/Nagad direct APIs are not implemented separately; they are available through SSLCommerz. Additional providers
  implement `PaymentProvider` (`src/modules/payments/providers/payment-provider.ts`) and register in `PaymentsService`.
- AI replies are delivered by polling `GET /ai/messages/{id}`; streaming (SSE) can be added on top of the same job.
