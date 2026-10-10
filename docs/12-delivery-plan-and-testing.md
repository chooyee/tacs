# 12 · Delivery plan & testing

## 1. Milestones (proposal — sizes assume 2–3 developers)

| # | Milestone | Contents | Exit criteria |
|---|-----------|----------|---------------|
| **S** | **Spikes** (1 week) | **S-1** Gemini and Bedrock: send a real 20-page paper PDF + 3 reference PDFs, get schema-valid JSON; measure time and tokens; answer the questions in 07 · §6.2. **S-2** Entra dev app with App Roles, MSAL login end to end. **S-3** Basecoat + Tailwind CLI + pdf.js under the CSP. | Short written findings in `docs/spikes/`; decisions D-xx updated; open questions closed or escalated. |
| **M1** | Foundation (1–2 weeks) | Repo setup, config, logger, errors, asyncHandler, DB + migrations, sessions, Entra sign-in / out, local administrators + Users page (D-26…D-28), layout + top bar, health checks, Dockerfile (no CI yet, D-29). | A signed-in user sees an empty "My papers"; a disabled user sees the 403 page; an admin can promote a user; lint and tests green. |
| **M2** | Admin (2 weeks) | Paper types list / create / copy / delete; editor: sections, standards (add with Enter, edit, mandatory, move, delete + undo); references (S3 upload, preview, link, note); audit log; seed data. | FR-ADM-01…21 pass in UAT with real SaaS policies uploaded. |
| **M3** | Architect (2 weeks) | My papers; new paper dialog; paper page with sections, answers, remarks, autosave, section bar, filters, readiness panel, reference viewer. | FR-PAP, FR-ANS, FR-RDY, FR-REF pass (readiness "not checked" gap expected). |
| **M4** | AI check (3 weeks) | Upload + validation, checks table, worker, **Gemini (local) and Bedrock (UAT / prod) providers**, retention job, prompts, schema validation, results on the page, compare dialog with pdf.js, apply / keep / fill, chat report + quick actions. | FR-AI-01…18 and FR-RET pass; `ai:smoke` returns schema-valid results **on Bedrock** for the fixture papers, reviewed by the product owner. |
| **M5** | Hardening (1–2 weeks) | All papers tab + read-only view polish; free-text chat (FR-CHAT-04); rate limits; accessibility audit; performance test; security review; runbook; UAT. | No high / critical findings; UAT sign-off on Bedrock. |

## 2. Testing strategy

| Level | Tool | What | Where it runs |
|-------|------|------|---------------|
| Unit | `node:test` | `utils/` (readinessRules, promptLoader, pdfInfo, errors), services with fakes (`FakeAiProvider`, `memoryStorage`, stubbed models) | CI, every push |
| Integration | `node:test` + `supertest` + test Postgres (Docker service in CI) | Routes end to end: auth stub, validation, read for everyone / write for owner only (403), CSRF, uploads, admin role checks | CI, every push |
| Contract | `node:test` | Each AI provider maps SDK responses / errors correctly (SDK client mocked) | CI |
| AI smoke | `npm run ai:smoke` on fixture papers | Real provider, real PDFs | Manual: before release and after prompt / model changes |
| Accessibility | axe DevTools + keyboard-only pass | Every screen in 03 | Each milestone |
| Security | `npm audit`, OWASP ZAP baseline scan on dev | | CI (audit), each milestone (ZAP) |
| Performance | k6 or autocannon | NFR-PERF-01/02 with 50 virtual users | M5 |
| UAT | Scripted scenarios (below) | Business users | M2–M5 |

**Auth in tests:** integration tests use a test-only middleware
(`tests/helpers/fakeAuth.js`) that sets `req.session.user`. It is wired in
**only** when `NODE_ENV=test`; `app.js` throws at startup if it is wired in
any other environment.

### 2.1 Must-have automated tests (minimum list)

1. Every row of the **readiness** table (FR-RDY) and the **AI issue** table (FR-AI-08).
2. Section status / complete / to-fix rules (FR-ANS-10).
3. Answer save: clear on second click, remark required logic, 403 `NOT_OWNER` for others' papers, 400 for a standard of another type.
4. Upload rejections: non-PDF, wrong magic bytes, encrypted PDF, too large, too many pages, check already running (409).
5. Read-only access: non-owner can `GET` everything, gets 403 `NOT_OWNER` on every write; the page renders without inputs.
6. Retention: items older than 7 days are purged (PDF + S3 object, chat, soft-deleted papers / admin items); results and answers survive; preview shows "removed after 7 days".
7. Config guardrail: `NODE_ENV=production` with `AI_PROVIDER=gemini` fails to start.
8. Worker: claims one job once (two workers in parallel), marks a stuck job failed, saves results, handles an invalid AI response (repair once, then fail).
6. AI post-processing: unknown keys dropped, missing standards → `none`, page clamping, HTML stripped.
7. Admin: delete type in use → 409; restore after delete; reorder positions; copy type copies links and S3 objects.
8. Error handler: API JSON shape incl. `requestId`; HTML error page; 5xx hides the internal message.
9. Prompt loader: missing placeholder throws; snapshot of the rendered prompt.

### 2.2 UAT scenarios (excerpt)

| # | Scenario | Expected |
|---|----------|----------|
| U1 | Architect creates a SaaS paper, answers all 33, leaves a mandatory as No with a remark | "Not ready yet" with the "Mandatory standard not met" gap |
| U2 | Architect uploads their PDF | Progress steps tick; results appear on the standards; report in the chat |
| U3 | Answer Yes where the AI says "Does not comply" → Compare side by side | Paper page and reference page shown with highlights; Use AI answer sets No + remark |
| U4 | Admin adds a mandatory standard with a linked policy | Existing papers show it unanswered; readiness updates; the policy opens from the chip |
| U5 | User without a role signs in | 403 page with access instructions |
| U6 | Architect B opens architect A's paper from **All papers** | Read-only view with banner; cannot change anything |
| U8 | Paper uploaded 8 days ago | Verdicts still shown; page previews say the PDF was removed; Re-check hidden until a new upload |
| U7 | Run U2 in UAT | Check runs on Bedrock; provider shown on the check |

## 3. Definition of Done (each story)

- [ ] Acceptance criteria met and demoed against the prototype behaviour.
- [ ] Unit / integration tests added; CI green; coverage not lower.
- [ ] Logging and errors follow 09; no secrets or content in logs.
- [ ] Keyboard and screen-reader basics checked (03 · §5).
- [ ] JSDoc on new exported functions; docs updated if behaviour or API changed.
- [ ] Reviewed and approved by one other developer.
