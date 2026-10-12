# 06 · API specification

There are two kinds of routes:

1. **Pages** — return HTML (EJS). Used for navigation.
2. **JSON API** under `/api` — called with `fetch` from the page scripts.

## 1. Conventions for the JSON API

| Topic | Rule |
|-------|------|
| Auth | Session cookie (`psc.sid`, `HttpOnly`, `Secure`, `SameSite=Lax`). No tokens in the browser. |
| CSRF | Every `POST`, `PUT`, `PATCH` and `DELETE` sends header `X-CSRF-Token` (value from `<meta name="csrf-token">`). `public/js/lib/api.js` adds it automatically. |
| Body | JSON (`Content-Type: application/json`), except uploads (`multipart/form-data`). |
| Naming | camelCase in JSON. IDs are UUID strings. |
| Success | `200 { "data": … }`, `201 { "data": … }` for creates, `202 { "data": … }` for accepted background work, `204` with no body for deletes. |
| Errors | `{ "error": { "code": "VALIDATION_ERROR", "message": "Title is required", "details": [...], "requestId": "…" } }` — see 09 · §3. |
| Status codes | 400 validation · 401 not signed in · 403 wrong role · 404 not found / not yours · 409 conflict · 413 file too large · 415 wrong file type · 422 PDF unreadable · 429 rate limited · 500 unexpected · 502 AI / S3 failure. |
| Validation | Every body / param is validated with a **zod** schema in `src/validators/` via the `validate()` middleware **before** the controller runs. |

## 2. Pages (HTML)

| Method | Path | Role | Controller | View |
|--------|------|------|-----------|------|
| GET | `/` | any | redirect → `/papers` (local admins → `/admin/users`; from M2: `/admin/types` if the session's last mode was admin) | — |
| GET | `/auth/login` | public | `auth.login` (redirect to Entra) | — |
| GET | `/auth/callback` | public | `auth.callback` | — |
| POST | `/auth/logout` | signed in | `auth.logout` | — |
| GET, POST | `/setup` | public, only while no local admin exists (needs the setup token) | `setup.form`, `setup.create` (D-27) | `pages/setup` |
| GET | `/auth/logged-out` | public | `auth.loggedOut` | `pages/auth/loggedOut` |
| GET, POST | `/auth/local` | public | `auth.localForm`, `auth.localLogin` (D-27) | `pages/auth/local` |
| GET, POST | `/auth/local/password` | local admin who must change the password | `auth.passwordForm`, `auth.changePassword` | `pages/auth/password` |
| GET | `/admin/users` | Admin | `admin/user.index` (FR-ACC-09) | `pages/admin/users` |
| GET | `/papers` | Architect | `paper.index` (`?tab=all&q=&typeId=&page=` for All papers) | `pages/papers/index` |
| GET | `/papers/:paperId` | Architect (anyone; read-only unless owner) | `paper.show` | `pages/papers/show` |
| GET | `/admin/types` | Admin | `admin/paperType.index` | `pages/admin/types` |
| GET | `/admin/types/:typeId` | Admin | `admin/paperType.show` | `pages/admin/type` |
| GET | `/health`, `/health/ready` | public | health | JSON |

## 3. Architect API

### Papers

> **Who may call what:** every `GET` below is allowed for any signed-in
> user. Every `POST` / `PUT` / `PATCH` / `DELETE` on a paper (including
> answers, checks, results and chat) is allowed for the **owner only** —
> others get **403 `NOT_OWNER`**.

| Method | Path | Body | Response `data` |
|--------|------|------|-----------------|
| POST | `/api/papers` | `{ title, vendor?, paperTypeId }` | `{ id, url }` (201) |
| PATCH | `/api/papers/:paperId` | `{ title?, vendor? }` | `{ id, title, vendor }` |
| DELETE | `/api/papers/:paperId` | — | 204 |
| GET | `/api/papers/:paperId/readiness` | — | Readiness object (below) |

### Answers

| Method | Path | Body | Response `data` |
|--------|------|------|-----------------|
| PUT | `/api/papers/:paperId/answers/:standardId` | `{ value: "yes"\|"no"\|"na"\|null, remark: string }` | `{ answer, sectionStatus, readiness }` |

`PUT` is idempotent: sending the same body twice gives the same result. The
browser sends the **whole** answer (value + remark) every time.

**Readiness object** (also embedded in other responses):

```json
{
  "ready": false,
  "answered": 27, "total": 33,
  "mandatory": 20, "mandatoryMet": 17,
  "gaps": [
    { "code": "UNANSWERED", "text": "6 standards not answered", "standardId": "…" },
    { "code": "MANDATORY_NO", "text": "Mandatory standard not met: #4, #6, #23", "standardId": "…" },
    { "code": "REMARK_MISSING", "text": "Explain your “No” / “N/A” on #6", "standardId": "…" },
    { "code": "AI_CONFLICT", "text": "Your paper doesn’t support your answer on #13, #22", "standardId": "…" }
  ],
  "secondLookCount": 3,
  "aiTip": true
}
```

`aiTip` is `true` when the paper has no completed check with PDFs still
available (FR-RDY-05). It is never a gap.

### AI checks

| Method | Path | Body | Response `data` |
|--------|------|------|-----------------|
| POST | `/api/papers/:paperId/checks` | multipart `files[]` (1–3 PDFs) | `{ checkId, status:"queued" }` (202). 409 `CHECK_RUNNING` if one is active. |
| POST | `/api/papers/:paperId/checks/rerun` | — | Same as above, re-using the current documents. 409 if none. |
| GET | `/api/checks/:checkId` | — | `{ id, status, step, totalSteps:4, stepLabels:[…], errorMessage? }` — the polling endpoint (cheap, no joins). |
| GET | `/api/papers/:paperId/checks/latest` | — | `{ check:{id, finishedAt, provider, model, documents:[{id,fileName,pageCount}]}, counts:{comply,partial,gap,none}, results:[{standardId, verdict, page, documentId, area, bbox, finding, referenceId, referencePage, issue:{level,message}\|null, kept}] }`, or `null` if never checked. |
| POST | `/api/papers/:paperId/results/:standardId/apply` | — | `{ answer, readiness }` — FR-AI-09 |
| POST | `/api/papers/:paperId/results/:standardId/keep` | — | `{ readiness }` — FR-AI-10 |
| POST | `/api/papers/:paperId/results/apply-unanswered` | — | `{ filled: 5, readiness }` |

### Chat

| Method | Path | Body | Response `data` |
|--------|------|------|-----------------|
| GET | `/api/papers/:paperId/chat` | — | `{ messages:[{id, role, kind, content, createdAt}] }` |
| POST | `/api/papers/:paperId/chat` | `{ text }` (1–1000 chars) | `{ messages:[userMessage, assistantMessage] }` — assistant reply produced by intent rules or the AI (FR-CHAT-02…04) |
| POST | `/api/papers/:paperId/chat/quick` | `{ action: "gaps"\|"refs"\|"summary"\|"compare", standardId? }` | `{ messages:[…] }` — no AI call |

### Files (stream through the app — never public S3 links)

| Method | Path | Who | Notes |
|--------|------|-----|-------|
| GET | `/files/documents/:documentId` | Any signed-in user (until the PDF expires after 7 days → 404 `DOCUMENT_EXPIRED`) | `Content-Type: application/pdf`, `Content-Disposition: inline`, `Cache-Control: private, max-age=300`. |
| GET | `/files/references/:referenceId` | Any signed-in user | Same headers, with the reference's MIME type. |

## 4. Admin API (role `Admin`)

### Users (FR-ACC-09)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| PATCH | `/api/admin/users/:userId` | `{ role?: 'architect'\|'admin', status?: 'active'\|'disabled' }` | Returns the updated user. 409 `CANNOT_CHANGE_SELF` for your own account. |

### Paper types

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/admin/types` | `{ name, description?, copyFromTypeId? }` | 201 `{ id, url }`. 409 `NAME_TAKEN`. |
| PATCH | `/api/admin/types/:typeId` | `{ name?, description? }` | Autosave. |
| DELETE | `/api/admin/types/:typeId` | — | 409 `TYPE_IN_USE` if papers use it. |

### Sections

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/admin/types/:typeId/sections` | `{ title }` | Added at the end. |
| PATCH | `/api/admin/sections/:sectionId` | `{ title }` | |
| POST | `/api/admin/sections/:sectionId/move` | `{ direction: "up"\|"down" }` | Swaps `position` with the neighbour, in a transaction. |
| DELETE | `/api/admin/sections/:sectionId` | — | Soft delete, including its standards. |
| POST | `/api/admin/sections/:sectionId/restore` | — | Undo. |

### Standards

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/admin/sections/:sectionId/standards` | `{ text }` | Optional, no references, added at the end. |
| PATCH | `/api/admin/standards/:standardId` | `{ text?, isMandatory?, referenceIds? }` | `referenceIds` replaces the whole link set; every ID must belong to the same paper type. |
| POST | `/api/admin/standards/:standardId/move` | `{ direction }` | |
| DELETE | `/api/admin/standards/:standardId` | — | Soft delete. |
| POST | `/api/admin/standards/:standardId/restore` | — | Undo. |

### Reference documents

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/admin/types/:typeId/references` | multipart: `type, title, url?, note?, file` | File required. PDF / PNG / JPG ≤ 15 MB. |
| PATCH | `/api/admin/references/:referenceId` | multipart (all fields optional; a new `file` replaces the old one) | The old S3 object is deleted after the DB commit. |
| DELETE | `/api/admin/references/:referenceId` | — | Soft delete; links hidden. |
| POST | `/api/admin/references/:referenceId/restore` | — | Undo (links come back). |

Every admin write is logged as an `info` line with the user ID (NFR-SEC-13). There is no audit table (D-33).

## 5. Front-end API helper (example)

```js
// public/js/lib/api.js
import { showToast } from './toast.js';

const csrf = document.querySelector('meta[name="csrf-token"]').content;

/**
 * Call the JSON API. Returns `data` on success; shows a toast and throws on error.
 * @param {string} url
 * @param {{method?:string, body?:object|FormData}} [options]
 */
export async function api(url, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: {
      'X-CSRF-Token': csrf,
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) { window.dispatchEvent(new CustomEvent('session-expired')); throw new Error('401'); }
  if (!res.ok) {
    const err = json.error || { message: 'Something went wrong' };
    showToast(`${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}`, 'error');
    throw Object.assign(new Error(err.message), err);
  }
  return json.data;
}
```
