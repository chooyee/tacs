# 09 · Logging & error handling

Every feature **must** follow this document. Reviewers reject pull requests
that swallow errors, use `console.log`, or send raw error messages to users.

## 1. Logging

### 1.1 The logger utility

```js
// src/utils/logger.js
const pino = require('pino');
const config = require('../config');

/**
 * App-wide logger. Use child loggers to add context:
 *   const log = logger.child({ module: 'checkWorker' });
 *   log.info({ checkId }, 'Check started');
 */
const logger = pino({
  level: config.log.level,                       // LOG_LEVEL, default "info"
  base: { app: 'paper-standards-check', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {                                      // never log secrets
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.apiKey',
            '*.clientSecret', '*.token', '*.idToken', 'res.headers["set-cookie"]'],
    censor: '[REDACTED]',
  },
  transport: config.env === 'development'        // readable logs locally, JSON elsewhere
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

module.exports = { logger };
```

### 1.2 Request logging and the request ID

`src/middleware/requestLogger.js` uses `pino-http`:

- Reuses the incoming `X-Request-Id` header if present (from the load
  balancer), otherwise creates `crypto.randomUUID()`.
- Sets `req.id`, adds the response header `X-Request-Id`, and attaches
  `req.log` — a child logger that automatically includes `requestId` and
  `userId`.
- Logs one line per request: method, URL (without query strings that could
  contain data), status, duration in ms.
- `/health` requests are logged at `debug` only.

> **In controllers and services, use `req.log` (or pass `log` down) — not the
> global logger — so every line carries the request ID.** The worker creates
> `logger.child({ checkId })`.

### 1.3 Levels — when to use which

| Level | Use for | Example |
|-------|---------|---------|
| `fatal` | The app cannot continue | DB unreachable at startup |
| `error` | Unexpected failure; someone should look | Unhandled exception, check failed after retries |
| `warn` | Expected but notable; possible abuse or bad data | Access to another user's paper, upload rejected, AI returned an unknown standard key, retry happened |
| `info` | Business events (one line each) | User signed in, paper created, check queued / done (with duration and tokens), admin changed a standard |
| `debug` | Developer detail (off in production) | SQL timings, AI batch composition |

### 1.4 What never goes into logs

- Tokens, cookies, secrets, API keys (redacted automatically — don't rely on it, don't pass them).
- File contents, prompt text, AI output, remark text, chat text (`info` and above).
- Full request bodies.

### 1.5 Log line examples (JSON in production)

```json
{"level":"info","time":"2026-10-10T09:12:03.120Z","app":"paper-standards-check","requestId":"7f1c…","userId":"a91…","msg":"Check queued","paperId":"c2…","checkId":"e5…","files":2,"pages":18}
{"level":"warn","time":"…","requestId":"…","userId":"…","msg":"Paper not owned by user","paperId":"…"}
{"level":"info","time":"…","checkId":"e5…","provider":"gemini","model":"gemini-2.5-pro","batches":5,"inputTokens":182344,"outputTokens":6120,"durationMs":74211,"msg":"Check done"}
```

## 2. Errors

### 2.1 Error classes (`src/utils/errors.js`)

One base class with a few subclasses. Each has an HTTP status, a stable
`code` (for the front end and logs) and a **user-safe** message.

```js
class AppError extends Error {
  /**
   * @param {string} message  Safe to show to the user
   * @param {object} [opts]
   * @param {number} [opts.status=500]
   * @param {string} [opts.code='INTERNAL_ERROR']
   * @param {Array}  [opts.details]  e.g. field validation errors
   * @param {Error}  [opts.cause]    the original error (logged, never shown)
   */
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;   // expected error, not a bug
  }
}

class ValidationError   extends AppError { constructor(m, d) { super(m, { status: 400, code: 'VALIDATION_ERROR', details: d }); } }
class UnauthorizedError extends AppError { constructor(m = 'Please sign in.') { super(m, { status: 401, code: 'UNAUTHORIZED' }); } }
class ForbiddenError    extends AppError { constructor(m = 'You do not have access.') { super(m, { status: 403, code: 'FORBIDDEN' }); } }
class NotFoundError     extends AppError { constructor(m = 'Not found.') { super(m, { status: 404, code: 'NOT_FOUND' }); } }
class NotOwnerError     extends AppError { constructor(m = 'Only the owner can change this paper.') { super(m, { status: 403, code: 'NOT_OWNER' }); } }
class ConflictError     extends AppError { constructor(m, code = 'CONFLICT') { super(m, { status: 409, code }); } }
class FileRejectedError extends AppError { constructor(m, status = 415, code = 'FILE_REJECTED') { super(m, { status, code }); } }
class ExternalServiceError extends AppError {  // S3, Entra
  constructor(m, { code = 'EXTERNAL_SERVICE_ERROR', cause } = {}) { super(m, { status: 502, code, cause }); }
}
class AiProviderError extends ExternalServiceError {}  // codes: AI_TIMEOUT, AI_RATE_LIMITED, AI_UNAVAILABLE, AI_BAD_REQUEST, AI_INVALID_RESPONSE
class ConfigError extends AppError { constructor(m) { super(m, { status: 500, code: 'CONFIG_ERROR' }); this.isOperational = false; } }

module.exports = { AppError, ValidationError, UnauthorizedError, ForbiddenError, NotOwnerError, NotFoundError,
  ConflictError, FileRejectedError, ExternalServiceError, AiProviderError, ConfigError };
```

### 2.2 Rules for throwing and catching

1. **Throw** an `AppError` subclass when you know what went wrong
   (`throw new NotFoundError('Paper not found.')`).
2. **Wrap** low-level errors at the boundary where they happen — in providers
   and models — and keep the original as `cause`:
   ```js
   try { await s3.send(cmd); }
   catch (err) { throw new ExternalServiceError('We could not save your file. Please try again.', { cause: err }); }
   ```
3. **Do not catch just to log and re-throw.** The error handler logs everything once.
4. **Never swallow errors** (`catch {}`) except where documented — for
   example, a failed cleanup of an old S3 object is logged at `warn` and
   ignored.
5. Every async route handler is wrapped in `asyncHandler`, so rejected
   promises reach the error middleware:

```js
// src/utils/asyncHandler.js
/** Wraps an async Express handler so errors go to next(err). */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { asyncHandler };
```

## 3. The central error handler

`src/middleware/errorHandler.js` is the **only** place where errors become
responses.

```js
const { AppError } = require('../utils/errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  const code = known ? err.code : 'INTERNAL_ERROR';
  const message = known && status < 500 ? err.message
    : known ? err.message                      // 5xx AppErrors have user-safe messages too
    : 'Something went wrong on our side. Please try again.';

  const log = req.log || require('../utils/logger').logger;
  const level = status >= 500 ? 'error' : status === 404 || status === 401 ? 'info' : 'warn';
  log[level]({ err, code, status, userId: req.user?.id }, 'Request failed');  // pino prints stack + cause

  if (res.headersSent) return next(err);

  const body = { error: { code, message, details: known ? err.details : undefined, requestId: req.id } };
  if (req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.status(status).json(body);
  }
  const view = status === 404 ? 'pages/notFound' : status === 403 ? 'pages/forbidden' : 'pages/error';
  return res.status(status).render(view, { title: 'Error', ...body.error });
}

module.exports = { errorHandler };
```

User-facing messages must be **friendly and actionable** ("We couldn't read
this PDF. It may be password-protected — save an unprotected copy and try
again."), never technical ("pdf-lib: EncryptedPDFError").

### 3.1 Error response example

```json
HTTP/1.1 400 Bad Request
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please fix the highlighted fields.",
    "details": [{ "field": "title", "message": "Title must be 3–150 characters" }],
    "requestId": "7f1c2a9e-…"
  }
}
```

The front end shows `message` in a toast and the first 8 characters of
`requestId` as "ref", so support can find the log line.

## 4. Process-level safety nets (`server.js`)

```js
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — shutting down');
  shutdown(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  shutdown(1);
});
process.on('SIGTERM', () => shutdown(0));   // deploys / scaling
```

`shutdown(code)`: stop accepting connections (`server.close`), stop the check
worker (finish running jobs, max 30 s), close the DB pool, flush logs, then
`process.exit(code)`. The orchestrator restarts the container.

## 5. Background jobs

The worker catches every error **per check**:

- `AiProviderError` / `ExternalServiceError` → `status='failed'`,
  `error_code=err.code`, `error_message` = the friendly message; log `error`
  with `checkId`.
- Unknown errors → same, with the message "The check couldn't finish because
  of an unexpected error." and log `error` with the stack trace.
- The worker loop itself **never** crashes because of one check.
- A failed check posts an assistant `error` message in the chat with a
  **Try again** button (FR-AI-14).

## 6. Checklist for every pull request

- [ ] Async handlers wrapped in `asyncHandler`.
- [ ] Inputs validated with a zod schema (`validate()` middleware).
- [ ] Known failures throw the right `AppError` subclass with a friendly message.
- [ ] External errors wrapped with `cause`.
- [ ] `req.log` (or a child logger) used — no `console.log`.
- [ ] Nothing sensitive logged.
- [ ] Error paths covered by at least one test.
