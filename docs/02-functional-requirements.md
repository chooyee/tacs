# 02 · Functional requirements

Each requirement has an ID, a priority (MUST / SHOULD / MAY) and **acceptance
criteria** written as *Given / When / Then*. Testers use the acceptance criteria
for UAT, and developers write an automated test for each one where practical.

Contents:
[Access](#1-access-fr-acc) ·
[My papers](#2-my-papers-fr-pap) ·
[Paper page](#3-paper-page--answering-standards-fr-ans) ·
[Readiness](#4-readiness-rules-fr-rdy) ·
[References](#5-references-for-architects-fr-ref) ·
[AI checker](#6-ai-paper-checker-fr-ai) ·
[Chat](#7-chat-questions-fr-chat) ·
[Retention](#8-data-retention-fr-ret) ·
[Admin](#9-admin--paper-types-fr-adm)

---

## 1. Access (FR-ACC)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-ACC-01 | MUST | Every page except `/auth/*` and `/health` requires sign-in with Microsoft Entra ID (OIDC) — or, for local administrators, the local sign-in (FR-ACC-10). Unauthenticated users are redirected to sign in, then returned to the page they asked for. |
| FR-ACC-02 | MUST | Roles are stored in the app (`users.role`, D-26): every Entra user is an **Architect** from their first sign-in; an Admin can make them an **Admin**. An Admin can also prepare papers. Role changes apply on the user's next request. |
| FR-ACC-03 | MUST | **Disabled** users (D-28) see a friendly **403 "Access not granted"** page explaining how to request access (text configurable). |
| FR-ACC-04 | MUST | `/admin/**` pages and `/api/admin/**` endpoints require the `Admin` role. |
| FR-ACC-05 | MUST | The top-bar **mode switch** (Solution Architect / Admin) is shown only to Entra users with the `Admin` role (local administrators only have Admin mode). The active mode follows the URL (`/admin…` = Admin mode). |
| FR-ACC-06 | MUST | On first sign-in, a `users` row is created from the token (object ID `oid`, name, email) with role `architect`. Later sign-ins update name, email and `last_login_at` (never the role). |
| FR-ACC-07 | MUST | **Sign out** ends the app session and redirects to Entra's logout endpoint (local administrators go to the signed-out page). |
| FR-ACC-09 | MUST | **Users** admin page (`/admin/users`): lists every user who has signed in (name, email, role, status, last sign-in). An Admin can change another user's role (Architect / Admin) and status (Active / Disabled); not their own. Every change is logged (`info` line with both user IDs; no audit table, D-33). |
| FR-ACC-10 | MUST | **Local administrators** (D-27) sign in at `/auth/local` with username + password. Wrong passwords: 5 attempts, then the account is locked for 15 minutes. A temporary password must be changed at first sign-in (min. 12 characters, not the username). **First start:** while no local administrator exists, `/` and `/auth/local` lead to `/setup`, which creates the first one after the user enters the setup token printed in the server log (D-27). |
| FR-ACC-08 | MUST | **Every signed-in user** (role `Architect` or `Admin`) can **view** every non-deleted paper, read-only. Only the **owner** can change it (title, answers, uploads, AI actions, chat, delete). A change attempted by a non-owner returns **403** and is logged at `warn`. |

**Acceptance (FR-ACC-08):** *Given* user A owns paper P, *when* user B opens
`/papers/P`, *then* B sees the paper read-only (FR-PAP-08); *when* B calls
`PUT /api/papers/P/answers/…`, *then* B gets 403 and the event is logged at
`warn` with both user IDs.

---

## 2. My papers (FR-PAP)

Prototype: *My papers* screen (home).

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-PAP-01 | MUST | The home page has two tabs: **My papers** (default) and **All papers**. *My papers* shows the signed-in user's papers as cards, newest change first. Each card shows: title, vendor, paper type, readiness pill, progress bar, "x/y answered", "x/y mandatory met", and "✦ AI checked" or "Not AI-checked". |
| FR-PAP-02 | MUST | **New paper** opens a dialog: *Paper title* (required, 3–150 characters) and *Paper type* (required; radio cards showing name, description, number of standards and mandatory standards). **Create paper** opens the new paper page. |
| FR-PAP-03 | MUST | The paper title and vendor are edited inline in the paper header and **saved automatically** (debounce 600 ms). Title must not be empty — revert and show an error if cleared. |
| FR-PAP-04 | MUST | **Delete** asks for confirmation, then soft-deletes the paper (`deleted_at`). Deleted papers disappear from the list. The retention job purges it permanently **7 days** later (FR-RET-01). |
| FR-PAP-05 | MUST | The paper type of a paper **cannot be changed** after creation. |
| FR-PAP-06 | SHOULD | Empty state when there are no papers: short explanation + **New paper** button. |
| FR-PAP-07 | MUST | **All papers** tab: every non-deleted paper as the same cards **plus the owner's name**. Search box (title, vendor, owner) and a paper-type filter. Sorted by last change. Paginated, 24 per page. |
| FR-PAP-08 | MUST | **Read-only view** for non-owners: banner "You're viewing <owner>'s paper — read-only."; title / vendor not editable; Yes / No / N/A and remarks disabled (shown as text); no Delete; AI results, compare dialog and references still work; AI checker panel shows the history but no upload, no chat input and no Apply / Keep / Fill buttons. |

**Readiness pill rules (FR-PAP-01):**

| State | Pill |
|-------|------|
| Ready (FR-RDY-01 passes) | green "✓ Ready for committee" |
| Nothing answered and never AI-checked | grey "Not started" |
| Otherwise | red "N thing(s) to fix" (N = number of readiness gaps) |

---

## 3. Paper page — answering standards (FR-ANS)

Prototype: open *Enterprise PPM SaaS*.

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-ANS-01 | MUST | Show all standards of the paper type on **one long page**, grouped in collapsible **section cards** (letter A, B, C…, title, "n standards · m mandatory", completion pill, "k to fix" pill). |
| FR-ANS-02 | MUST | Standards are numbered **1…N in display order** across the whole paper type. |
| FR-ANS-03 | MUST | Each standard shows: number, text, **MANDATORY** tag if mandatory, reference chips (FR-REF-01), Yes / No / N/A buttons, remark box, and the AI result line if a check exists (FR-AI-07). |
| FR-ANS-04 | MUST | Clicking Yes / No / N/A saves immediately. Clicking the **selected** button again clears the answer. |
| FR-ANS-05 | MUST | The remark is **required** when the answer is No or N/A. While it is missing, the row is highlighted red with a message: No → "Explain the gap so the committee knows the plan." N/A → "Say why it doesn't apply." Selecting No or N/A moves keyboard focus to the remark box. |
| FR-ANS-06 | MUST | Remark placeholders: No → "Required: what's missing, who will fix it, and by when". N/A → "Required: why this doesn't apply to your solution". Yes / none → "Where in your paper? e.g. 'Section 4.2, figure 3' (optional)". |
| FR-ANS-07 | MUST | Remarks save automatically (debounce 600 ms, and also on blur). Max 2,000 characters. Show a subtle "Saved" / "Saving…" / "Not saved – retry" status. |
| FR-ANS-08 | MUST | A **sticky section bar** under the top bar shows one chip per section: letter, short title, and either "answered/total" or ✓ when the section is complete. The chip turns **red** when the section has something to fix (see FR-ANS-10). Clicking a chip scrolls to the section and expands it if collapsed. |
| FR-ANS-09 | MUST | **Filter** buttons in the section bar, each with a live count: **All**, **To do** (unanswered), **Needs attention** (answer is No, or remark missing, or has an AI issue), **Mandatory**. |
| FR-ANS-10 | MUST | A section "has something to fix" if any standard in it: is mandatory and answered No; needs a remark; or has an AI issue of level *gap*. A section is **complete** when every standard is answered and nothing needs fixing. |
| FR-ANS-11 | MUST | While a filter is active, a standard the user just changed **stays visible** until the filter changes (otherwise rows jump away while typing). |
| FR-ANS-12 | MUST | If a filter leaves a section empty, show "✓ Nothing to show here for this filter" with a **Show all** button. |
| FR-ANS-13 | MUST | A legend above the sections explains Yes / No / N/A / MANDATORY and the reference icons. |
| FR-ANS-14 | SHOULD | Collapsing a section is remembered for this browser tab only (not saved to the server). |
| FR-ANS-15 | MUST | If an admin deletes a standard, its answers are hidden from the paper (kept in the database for audit). If an admin adds a standard, it appears unanswered. |

**Acceptance (FR-ANS-05):** *Given* standard #6 is unanswered, *when* the user
clicks **No**, *then* the row turns red, focus moves to the remark, the readiness
panel lists "Explain your 'No' / 'N/A' on #6", and after the user types a remark
the red highlight and the gap disappear without a page reload.

---

## 4. Readiness rules (FR-RDY)

Prototype: right-hand **Ready for committee / Not ready yet** card.

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-RDY-01 | MUST | A paper is **Ready for committee** when **all four** checks below pass. Otherwise it is **Not ready yet**, and each failing check is listed as a **gap** in this order. |
| FR-RDY-02 | MUST | Each gap is a button. Clicking it scrolls to and flashes the first affected standard. |
| FR-RDY-03 | MUST | Readiness is calculated **on the server** (`readinessService`) and returned by the API, so the home page, paper page and chat always agree. The browser may recalculate for instant feedback using the same rules (shared module, see 04 · §6). |
| FR-RDY-04 | MUST | The paper page also shows **Progress** (bar, "x/y answered", "x/y mandatory met"). "Mandatory met" counts mandatory standards answered Yes or N/A. |
| FR-RDY-05 | MUST | The AI check is **optional**. If the paper has never been checked (or its PDFs expired), the readiness card shows a non-blocking tip: "Tip: check your paper PDF with the AI checker before you present." with a button that opens the checker. It never counts as a gap. |

**The four readiness checks (in display order):**

| # | Check fails when… | Gap text (example) | Click goes to |
|---|-------------------|--------------------|---------------|
| 1 | any standard is unanswered | "6 standards not answered" | first unanswered |
| 2 | any **mandatory** standard is answered **No** | "Mandatory standard not met: #4, #6, #23" | first one |
| 3 | any No / N/A has an empty remark | "Explain your 'No' / 'N/A' on #6" | first one |
| 4 | any AI issue of level **gap** is unresolved | "Your paper doesn't support your answer on #13, #22" | first one |

> **N/A on a mandatory standard is allowed**, because a justification is
> required (decision D-15). Check 4 only applies if the paper has a completed
> AI check.

---

## 5. References for architects (FR-REF)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-REF-01 | MUST | Each standard shows its linked references as chips: icon (📜 Policy, 📘 Sample, 🧩 Template, 🧭 Guide), type and title. Hover / focus shows the reference's "what to look for" note. |
| FR-REF-02 | MUST | Clicking a chip opens the **reference viewer dialog**: a preview of the uploaded file (PDF rendered with pdf.js, or the image), the type, the note, the list of standards it applies to, and — if the admin set an intranet link — an **Open official document ↗** button (new tab, `rel="noopener"`). |
| FR-REF-03 | MUST | The paper page side panel lists **all references** of the paper type. |
| FR-REF-04 | MUST | Reference files are served through the app (`/files/references/:id`) to any signed-in user. They are never public S3 URLs. |

---

## 6. AI paper checker (FR-AI)

Prototype: on a paper, click **✦ AI paper checker** (bottom right) → *Try with a
sample paper PDF*. The real build replaces the sample button with real uploads.

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-AI-01 | MUST | A floating **✦ AI paper checker** button on the paper page opens a docked chat panel (right side; full screen on mobile). The button shows a badge: "Not checked", "N to fix" (AI gap issues) or ✓. |
| FR-AI-02 | MUST | The user uploads **1–3 PDF files** (📎 button or drag and drop on the panel). Limits: ≤ 20 MB per file, ≤ 100 pages in total. Non-PDF files are rejected with a chat message naming the skipped files. Encrypted or corrupt PDFs are rejected with a clear message. |
| FR-AI-03 | MUST | Upload starts a **check** that runs in the background (see 04 · §7). The chat shows a progress message with 4 steps that tick as the job advances: "Reading your PDF (N pages)", "Reading text, diagrams and tables", "Comparing with N policies & samples", "Checking N standards". |
| FR-AI-04 | MUST | The user may leave the page while a check runs. On return, the panel shows the current progress or the result. |
| FR-AI-05 | MUST | Only one check per paper may run at a time. Uploading during a running check shows "A check is already running". |
| FR-AI-06 | MUST | The AI returns **one result per standard**: verdict (`comply` · `partial` · `gap` · `none`), page number in the paper, area (`text` · `diagram` · `table`), a plain-English finding (≤ 300 characters), the reference it compared against (if any) and that reference's page. |
| FR-AI-07 | MUST | Each standard on the paper page shows an **AI line**: coloured verdict, "page N — finding", any AI issue message, and buttons **Compare side by side**, **Use AI answer (Yes/No)** (hidden when the answer already matches) and **Keep mine** (only when there is an issue). |
| FR-AI-08 | MUST | **AI issue rules** (exact): see table below. |
| FR-AI-09 | MUST | **Use AI answer** sets the answer to the AI's suggestion (`comply`/`partial` → Yes, `gap`/`none` → No) and fills the remark: for `comply` only the citation "[Paper p.N vs <reference title>]", otherwise "<finding> [Paper p.N vs <reference title>]". The user can edit it afterwards. |
| FR-AI-10 | MUST | **Keep mine** marks the issue as resolved for this check. It is cleared when a new check runs. |
| FR-AI-11 | MUST | **Compare side by side** dialog: verdict + finding, the paper page (rendered from the uploaded PDF with pdf.js) and the reference page (rendered from the reference file), each with a highlight over the area the AI used. Buttons: Open reference, Go to standard, Use AI answer. |
| FR-AI-12 | MUST | When a check finishes, the chat posts a **report**: counts per verdict, then up to 4 "answers to look at" (gap issues first) as compare cards with mini page previews, and **Show all N**. If some standards are unanswered, offer **Fill my unanswered standards from this check** (applies FR-AI-09 to unanswered standards only). |
| FR-AI-13 | MUST | **Re-check** re-runs the AI on the same uploaded files (e.g. after an admin changed standards). A new upload replaces the paper's current documents. Older checks are kept for history, but only the **latest completed** check drives the UI and readiness. |
| FR-AI-14 | MUST | If the check fails (AI error, timeout, invalid response after retry), the chat shows "The check couldn't finish: <friendly reason>. Try again." with a **Try again** button. The technical error is logged with the request ID, never shown to the user. |
| FR-AI-15 | SHOULD | A standard added after the last check shows no AI line, and the AI checker shows "Standards changed since your last check — Re-check". |
| FR-AI-16 | MUST | The provider (Gemini or Bedrock) and model used are stored on each check for traceability. |
| FR-AI-17 | MUST | **Retention:** uploaded paper PDFs are deleted **7 days after upload** (FR-RET-01). Check results stay, so the AI lines and verdicts remain visible, but page previews are replaced by "The PDF was removed after 7 days — upload it again to see pages." and **Re-check** is hidden until a new upload. |
| FR-AI-18 | MUST | Only the paper's **owner** can upload, re-check, chat, Use AI answer, Keep mine and Fill. Viewers see results and history only (FR-PAP-08). |

**AI issue rules (FR-AI-08):**

| Architect answer | AI verdict | Issue level | Message |
|------------------|------------|-------------|---------|
| Yes | gap | **gap** | "Your paper doesn't back up your 'Yes'." |
| Yes | none, standard **mandatory** | **gap** | "You answered 'Yes', but the AI couldn't find it in your paper." |
| Yes | none, not mandatory | check | same message |
| Yes | partial | check | "Only partly shown in your paper." |
| No | comply | check | "The AI thinks your paper already covers this." |
| any other combination, or *Keep mine* | — | none | — |

*gap*-level issues block readiness (check 4). *check*-level issues are shown
as "N answer(s) worth a second look" but do not block.

---

## 7. Chat questions (FR-CHAT)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-CHAT-01 | MUST | Chat history is stored per paper and reloaded when the panel opens. Messages older than **7 days** are deleted (FR-RET-01); show "Older messages are removed after 7 days." at the top of the history. |
| FR-CHAT-02 | MUST | **Quick-action chips** answer from the database, without calling the AI: before any upload → "Which policies apply to my paper?"; after a check → "What do I need to fix?" (readiness gaps), "Compare #N" (compare card for the first gap), "Which policies apply to my paper?", "Summarise my paper". |
| FR-CHAT-03 | MUST | Typed text containing a standard number (`#4`, `standard 4`, or just `4`) returns that standard's compare card (no AI call). Invalid numbers get "There's no standard #N — this paper type has M." |
| FR-CHAT-04 | SHOULD | Any other typed question is sent to the AI provider with this context: paper type, standards, current answers and latest check results. The PDF is **not** re-sent. Answer ≤ 150 words, plain text (no HTML). If no check exists yet, reply "Upload your paper PDF first…". |
| FR-CHAT-05 | MUST | Chat input: Enter sends, Shift+Enter adds a new line, max 1,000 characters. Rate limit 20 messages per user per 10 minutes (NFR-SEC-08). |
| FR-CHAT-06 | MUST | All chat content is rendered as **text** (escaped). Never inject AI output as HTML. |

---

## 8. Data retention (FR-RET)

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-RET-01 | MUST | A daily **retention job** (run by the worker at 02:00 server time, and safe to run more often) permanently deletes anything **older than 7 days** (`RETENTION_DAYS=7`): **(a)** uploaded paper PDFs — the S3 object and the `paper_documents` row, counted from upload; **(b)** chat messages, counted from creation; **(c)** soft-deleted papers (with their answers, checks, results, documents and chat) and soft-deleted admin items (paper types, sections, standards, references with their S3 files), counted from `deleted_at`. |
| FR-RET-02 | MUST | The job logs one `info` line per run with counts per category, and `error` (without stopping) for any item it could not delete — it retries the next day. |
| FR-RET-03 | MUST | Answers, remarks, check results (verdict, page, area **and finding text**) are **not** removed by the retention job; they live as long as the paper (decision D-23). Keeping the results ensures an unresolved AI issue cannot disappear just because the PDF expired. |
| FR-RET-04 | SHOULD | The upload area and the AI checker tell users: "Uploaded PDFs and chat are kept for 7 days." |

---

## 9. Admin — paper types (FR-ADM)

Prototype: switch to **Admin**.

### 8.1 Paper types list

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-ADM-01 | MUST | Show all paper types as cards: name, number of papers using it, description, number of standards, mandatory standards and references. Plus a **New paper type** card. |
| FR-ADM-02 | MUST | **New paper type** dialog: Name (required, unique, ≤ 80 chars), "When does it apply?" (≤ 300 chars), Start from: *Blank* or *Copy of <existing type>*. Blank creates one section "General" and opens the editor with the **add standard** box focused. Copy duplicates sections, standards, mandatory flags, references (files are copied in S3) and links. |
| FR-ADM-03 | MUST | **Delete paper type** is disabled (with tooltip) while any non-deleted paper uses it. Otherwise confirm, then soft-delete. |

### 8.2 Paper type editor

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-ADM-10 | MUST | Name and description are edited inline and saved automatically. A banner says: "Changes save automatically and apply straight away to every <name> paper (N in progress)." |
| FR-ADM-11 | MUST | **Reference library** (D-37): Admin → References lists every reference (icon, title, type, guidance summary, "N standards in M paper types", last edited) with search and a type filter; Add, Edit (full-screen page), Delete with Undo. The paper type editor shows "References used here". |
| FR-ADM-12 | MUST | **Add / Edit reference** (full-screen page, D-37): Type (Policy, Sample, Template, Guide), Title (required), **File** (required on create; PDF, PNG or JPG, ≤ 15 MB — used for preview and by the AI), Intranet link (optional, `https://`), **Guidance** (rich text: "what should the architect look for?"; its plain text is shown on hover and sent to the AI). "Used by" lists the linked standards per paper type. |
| FR-ADM-13 | MUST | Deleting a reference removes its links from all standards. Show a toast with **Undo** (6 seconds) — implemented as soft delete + restore endpoint. |
| FR-ADM-14 | MUST | **Standards card**: sections in order, each with an inline-editable title, standard count, move up / move down, and delete. **Add section** creates "New section", selects its title for editing and opens its add-standard box. |
| FR-ADM-15 | MUST | Each standard row shows: number, text, a toggle tag **optional ↔ MANDATORY** (click to switch), linked reference chips, and actions (on hover / focus): edit, move up, move down, delete. |
| FR-ADM-16 | MUST | **Add standard** opens the full-screen standard form (D-38) for the chosen section. |
| FR-ADM-17 | MUST | **Standard form** (full screen, D-38): section, **title** (required, ≤ 500), **description** (basic rich text), Mandatory, and references chosen with a **search box** over the library (title, type, guidance) with the selection shown as removable chips; **New reference** opens the References module in a new tab; the reference saved there is ticked on the form. Linked standards are read-only except their section, with **Open the source** and **Duplicate here**. |
| FR-ADM-22 | MUST | **Import** (D-38): from the paper type editor, pick another paper type, tick whole sections or single standards, and import them as live links — into sections with the same names or into one chosen section. Already-linked standards are skipped with a warning. |
| FR-ADM-23 | MUST | **Last edited** (D-37): paper types, sections, standards and references show "Last edited <relative time> by <name>". |
| FR-ADM-24 | MUST | Sections are **collapsible** (state remembered per browser) with Collapse all / Expand all; sections and standards can be **dragged** by a grip (standards also into another section); ↑ ↓ buttons next to the number do the same from the keyboard. |
| FR-ADM-18 | MUST | Deleting a section or a standard shows a toast with **Undo** (soft delete + restore). Deleting a section deletes its standards. |
| FR-ADM-19 | MUST | Moving changes `position`. Move up is disabled for the first item and move down for the last. |
| FR-ADM-20 | — | *Dropped (D-33): no admin audit log or change history. Admin changes are logged as `info` lines (NFR-SEC-13).* |
| FR-ADM-21 | SHOULD | Warn (non-blocking) when a standard links more than **4** references, because AI providers limit the number of documents per request (see 07 · §5). |

**Acceptance (FR-ADM-16):** *Given* the admin opened **Add standard** in
section A, *when* they type "Service accounts inventoried", press Enter, type
"Guest access reviewed quarterly", press Enter, then press Esc, *then* section A
has two new optional standards at the end, numbering after them shifts by two,
and an architect opening a paper of this type sees both as unanswered.
