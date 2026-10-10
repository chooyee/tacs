'use strict';

const config = require('../config');
const authService = require('../services/auth.service');
const { UnauthorizedError, AccessNotGrantedError } = require('../utils/errors');
const { destroySession } = require('./session');

/** Where to send someone who must sign in (local admins have their own form). */
function signInUrl(req, kind) {
  const returnTo = encodeURIComponent(req.originalUrl);
  return kind === 'local' ? `/auth/local?returnTo=${returnTo}` : `/auth/login?returnTo=${returnTo}`;
}

/** Pages redirect to sign-in; API calls get 401 so the front end can say "Sign in again". */
function notSignedIn(req, res, next, kind) {
  if (req.originalUrl.startsWith('/api/')) return next(new UnauthorizedError('Please sign in again.'));
  return res.redirect(signInUrl(req, kind));
}

/**
 * Make sure the user is signed in and still allowed in (FR-ACC-01, docs/08 §1.2).
 *
 * The session only holds `{ kind, id, signedInAt }`. The user is re-read from the database on every
 * request, so role changes and "Disabled" apply immediately (D-26, D-28). Sets `req.user` and adds
 * `userId` to `req.log`.
 *
 * @type {import('express').RequestHandler}
 */
async function requireAuth(req, res, next) {
  try {
    const sessionUser = req.session?.user;
    if (!sessionUser) return notSignedIn(req, res, next);

    // 8-hour absolute limit; the 60-minute idle limit is the cookie's rolling maxAge.
    const ageMs = Date.now() - sessionUser.signedInAt;
    if (!(ageMs < config.session.absoluteHours * 3600 * 1000)) {
      await destroySession(req);
      return notSignedIn(req, res, next, sessionUser.kind);
    }

    const user = await authService.loadCurrentUser(sessionUser);
    if (!user) {
      // Account deleted, or a local admin's password was reset: end this session.
      await destroySession(req);
      return notSignedIn(req, res, next, sessionUser.kind);
    }

    req.user = user;
    req.log = req.log?.child({ userId: user.id }) ?? req.log;
    if (user.status === 'disabled') {
      req.log?.warn('Access denied: account disabled');
      return next(new AccessNotGrantedError());
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
