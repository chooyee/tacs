# 10 · Setup, configuration & deployment

## 1. Run it locally (day 1)

### 1.1 Prerequisites

- Node.js **22 LTS** (`node -v`)
- PostgreSQL 16+ installed locally, **or** Docker Desktop (`docker compose up -d`) (D-29)
- Git
- Access to the **dev** Entra app registration (ask the tech lead for the
  client ID and secret) and a Gemini API key for development

### 1.2 Steps

With a locally installed PostgreSQL, first create the role and databases once (as a superuser):
`CREATE ROLE psc LOGIN PASSWORD 'psc'; CREATE DATABASE psc OWNER psc; CREATE DATABASE psc_test OWNER psc;`

```bash
git clone <repo-url> paper-standards-check
cd paper-standards-check
npm install
cp .env.example .env          # then fill in the values marked TODO
docker compose up -d          # only if you use Docker for Postgres
npm run db:migrate            # creates the tables
npm run seed                  # loads SaaS / Cloud / Infra paper types + placeholder reference PDFs (D-31)
npm run dev                   # starts the app (node --watch) + Tailwind watch on http://localhost:3000
```

On the **first start** the log prints a setup token: open http://localhost:3000 (it
shows `/setup`), enter the token and create the local administrator (D-27). Then sign
in with your company account — you are an **Architect**. To become an Admin, sign in
as the local administrator at http://localhost:3000/auth/local and change your role on
**Users** (D-26).

### 1.3 `docker-compose.yml` (local only, optional)

Postgres only (D-29). Files go to a real AWS dev S3 bucket (D-30): set `AWS_REGION`, `S3_BUCKET`,
`S3_KEY_PREFIX` (e.g. `tacs/` when the bucket is shared) and the dev IAM user's
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env`. The keys need `s3:GetObject`,
`PutObject`, `DeleteObject` and `ListBucket` (for the `/health/ready` check) on that bucket.

### 1.4 npm scripts

| Script | Does |
|--------|------|
| `dev` | `node --watch src/server.js` + `tailwindcss --watch` (in parallel, `scripts/dev.js`) |
| `build` | Builds CSS (`tailwindcss -i src/styles/app.css -o public/css/app.css --minify`), copies `readinessRules.js` and the pdf.js files into `public/` |
| `start` | `node src/server.js` (production) |
| `db:migrate` | `node db/migrate.js` |
| `seed` | Seeds DB + S3 with the prototype's paper types and generated placeholder PDFs; skips existing types; refuses to run when `NODE_ENV=production` (D-31) |
| `test` | `node --test tests/` |
| `test:coverage` | `node --test --experimental-test-coverage tests/` |
| `lint` / `format` | ESLint / Prettier |
| `ai:smoke` | Live AI test: `npm run ai:smoke -- --paper=test.pdf [--type=SaaS] [--provider=gemini\|bedrock\|fake]` prints a verdict table; nothing is saved (07 · §10) |
| `retention:run` | Runs the retention job once, now (FR-RET-01); takes the same lock as the worker |

## 2. Configuration (environment variables)

All configuration is read **once** in `src/config/index.js` and validated with
zod. If something required is missing, the app **refuses to start** and logs
exactly which variable is wrong. No other file reads `process.env`.

| Variable | Required | Example / default | Purpose |
|----------|----------|-------------------|---------|
| `NODE_ENV` | yes | `development` / `production` | |
| `PORT` | no | `3000` | |
| `BASE_URL` | yes | `http://localhost:3000` | Builds absolute URLs (logout redirect) |
| `LOG_LEVEL` | no | `info` | `debug` locally if needed |
| `SESSION_SECRET` | yes | 64 random hex chars | Signs the session cookie |
| `DATABASE_URL` | yes | `postgres://psc:psc@localhost:5432/psc` | |
| `DB_POOL_MAX` | no | `10` | |
| `ENTRA_TENANT_ID` | yes | GUID | |
| `ENTRA_CLIENT_ID` | yes | GUID | |
| `ENTRA_CLIENT_SECRET` | yes* | — | *or `ENTRA_CERT_THUMBPRINT` (SHA-256, hex) + `ENTRA_CERT_PRIVATE_KEY_PATH` (PEM) in production |
| `ENTRA_REDIRECT_URI` | yes | `http://localhost:3000/auth/callback` | |
| `ACCESS_REQUEST_TEXT` | no | "Ask the Architecture Office to add you…" | Shown on the 403 page |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` | no | — | Creates the first local administrator at startup when none exists, instead of the `/setup` page (D-27) — for unattended deploys and several instances. Temporary: must be changed at first sign-in. Remove after use. |
| `COOKIE_SECURE` | no | `true` | Session cookie `Secure` flag. Must be `true` in production (enforced). Set `false` for local `http://localhost`: the session library only sends Secure cookies over HTTPS (D-29). |
| `TRUST_PROXY` | no | *(empty)* | Number of proxies in front of the app (e.g. `1` behind the ALB), so `req.ip` and HTTPS detection work (D-29). |
| `AWS_REGION` | yes (from M2) | `ap-southeast-1` | |
| `S3_BUCKET` | yes (from M2) | `psc-local` | |
| `S3_KEY_PREFIX` | no | *(empty)*, e.g. `tacs/` | Prefix for every object key, so a bucket can be shared (D-30) |
| `S3_ENDPOINT` | no | `http://localhost:9000` | Only for an S3-compatible server such as MinIO |
| `S3_FORCE_PATH_STYLE` | no | `false` | Only for MinIO-style servers |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | local only | dev IAM user keys | Local development against the dev bucket (D-30). In AWS, leave empty: the task / instance IAM role is used |
| `AI_PROVIDER` … `AI_MAX_RETRIES` | see 07 · §8 | | |
| `UPLOAD_MAX_PAPER_MB` | no | `20` | Per paper PDF |
| `UPLOAD_MAX_REFERENCE_MB` | no | `15` | |
| `UPLOAD_MAX_PAGES` | no | `100` | Total per check |
| `CHECK_WORKER_INTERVAL_MS` | no | `2000` | |
| `CHECK_WORKER_CONCURRENCY` | no | `2` | Per instance |
| `CHECK_TIMEOUT_MS` | no | `600000` | Stuck-job sweep |
| `RATE_LIMIT_CHECKS_PER_HOUR` | no | `10` | |
| `RETENTION_DAYS` | no | `7` | PDFs, chat and soft-deleted items (FR-RET) |
| `RETENTION_RUN_AT` | no | `02:00` | Daily retention job time (server time) |

## 3. Front-end build (no bundler)

- **Tailwind CSS v4 CLI** compiles `src/styles/app.css`, which imports
  Tailwind and Basecoat (`@import "tailwindcss"; @import "basecoat-css";`)
  and defines our status tokens, into `public/css/app.css`.
- Basecoat's small JavaScript (for dropdowns, toasts and tabs) and **pdf.js**
  (`pdfjs-dist/build/pdf.min.mjs` + worker) are copied into `public/vendor/`
  by `npm run build`. Pages load them with `<script type="module">`.
- Page scripts are native ES modules in `public/js/pages/*.js`, each loaded
  only by its page.
- Static files are served with `Cache-Control: no-cache` and an ETag: the browser keeps them but
  revalidates (304 when unchanged), because ES modules import each other without a version in the
  URL (D-35).

## 4. Environments

| Env | Purpose | Data | AI provider |
|-----|---------|------|-------------|
| local | Development | Seed data | Gemini dev key (or `FakeAiProvider` with `AI_PROVIDER=fake`) |
| dev | Integration, demos | Seed + test papers only | Gemini (API key) |
| uat | Business testing with real policies | Real references, test papers | **Bedrock** |
| prod | Live | Real | **Bedrock** (enforced by config, D-13) |

Each environment has its **own** Entra app registration (or at least its own
redirect URI), S3 bucket, database and secrets.

## 5. Deployment (proposal — confirm the target, see 13 · Q-05)

Because S3 and Bedrock are on AWS, the simplest fit is:

```mermaid
flowchart LR
  U[Users] --> ALB[AWS Application Load Balancer<br/>HTTPS, ACM certificate]
  ALB --> ECS[ECS Fargate service<br/>2 tasks · Node container]
  ECS --> RDS[(RDS PostgreSQL)]
  ECS --> S3[(S3 bucket, private)]
  ECS --> SM[Secrets Manager]
  ECS --> AI[Gemini API / Bedrock]
  ECS --> CW[CloudWatch Logs]
  U -. sign-in .-> ENTRA[Microsoft Entra ID]
```

- **Container**: `node:22-alpine`, multi-stage build (`npm ci`, `npm run
  build`, then `npm ci --omit=dev` into the final image). Runs as a non-root
  user. `HEALTHCHECK` calls `/health`.
- **Migrations** run as a one-off task (`npm run db:migrate`) **before** the new
  version starts. Migrations must be backward compatible (expand → migrate →
  contract) so a rollback doesn't need a DB restore.
- **Logs**: stdout JSON → CloudWatch. Create metric filters / alarms for
  `level=error` rate, `Check failed`, and 5xx from the ALB.
- **Backups**: RDS automated backups (7–35 days), S3 versioning.
- **CI/CD** (GitHub Actions or the company standard): lint → test → `npm
  audit` → build image → deploy to dev automatically → manual approval for uat
  / prod.

## 6. Operational runbook

Who reads this: whoever runs the app in dev, UAT or production. Logs are JSON on stdout (CloudWatch);
every request line has a `requestId`, which users also see as "ref xxxxxxxx" in error toasts.

### 6.1 Releasing a version

1. CI is green: `npm run lint`, `npm test`, `npm audit` (no high / critical in production dependencies).
2. Run the migrations as a one-off task: `npm run db:migrate`. They are additive (expand → migrate →
   contract), so the running version keeps working.
3. Deploy the new image; the load balancer waits for `GET /health/ready` (DB + S3) on each task.
4. After a prompt or model change: `npm run ai:smoke -- --paper=<test paper> --provider=bedrock` in UAT
   and have the product owner review the verdict table (07 · §10). Never edit a prompt version in place.
5. Rollback = deploy the previous image. No database restore is needed for additive migrations.

### 6.2 What to watch (alarms)

| Log message / signal | Meaning | Alarm |
|----------------------|---------|-------|
| `level=50` (error) rate | Unexpected errors | > 5 per 5 min |
| `Check failed` | An AI check failed; `code` says why (`AI_TIMEOUT`, `AI_RATE_LIMITED`, `AI_UNAVAILABLE`, `AI_BAD_REQUEST`, `AI_INVALID_RESPONSE`, `CHECK_TIMEOUT`, `FILE_MISSING`) | > 3 per 15 min |
| `Check timed out and was marked failed` | A check ran longer than `CHECK_TIMEOUT_MS` (an instance died or the AI hung) | any |
| `Could not claim a check` | The worker cannot reach the database | any |
| `Retention job finished` | Daily, with counts per category and `errors` | missing for > 26 h, or `errors` > 0 |
| `Retention: could not delete an item` | One PDF / paper / reference could not be deleted; retried tomorrow | 3 days in a row |
| ALB 5xx, `/health/ready` failing | DB or S3 unreachable | any |
| `AI batch done` (`ms`, `inputTokens`, `outputTokens`) | Cost and speed per AI request | dashboard only |

### 6.3 Common situations

| Situation | What to do |
|-----------|-----------|
| Users can't sign in | Check the Entra app (secret / certificate expiry, redirect URI) and the logs for `auth.callback` errors. Local admins can still sign in at `/auth/local`. |
| User says "no access" | An admin opens **Admin → Users** and gives them the Architect or Admin role (D-26); it applies on their next request. |
| Checks stay "running" | The worker fails a check after `CHECK_TIMEOUT_MS` (10 min) and tells the user in the chat. Look for `Check failed` and the AI provider's status page / quota. Users press **Try again**. |
| "A check is already running" | Only one active check per paper (FR-AI-05). It ends by itself (done, failed, or the timeout above). |
| Users hit "many checks / messages" (429) | Limits: `RATE_LIMIT_CHECKS_PER_HOUR` (10) per user; 20 chat messages or quick questions per user per 10 minutes. Raise the check limit in config if needed. |
| AI quality complaints | Collect the paper (test copy) and the check ID; run `ai:smoke` with it; change the prompt as a new version. The check stores provider, model and prompt version (FR-AI-16). |
| Switch AI provider | Non-production only: set `AI_PROVIDER` + credentials, restart. Production must stay on Bedrock (D-13, enforced at start-up). Existing results stay. |
| "My PDF disappeared" | Expected 7 days after upload (FR-RET). Results stay; the user uploads again to see pages and re-check. |
| Disk / memory pressure | Uploads are held in memory (≤ 3 × 20 MB per request), one upload per user at a time per instance. Scale out instead of raising limits. |
| Retention did not run | It runs once a day at `RETENTION_RUN_AT` on one instance. Run it by hand: `npm run retention:run` (safe any time). |
| Need to find one request | Ask the user for the "ref" from the error toast and search the logs for that `requestId`. Logs never contain remarks, chat text, prompts or file content (09 · §1.4). |

### 6.4 Performance (measured 2026-10-12, M5)

One instance, local Postgres, the test schema, a paper type with **100 standards** (NFR-PERF-01/02):

| Load | Paper page (100 standards) p95 | Answer save p95 | Home page p95 |
|------|------|------|------|
| 50 users, about 1 s between requests | **90 ms** | — | — |
| 50 users, no pause (stress) | 768 ms (76 pages/s) | **264 ms** | **286 ms** |

Targets are 500 ms (pages) and 300 ms (saves). Under stress one Node process is CPU-bound rendering
the page (about 270 KB of HTML for 100 standards). Production runs 2+ instances (NFR-REL-02).
