'use strict';

const crypto = require('node:crypto');
const { ForbiddenError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The session's CSRF token, created on first use. Empty when there is no session (e.g. /health). */
function tokenFor(req) {
  if (!req.session) return '';
  req.session.csrfToken ??= crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

/** Constant-time string comparison (a normal === leaks how many characters matched). */
function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * CSRF protection with a synchroniser token (NFR-SEC-04).
 *
 * - The token lives in the session. Views call `csrfToken()` (the `<meta name="csrf-token">` tag and
 *   hidden `_csrf` form fields); it is only created when a page actually uses it.
 * - Every POST / PUT / PATCH / DELETE must send it as header `X-CSRF-Token` or form field `_csrf`.
 *
 * @type {import('express').RequestHandler}
 */
function csrf(req, res, next) {
  // A function, not a value: creating the token creates a session, so only pages that show it pay
  // for one. (A getter would not work: res.render copies res.locals and so would call it every time.)
  res.locals.csrfToken = () => tokenFor(req);

  if (SAFE_METHODS.has(req.method)) return next();

  const sent = req.get('x-csrf-token') ?? req.body?._csrf;
  const expected = req.session?.csrfToken;
  if (!expected || !sent || !sameToken(sent, expected)) {
    return next(
      new ForbiddenError('Your session has expired. Reload the page and try again.', 'CSRF_INVALID'),
    );
  }
  return next();
}

module.exports = { csrf };
