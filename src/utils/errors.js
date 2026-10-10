'use strict';

/**
 * Error classes for the whole app (docs/09 §2).
 *
 * Every error has an HTTP `status`, a stable `code` (used by the front end and in logs) and a
 * `message` that is SAFE TO SHOW to the user. The original low-level error goes in `cause`: it is
 * logged, never shown. Only `middleware/errorHandler.js` turns these into responses.
 */

/** Base class for all expected ("operational") errors. */
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
    this.isOperational = true; // expected error, not a bug
  }
}

/** 400 — the request body / params are invalid. `details` lists the fields. */
class ValidationError extends AppError {
  constructor(message = 'Please fix the highlighted fields.', details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

/** 401 — not signed in (or the session expired). */
class UnauthorizedError extends AppError {
  constructor(message = 'Please sign in.', code = 'UNAUTHORIZED') {
    super(message, { status: 401, code });
  }
}

/** 403 — signed in, but not allowed. */
class ForbiddenError extends AppError {
  constructor(message = 'You do not have access.', code = 'FORBIDDEN') {
    super(message, { status: 403, code });
  }
}

/** 403 — the account is disabled (FR-ACC-03, D-28). Shown as the "Access not granted" page. */
class AccessNotGrantedError extends ForbiddenError {
  constructor(message = 'Your account does not have access to Paper Standards Check.') {
    super(message, 'ACCESS_NOT_GRANTED');
  }
}

/** 403 — someone tried to change a paper they do not own (FR-ACC-08). */
class NotOwnerError extends ForbiddenError {
  constructor(message = 'Only the owner can change this paper.') {
    super(message, 'NOT_OWNER');
  }
}

/** 404 */
class NotFoundError extends AppError {
  constructor(message = 'Not found.', code = 'NOT_FOUND') {
    super(message, { status: 404, code });
  }
}

/** 409 — the request conflicts with the current state (e.g. a check is already running). */
class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, { status: 409, code });
  }
}

/** 413 / 415 / 422 — an uploaded file was rejected. */
class FileRejectedError extends AppError {
  constructor(message, status = 415, code = 'FILE_REJECTED') {
    super(message, { status, code });
  }
}

/** 502 (or 503) — an external service (DB, S3, Entra) failed. Wrap the original error as `cause`. */
class ExternalServiceError extends AppError {
  constructor(message, { code = 'EXTERNAL_SERVICE_ERROR', cause, status = 502, details } = {}) {
    super(message, { status, code, cause, details });
  }
}

/** AI provider failures. Codes: AI_TIMEOUT, AI_RATE_LIMITED, AI_UNAVAILABLE, AI_BAD_REQUEST, AI_INVALID_RESPONSE. */
class AiProviderError extends ExternalServiceError {}

/** The app is misconfigured. Not operational: it is a bug or a deployment mistake. */
class ConfigError extends AppError {
  constructor(message) {
    super(message, { status: 500, code: 'CONFIG_ERROR' });
    this.isOperational = false;
  }
}

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  AccessNotGrantedError,
  NotOwnerError,
  NotFoundError,
  ConflictError,
  FileRejectedError,
  ExternalServiceError,
  AiProviderError,
  ConfigError,
};
