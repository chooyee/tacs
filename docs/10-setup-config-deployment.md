# 10 · Setup, configuration & deployment

## 1. Run it locally (day 1)

### 1.1 Prerequisites

- Node.js **22 LTS** (`node -v`)
- Docker Desktop (runs Postgres and MinIO for you)
- Git
- Access to the **dev** Entra app registration (ask the tech lead for the
  client ID and secret) and a Gemini API key for development

### 1.2 Steps

```bash
git clone <repo-url> paper-standards-check
cd paper-standards-check
npm install
cp .env.example .env          # then fill in the values marked TODO
docker compose up -d          # starts postgres:16 on 5432 and minio on 9000 (console 9001)
npm run db:migrate            # creates the tables
npm run seed                  # loads SaaS / Cloud / Infra paper types + placeholder reference files
npm run dev                   # starts the app with nodemon + Tailwind watch on http://localhost:3000
```

Then open http://localhost:3000, sign in with your company account, and make
sure your account is assigned the `Architect` and/or `Admin` app role in the
**dev** enterprise application.

### 1.3 `docker-compose.yml` (local only)

```yaml
services:
  db:
    image: postgres:16
    environment: { POSTGRES_USER: psc, POSTGRES_PASSWORD: psc, POSTGRES_DB: psc }
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
  minio:                       # S3-compatible storage for local development
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio12345 }
    ports: ["9000:9000", "9001:9001"]
    volumes: [s3data:/data]
volumes: { dbdata: {}, s3data: {} }
```

`npm run seed` also creates the bucket `psc-local` in MinIO.

### 1.4 npm scripts

| Script | Does |
|--------|------|
| `dev` | `nodemon src/server.js` + `tailwindcss --watch` (in parallel) |
| `build` | Builds CSS (`tailwindcss -i src/styles/app.css -o public/css/app.css --minify`), copies `readinessRules.js` and the pdf.js files into `public/` |
| `start` | `node src/server.js` (production) |
| `db:migrate` | `node db/migrate.js` |
| `seed` | Seeds DB + MinIO (refuses to run when `NODE_ENV=production`) |
| `test` | `node --test tests/` |
| `test:coverage` | `node --test --experimental-test-coverage tests/` |
| `lint` / `format` | ESLint / Prettier |
| `ai:smoke` | Live AI test with fixtures (07 · §10) |

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
| `ENTRA_CLIENT_SECRET` | yes* | — | *or `ENTRA_CERT_THUMBPRINT` + `ENTRA_CERT_PRIVATE_KEY_PATH` in production |
| `ENTRA_REDIRECT_URI` | yes | `http://localhost:3000/auth/callback` | |
| `ROLE_ADMIN` / `ROLE_ARCHITECT` | no | `Admin` / `Architect` | App role values |
| `ACCESS_REQUEST_TEXT` | no | "Ask the Architecture Office to add you…" | Shown on the 403 page |
| `AWS_REGION` | yes | `ap-southeast-1` | |
| `S3_BUCKET` | yes | `psc-local` | |
| `S3_ENDPOINT` | local only | `http://localhost:9000` | Points the SDK at MinIO |
| `S3_FORCE_PATH_STYLE` | local only | `true` | Needed for MinIO |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | local only | `minio` / `minio12345` | In AWS, use the task / instance IAM role instead |
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
- Static files are served with `express.static('public', { maxAge: '7d' })`
  and a version query string (`?v=<package version>`) for cache busting.

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

## 6. Operational runbook (starter)

| Situation | What to do |
|-----------|-----------|
| Users can't sign in | Check Entra app (secret / cert expiry, redirect URI), user assignment, logs for `auth.callback` errors. |
| User says "no access" | Assign them the `Architect` or `Admin` app role; they must sign out and in again. |
| Checks stay "running" | Look for `Check failed` / timeouts in logs; check the AI provider status page and quota; stuck jobs auto-fail after `CHECK_TIMEOUT_MS`. |
| AI quality complaints | Collect the paper + check ID; run `ai:smoke` with that paper; adjust the prompt (new version) — never edit an old one in place. |
| Switch AI provider | Non-production only: set `AI_PROVIDER` + credentials, redeploy. Production must stay on Bedrock (D-13). Existing results stay. |
| "My PDF disappeared" | Expected after 7 days (FR-RET). The user uploads it again. |
