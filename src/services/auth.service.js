'use strict';

/**
 * Sign-in rules (docs/08 §1, D-26, D-27): Entra users, local administrators, and turning the small
 * session record into the current user on every request. No `req` / `res` here.
 */
const crypto = require('node:crypto');
const entra = require('../providers/auth/entraProvider');
const userModel = require('../models/user.model');
const localAdminModel = require('../models/localAdmin.model');
const { hashPassword, verifyPassword, getDummyHash, passwordProblem } = require('../utils/password');
const { UnauthorizedError } = require('../utils/errors');

const SIGN_IN_REQUEST_MAX_AGE_MS = 10 * 60 * 1000; // a sign-in must finish within 10 minutes
const LOCKOUT = { maxAttempts: 5, lockMinutes: 15 }; // FR-ACC-10
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** Constant-time string comparison. */
function sameString(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Accept only a path on this site, so sign-in cannot be abused to redirect elsewhere
 * (docs/08 §1.2 rule 1). "/papers" is fine; "//evil.com", "/\evil.com" and "https://…" are not.
 *
 * @param {unknown} value
 * @param {string} [fallback='/']
 * @returns {string}
 */
function safeReturnTo(value, fallback = '/') {
  if (typeof value !== 'string' || value.length > 2000) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // Backslashes and control characters (tabs, newlines…): browsers may "fix" them into another host.
  if (value.includes('\\') || [...value].some((ch) => ch.charCodeAt(0) < 32)) return fallback;
  return value;
}

/**
 * Step 1 of Entra sign-in: create state, nonce and PKCE values and the Entra URL.
 * The caller stores `authRequest` in the session.
 *
 * @param {{returnTo?: string}} params
 * @returns {Promise<{url: string, authRequest: object}>}
 */
async function startEntraSignIn({ returnTo }) {
  const { verifier, challenge } = await entra.createPkce();
  const authRequest = {
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: verifier,
    returnTo: safeReturnTo(returnTo),
    createdAt: Date.now(),
  };
  const url = await entra.buildAuthUrl({
    state: authRequest.state,
    nonce: authRequest.nonce,
    codeChallenge: challenge,
  });
  return { url, authRequest };
}

/**
 * Step 2 of Entra sign-in: check the callback, exchange the code, create or update the user.
 *
 * @param {{authRequest?: object, query: {code?: string, state?: string, error?: string}, log: import('pino').Logger}} params
 * @returns {Promise<{user: object, returnTo: string}>}
 * @throws {UnauthorizedError} SIGNIN_FAILED when the request is cancelled, forged or too old
 * @throws {ExternalServiceError} when Entra rejects the code
 */
async function completeEntraSignIn({ authRequest, query, log }) {
  if (query.error) {
    // e.g. the user cancelled, or Entra refused them (not assigned to the app)
    log.warn({ entraError: String(query.error).slice(0, 100) }, 'Entra sign-in returned an error');
    throw new UnauthorizedError('Sign-in was cancelled or refused. Please try again.', 'SIGNIN_FAILED');
  }
  const fresh = authRequest && Date.now() - authRequest.createdAt < SIGN_IN_REQUEST_MAX_AGE_MS;
  if (!fresh || !query.code || !sameString(query.state, authRequest.state)) {
    log.warn('Sign-in callback with a missing, expired or wrong state');
    throw new UnauthorizedError('Your sign-in expired. Please try again.', 'SIGNIN_FAILED');
  }

  const claims = await entra.exchangeCode({
    code: query.code,
    codeVerifier: authRequest.codeVerifier,
    nonce: authRequest.nonce,
  });
  if (!claims.oid)
    throw new UnauthorizedError('We could not sign you in. Please try again.', 'SIGNIN_FAILED');

  const user = await userModel.upsertFromSignIn({
    entraOid: claims.oid,
    email: claims.email ?? claims.preferred_username ?? null,
    displayName: claims.name ?? null,
  });
  log.info({ userId: user.id, role: user.role, status: user.status }, 'User signed in');
  return { user, returnTo: authRequest.returnTo };
}

/**
 * Check a local administrator's username + password (FR-ACC-10). Wrong credentials are an expected
 * outcome, so they are returned (for the form to show), not thrown.
 *
 * @param {{username: string, password: string, log: import('pino').Logger}} params
 * @returns {Promise<{ok: true, admin: object} | {ok: false, message: string}>}
 */
async function signInLocalAdmin({ username, password, log }) {
  const name = String(username ?? '')
    .trim()
    .toLowerCase();
  const admin = USERNAME_RE.test(name) ? await localAdminModel.findByUsername(name) : null;
  if (!admin) {
    await verifyPassword(String(password ?? ''), await getDummyHash()); // same timing as a real check
    log.warn('Local sign-in failed: unknown username');
    return { ok: false, message: 'Wrong username or password.' };
  }
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    log.warn({ localAdminId: admin.id }, 'Local sign-in refused: account locked');
    return { ok: false, message: `Too many wrong passwords. Try again in ${LOCKOUT.lockMinutes} minutes.` };
  }
  if (!(await verifyPassword(String(password ?? ''), admin.passwordHash))) {
    await localAdminModel.recordFailedSignIn(admin.id, LOCKOUT);
    log.warn({ localAdminId: admin.id }, 'Local sign-in failed: wrong password');
    return { ok: false, message: 'Wrong username or password.' };
  }
  await localAdminModel.recordSignIn(admin.id);
  log.info({ localAdminId: admin.id, mustChangePassword: admin.mustChangePassword }, 'Local admin signed in');
  return { ok: true, admin };
}

/**
 * Set a local administrator's own new password (after a temporary one).
 *
 * @param {{adminId: string, password: string, confirm: string, log: import('pino').Logger}} params
 * @returns {Promise<{ok: true, admin: object} | {ok: false, message: string}>}
 */
async function changeLocalAdminPassword({ adminId, password, confirm, log }) {
  const admin = await localAdminModel.findById(adminId);
  if (!admin) throw new UnauthorizedError('Please sign in again.');
  if (password !== confirm) return { ok: false, message: 'The two passwords are not the same.' };
  const problem = passwordProblem(password, admin.username);
  if (problem) return { ok: false, message: problem };
  if (await verifyPassword(password, admin.passwordHash)) {
    return { ok: false, message: 'Choose a password different from the temporary one.' };
  }
  const updated = await localAdminModel.setPassword(adminId, {
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
  });
  log.info({ localAdminId: adminId }, 'Local admin changed password');
  return { ok: true, admin: updated };
}

/**
 * The small record stored in the session after sign-in (docs/08 §1.2 rule 2).
 * @param {'entra'|'local'} kind
 * @param {object} account  a users row or local_admins row
 * @returns {{kind: string, id: string, signedInAt: number, passwordChangedAt?: string}}
 */
function sessionRecordFor(kind, account) {
  const record = { kind, id: account.id, signedInAt: Date.now() };
  if (kind === 'local') record.passwordChangedAt = new Date(account.passwordChangedAt).toISOString();
  return record;
}

/**
 * Turn the session record into `req.user`, re-reading the database so role, status and password
 * resets apply immediately (D-26, D-28). Returns null when the session is no longer valid.
 *
 * @param {{kind: 'entra'|'local', id: string, passwordChangedAt?: string}} sessionUser
 * @returns {Promise<{kind: string, id: string, name: string, email: string|null, roles: string[], status: string}|null>}
 */
async function loadCurrentUser(sessionUser) {
  if (sessionUser.kind === 'local') {
    const admin = await localAdminModel.findById(sessionUser.id);
    const sameLogin =
      admin && new Date(admin.passwordChangedAt).toISOString() === sessionUser.passwordChangedAt;
    if (!sameLogin || admin.mustChangePassword) return null;
    return {
      kind: 'local',
      id: admin.id,
      name: admin.username,
      email: null,
      roles: ['Admin'],
      status: 'active',
    };
  }
  const user = await userModel.findById(sessionUser.id);
  if (!user) return null;
  return {
    kind: 'entra',
    id: user.id,
    name: user.displayName || user.email || 'User',
    email: user.email,
    // Entra admins can also prepare papers (D-26), so they have both roles.
    roles: user.role === 'admin' ? ['Architect', 'Admin'] : ['Architect'],
    status: user.status,
  };
}

module.exports = {
  USERNAME_RE,
  safeReturnTo,
  startEntraSignIn,
  completeEntraSignIn,
  signInLocalAdmin,
  changeLocalAdminPassword,
  sessionRecordFor,
  loadCurrentUser,
};
