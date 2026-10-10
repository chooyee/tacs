# Paper Standards Check — working rules for Claude

## What this is
Web app for Solution Architects to check their Solution Lab paper against the standards of its
paper type (SaaS, Cloud, Infra…), with an AI checker that compares the paper PDF to policies/samples.
Admins (Entra ID) maintain paper types, standards and reference documents.

## Source of truth
- Requirements: `docs/` — start at `docs/README.md`. Decisions: `docs/13-decisions-and-open-questions.md`.
- UI/behaviour reference: `tacs-prototype.html` (open in a browser). Docs win if they disagree.
- `tacs-prototype.full-v1.html` is an old version — ignore it.
- The app code lives in this repo root (`src/`, `public/`, `db/`, `tests/` as in `docs/04-architecture.md` §4).

## Always check with the user before
- Deviating from `docs/`, or when a requirement is unclear or contradictory.
- Adding any npm dependency not listed in `docs/04-architecture.md` §1.
- Changing the data model, API shape, readiness rules or the meaning of AI prompts.
- Anything destructive (dropping tables, deleting files, force-push).
Record agreed changes in `docs/13` (new D-xx) and update the affected doc.

## Stack (fixed)
Node 22 · Express · EJS · vanilla JS (ES modules in `public/js`, no bundler) · Basecoat UI + Tailwind CLI ·
PostgreSQL via `pg` (plain SQL, no ORM) · AWS S3 (MinIO locally) · `@azure/msal-node` (Entra OIDC; roles
`architect`/`admin` stored in the app + local admins, D-26/D-27) · AI via official SDKs only (`@google/genai` local, Bedrock in UAT/prod) — **no LangChain or
other AI frameworks** · prompts as Markdown in `src/ai/prompts/` · `pino` · `zod` · `node:test` + `supertest`.

## Code rules
- Layers: route → middleware → controller (thin) → service (business rules) → model (SQL only). Views display only.
- External services only via factories: `getAiProvider()`, `getStorage()`.
- Errors: throw `AppError` subclasses (`src/utils/errors.js`); wrap external errors with `cause`;
  every async handler in `asyncHandler`; only `errorHandler` builds error responses. Never leak internals.
- Logging: `req.log` / child loggers, never `console.log`; never log secrets, file content, prompts, remarks or chat.
- Security: parameterised SQL; EJS `<%= %>` only; CSP-safe (no inline scripts); CSRF on writes;
  owner-only writes (403 `NOT_OWNER`), everyone with a role can read.
- Config only via `src/config` (zod-validated). Production must use `AI_PROVIDER=bedrock`.
- JSDoc on every exported function; write for junior developers (clear names, comments explain *why*).

## Definition of done (every task)
`npm run lint` and `npm test` pass · tests added for new rules/routes (no real AI calls — use the `fake` provider) ·
requirement IDs (e.g. FR-ANS-05) in test names and commit messages · docs updated if behaviour changed.

## Commands
`docker compose up -d` · `npm run db:migrate` · `npm run seed` · `npm run dev` · `npm test` · `npm run lint`
