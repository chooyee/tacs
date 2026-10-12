# 13 · Decisions & open questions

## 1. Decisions made (with the product owner)

| ID | Decision | Date |
|----|----------|------|
| D-01 | Scope reduced to "architect validates own paper against standards". Sign-offs, committee decisions, printing, dashboards and standards versioning are **out**. | 2026-10-10 |
| D-02 | Admin module kept: multiple paper types, each with its own standards and references. | 2026-10-10 |
| D-03 | **Everyone** signs in with Entra ID (OIDC). Roles from App Roles: `Admin`, `Architect`. | 2026-10-10 |
| D-04 | Stack: Node.js + Express + EJS + vanilla JS; UI with **Basecoat UI + Tailwind** (shadcn look without React). MVC + services + factories + utilities. | 2026-10-10 |
| D-05 | Database: **PostgreSQL** with plain SQL (`pg`), no ORM. | 2026-10-10 |
| D-06 | Reference documents: **uploaded file** (used by the AI and the preview) **+ optional intranet link**. | 2026-10-10 |
| D-07 | AI reads **PDFs directly** (no server-side page images). The browser renders thumbnails with pdf.js. | 2026-10-10 |
| D-08 | AI checks run as **background jobs** in the app process (DB-backed queue, `SKIP LOCKED`); the browser polls. | 2026-10-10 |
| D-09 | File storage: **AWS S3 from day one** (MinIO for local development). | 2026-10-10 |
| D-10 | AI providers switchable by config. **No full AI framework** (no LangChain etc.); official SDKs are fine; prompts in Markdown. | 2026-10-10 |
| D-11 | "Mandatory gate" concept replaced by a **Mandatory** flag on each standard. | 2026-10-10 |
| D-12 | Admin changes apply **immediately** to all papers of that type (no publish step). | 2026-10-10 |
| D-13 | **Local development: Gemini with an API key. Production: AWS Bedrock** (config refuses anything else in production). UAT also uses Bedrock. | 2026-10-10 |
| D-14 | Official Google / AWS SDKs are allowed (answers A-01). | 2026-10-10 |
| D-15 | A **mandatory** standard may be answered **N/A** with a justification. | 2026-10-10 |
| D-16 | **Everyone** signed in can **view** every paper (read-only); only the owner edits. | 2026-10-10 |
| D-17 | The AI check is **optional** for "Ready for committee" (shown as a tip). If a check exists, unresolved gap-level AI issues still block. | 2026-10-10 |
| D-18 | **Retention 7 days** for uploaded PDFs, chat history and deleted items. | 2026-10-10 |
| D-19 | "Everyone can view" = every signed-in user **with a role** (Architect or Admin). Viewers also see AI results and chat history. (Confirms A-06.) | 2026-10-10 |
| D-20 | A check that **has** been run still blocks readiness on unresolved gap-level AI issues until the owner fixes the answer or clicks *Keep mine*. (Confirms A-07.) | 2026-10-10 |
| D-21 | **UAT** uses Bedrock like production; the shared **dev** environment uses Gemini with test papers only. (Confirms A-09.) | 2026-10-10 |
| D-22 | Bedrock model ID and region are deployment configuration (`BEDROCK_MODEL_ID`, `BEDROCK_REGION`), chosen by the platform team at deploy time — not a requirement for this document. (Closes Q-11.) | 2026-10-10 |
| D-23 | Retention clocks as in §2.1: PDFs 7 days after upload; chat 7 days after each message; deleted papers / admin items 7 days after deletion. Answers, remarks, AI verdicts **and findings** are kept while the paper exists. (Confirms A-08.) | 2026-10-10 |
| D-24 | **No formal AI accuracy benchmark** (golden set dropped). Quality is checked with `ai:smoke` on fixture papers and UAT feedback. (Closes Q-02.) | 2026-10-10 |
| D-25 | **No** "submitted / presented" status and **no** export of the self-check. (Closes Q-10.) | 2026-10-10 |
| D-26 | **Roles are stored in the app, not in Entra App Roles** (replaces the role part of D-03 / FR-ACC-02). Every Entra user becomes an **Architect** at first sign-in (`users.role`). Any Admin can promote a user to **Admin** (or back) on the **Users** admin page. Role changes take effect on the user's next request. An Entra user with role Admin can also prepare papers. Who may sign in at all stays controlled by Entra (*Assignment required*). | 2026-10-10 |
| D-27 | **Local administrator accounts** (break-glass, same idea as the CloakTail project): username + password stored in Postgres (`local_admins`, scrypt hash, lockout after 5 wrong passwords for 15 min, temporary passwords must be changed at first sign-in). The first one is created **on first start, like Keycloak / CloakTail**: while none exists the server log prints a one-time **setup token** and `/setup` (also the start page for visitors who are not signed in) creates the administrator; or, for unattended deploys, from `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` at startup. `npm run admin -- create|reset|list` for extra accounts and recovery. The setup token is the one secret deliberately written to the log (single use, invalid once an admin exists, new on every restart); with several instances use the bootstrap variables. A local admin signs in at `/auth/local`, has the **Admin** role only (admin areas, incl. Users), and cannot own papers. Needed so the first Entra user can be promoted. | 2026-10-10 |
| D-28 | Admins can set a user to **Disabled**. A disabled user sees the 403 "Access not granted" page (FR-ACC-03). An Admin cannot change their own role or status. | 2026-10-10 |
| D-29 | M1 scope adjustments: Entra **front-channel logout dropped** (the CSP `frame-ancestors 'none'` stays everywhere); new config `TRUST_PROXY` (behind the load balancer) and `COOKIE_SECURE` (default `true`, enforced in production; `false` for local http); `/health/ready` checks only the DB until the storage factory arrives in M2; M1 ships a **Dockerfile but no CI pipeline**; local development uses an installed PostgreSQL (`docker-compose.yml` kept for those who prefer Docker; MinIO added in M2). | 2026-10-10 |

## 2. Assumptions I made — please confirm or correct

| ID | Assumption | Impact if wrong |
|----|------------|-----------------|
| A-02 | People with the `Admin` role can also create papers. | Remove `Admin` from the architect routes. |
| A-03 | One paper has one owner; no co-authors. Others can only view (D-16). | Co-editing needs a `paper_members` table and UI. |
| A-04 | English only. | i18n would need the strings file per language. |
| A-05 | Hosting on AWS (ECS Fargate + RDS), because S3 and Bedrock are AWS. | See Q-05. |

### 2.1 Retention clocks (decision D-23)

| Data | Proposed clock | Why |
|------|----------------|-----|
| Uploaded paper PDFs | **7 days after upload.** Each new upload is a new file with its own 7 days. | Simple, predictable, and the PDF is the most sensitive data. Architects normally re-upload each new draft anyway. |
| Chat messages | **7 days after each message** (rolling). | Same rule for every message; no "conversation" boundary to define. |
| Deleted papers (with answers, results, chat) | **7 days after deletion.** | Gives a week to recover a paper deleted by mistake (via support). |
| Deleted admin items (types, sections, standards, references + files) | **7 days after deletion.** | Same recovery window; the *Undo* toast covers instant mistakes. |
| Answers + remarks | **Kept** while the paper exists. | They are the architect's own work, not uploaded content. |
| AI results (verdict, page, finding) | **Kept** while the paper exists. | If they expired with the PDF, an unresolved "your paper contradicts your Yes" would silently disappear after a week and the paper would become "ready" without any fix. |
| Admin audit log | **Kept** (no uploaded content). | Governance trail. |

AI *findings* (short text derived from the paper) are **kept** with the
verdicts. Fallback if InfoSec later objects: blank the `finding` text after 7
days and keep `verdict`, `page` and `area` — the readiness rules still work.

## 3. Open questions

None blocking. Items parked by the product owner (revisit only if they become
relevant — do not design for them now):

| ID | Topic | Status |
|----|-------|--------|
| Q-05 | Hosting target (AWS ECS + RDS is the working proposal in 10 · §5) | Parked — not now |
| Q-08 | Expected volume (architects, papers / month, PDF size) | Parked — use the defaults in 10 · §2 |
| Q-09 | AI budget cap / usage page | Parked — token counts are still stored per check |

Closed: Q-02 (no accuracy benchmark — D-24), Q-10 (no submitted status or
export — D-25).

## 4. Suggestions for later (not in v1 — raise them with me before adding)

1. **Paper templates**: a downloadable Word/PowerPoint skeleton per paper type,
   pre-structured by section — this prevents non-standard papers at the source.
2. **Committee feedback loop**: record which standards the committee still
   flagged, to tune prompts and standards.
3. **Admin analytics**: most-failed standards across papers (the earlier
   prototype had this) to target guidance and training.
