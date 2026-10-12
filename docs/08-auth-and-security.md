# 08 · Authentication & security

## 1. Sign-in with Microsoft Entra ID (OIDC)

### 1.1 Entra app registration (done once per environment by the Entra admin)

| Setting | Value |
|---------|-------|
| Platform | Web |
| Redirect URI | `https://<host>/auth/callback` (dev: `http://localhost:3000/auth/callback`) |
| Front-channel logout URL | *(none — dropped, D-29)* |
| Client credential | Client secret (dev / test) or **certificate** (production, preferred) |
| ID token claims | `oid`, `name`, `preferred_username`, `email` |
| App roles | **Not used** (D-26). Roles are managed in the app on the Users page. |
| Assignment | *Enterprise application → Users and groups*: assign the AD groups allowed to use the app. Turn on **Assignment required**, so only assigned people can sign in. |
| API permissions | `openid`, `profile`, `email` (delegated). No Graph calls needed. |

> Roles live in the app database (D-26): everyone who signs in is an
> **Architect**; an Admin promotes people on `/admin/users`. The very first
> Admin is a **local administrator** (D-27, §1.4).

### 1.2 Flow (authorization code + PKCE, using `@azure/msal-node`)

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as App (/auth)
  participant E as Entra ID
  B->>A: GET /papers (no session)
  A-->>B: 302 /auth/login?returnTo=/papers
  B->>A: GET /auth/login
  A->>A: create PKCE verifier + state + nonce, store in session
  A-->>B: 302 to Entra authorize URL
  B->>E: sign in (SSO / MFA by Entra policy)
  E-->>B: 302 /auth/callback?code&state
  B->>A: GET /auth/callback
  A->>A: check state
  A->>E: acquireTokenByCode(code, verifier)
  E-->>A: ID token (validated by MSAL: signature, issuer, audience, nonce, expiry)
  A->>A: check nonce; upsert users row (new users: role architect); session.user = {kind:'entra', id}
  A->>A: regenerate session ID (prevents session fixation)
  A-->>B: 302 returnTo (only relative paths allowed)
```

Rules:

1. **Validate `returnTo`**: accept only paths that start with `/` and not `//`
   (prevents open redirects).
2. Keep only what we need in the session: `{ kind, id }` (plus
   `passwordChangedAt` for local admins). **Do not** store access or refresh
   tokens — we don't call other APIs.
3. Session lifetime: 8 hours absolute, 60 minutes idle (rolling). After
   expiry, page requests redirect to sign-in and API requests return 401 (the
   front end shows "Sign in again").
4. `requireAuth` re-reads the user (name, email, role, status) from the
   database on **every request** and builds `req.user`, so role changes and
   *Disabled* apply immediately (D-26, D-28).
5. Logout (`POST /auth/logout`): destroy the session, clear the cookie, redirect to
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/logout?post_logout_redirect_uri=<host>/auth/logged-out`.
   `/auth/logged-out` is a plain "You're signed out" page.

### 1.4 Local administrators (D-27)

- Table `local_admins` (05 · §3.1a). Passwords hashed with **scrypt** and a
  random salt (`src/utils/password.js`), compared in constant time.
- **First start** (like Keycloak / CloakTail, `src/services/setup.service.js`): while no local admin
  exists, the server prints a one-time **setup token** in its log and `/setup` asks for it plus a
  username and password. `/` and `/auth/local` redirect there for visitors who are not signed in;
  Entra sign-in keeps working. Creation runs under a Postgres advisory lock, so two simultaneous
  submissions create one admin. The token lives in memory only (new token on restart, forgotten once
  an admin exists) — it is the one secret deliberately logged, because reading the log is the proof.
- Unattended deploys / several instances: `ADMIN_BOOTSTRAP_USERNAME` + `ADMIN_BOOTSTRAP_PASSWORD`
  create the first account at startup (temporary password, must be changed at first sign-in).
- `npm run admin -- create <username>` (extra account, temporary password printed on the terminal,
  never logged), `reset <username>` and `list` for recovery.
- Sign-in at `/auth/local` (form with CSRF token). 5 wrong passwords lock the
  account for 15 minutes; unknown usernames take the same time as known ones.
  Success regenerates the session ID.
- A session stores `passwordChangedAt`; a password reset therefore signs out
  all existing sessions of that account.
- Local admins have only the **Admin** role: admin areas, no papers.

`req.user` shape (built by `requireAuth`):

| Field | Entra user | Local admin |
|-------|-----------|-------------|
| `kind` | `'entra'` | `'local'` |
| `id` | `users.id` | `local_admins.id` |
| `name`, `email` | from `users` | username, `null` |
| `roles` | `['Architect']` or `['Architect','Admin']` | `['Admin']` |

### 1.3 Middleware

```js
// src/middleware/requireAuth.js
const { UnauthorizedError } = require('../utils/errors');

/** Ensure the user is signed in. Pages redirect; APIs get 401. */
function requireAuth(req, res, next) {
  if (req.session?.user) { req.user = req.session.user; return next(); }
  if (req.originalUrl.startsWith('/api/')) return next(new UnauthorizedError('Please sign in again.'));
  return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
}
module.exports = { requireAuth };
```

```js
// src/middleware/requireRole.js
const { ForbiddenError } = require('../utils/errors');

/** Usage: router.use(requireRole('Admin')) */
const requireRole = (...roles) => (req, res, next) =>
  roles.some(r => req.user?.roles?.includes(r))
    ? next()
    : next(new ForbiddenError('You do not have access to this area.'));
module.exports = { requireRole };
```

Architect pages and APIs use `requireRole('Architect')` — Entra admins also
have the `Architect` role, local admins do not (they cannot own papers).
Admin areas use `requireRole('Admin')`. A *Disabled* user is stopped earlier,
in `requireAuth`, with the 403 "Access not granted" page (`ACCESS_NOT_GRANTED`).

## 2. Authorisation (who may touch what)

| Resource | Rule | Where enforced |
|----------|------|----------------|
| Paper, answers, checks, results, chat, documents — **read** | Any signed-in user with a role; deleted papers → 404 | `paperService.getViewablePaper(paperId)` |
| Same — **write** (incl. uploads, chat, apply / keep) | `paper.owner_id === req.user.id`, otherwise **403 `NOT_OWNER`** | `paperService.getOwnedPaper(userId, paperId)` is the **only** way to load a paper for a change. |
| Reference files | Any signed-in user with a role | `file.controller` |
| Paper types, sections, standards, references (write) | Role `Admin` | Router-level `requireRole('Admin')` |
| Standard ↔ paper consistency | An answer's `standardId` must belong to the paper's type | `answer.service` (400 if not) |

## 3. Security requirements (NFR-SEC)

| ID | Requirement |
|----|-------------|
| NFR-SEC-01 | HTTPS only in all non-local environments. HSTS through `helmet`. |
| NFR-SEC-02 | `helmet` with a **Content Security Policy**: `default-src 'self'`; `script-src 'self'` (no inline scripts — page data goes in `data-*` attributes and is read with `JSON.parse`, D-34); `img-src 'self' data: blob:`; `worker-src 'self' blob:` (pdf.js worker); `frame-ancestors 'none'`. |
| NFR-SEC-03 | Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, name `psc.sid`. Secret from `SESSION_SECRET` (≥ 32 random bytes). |
| NFR-SEC-04 | CSRF protection on every state-changing request (synchroniser token stored in the session, sent as `X-CSRF-Token` or the `_csrf` form field). |
| NFR-SEC-05 | **Output encoding**: EJS `<%= %>` only. `<%- %>` (unescaped) is allowed **only** for including partials — a lint rule / code review check. The front end inserts user or AI text with `textContent`, or HTML through `escapeHtml()`. |
| NFR-SEC-06 | **Uploads**: size limits (multer `limits`); MIME **and magic bytes** checked (`%PDF-` for PDFs, PNG/JPEG signatures for images); PDFs parsed with pdf-lib to reject encrypted or corrupt files; original names stored for display only — S3 keys are always generated (`papers/{paperId}/{uuid}.pdf`). |
| NFR-SEC-07 | **S3**: private bucket (Block Public Access on), SSE-S3 or SSE-KMS encryption, versioning on, lifecycle rule for deleted documents. The app's IAM role has only `s3:GetObject`, `PutObject`, `DeleteObject` and `CopyObject` on its bucket prefix. |
| NFR-SEC-08 | **Rate limits** (`express-rate-limit`, Postgres-backed store): 300 requests / 5 min per user overall; 10 AI checks / hour; 20 chat messages / 10 min. |
| NFR-SEC-09 | **Secrets** only in environment variables / AWS Secrets Manager — never in git. `.env.example` lists names with fake values. |
| NFR-SEC-10 | SQL only through parameterised queries (`pg` placeholders). |
| NFR-SEC-11 | Dependencies: `npm audit` in CI fails the build on *high* / *critical*; Dependabot or Renovate weekly. |
| NFR-SEC-12 | Errors never expose stack traces, SQL or provider messages to the user (09 · §3). |
| NFR-SEC-13 | Security-relevant events are logged at `warn` / `info` with the user ID: sign-in, sign-out, access denied, 403 `NOT_OWNER` (change attempted on someone else's paper), admin changes, upload rejections, rate-limit hits. |
| NFR-SEC-14 | Personal data is limited to name, email and Entra OID. Uploaded PDFs, chat and deleted items are purged after **7 days** (FR-RET). S3 lifecycle rule as a safety net: expire objects under `papers/` after **8 days**. |
