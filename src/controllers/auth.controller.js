'use strict';

/**
 * Sign-in / sign-out pages (docs/08 §1, D-27). Thin: rules live in auth.service; this file only
 * moves values between the request, the session and the service.
 */
const authService = require('../services/auth.service');
const entra = require('../providers/auth/entraProvider');
const { regenerateSession, destroySession, saveSession } = require('../middleware/session');
const { UnauthorizedError } = require('../utils/errors');

const PASSWORD_CHANGE_MAX_AGE_MS = 10 * 60 * 1000;

/** Render one of the small sign-in pages inside the main layout. */
function renderAuthPage(res, page, locals, status = 200) {
  res.status(status).render('layouts/main', { page: `pages/auth/${page}`, ...locals });
}

/** GET /auth/login — redirect to Microsoft. */
async function login(req, res) {
  const { url, authRequest } = await authService.startEntraSignIn({ returnTo: req.query.returnTo });
  req.session.authRequest = authRequest;
  await saveSession(req); // must be stored before the browser comes back from Entra
  res.redirect(url);
}

/** GET /auth/callback — Microsoft sends the browser back here with a code. */
async function callback(req, res) {
  const authRequest = req.session.authRequest;
  delete req.session.authRequest; // one use only
  const { user, returnTo } = await authService.completeEntraSignIn({
    authRequest,
    query: req.query,
    log: req.log,
  });
  await regenerateSession(req); // new session ID after sign-in (prevents session fixation)
  req.session.user = authService.sessionRecordFor('entra', user);
  await saveSession(req);
  res.redirect(returnTo);
}

/** POST /auth/logout */
async function logout(req, res) {
  const kind = req.session.user?.kind;
  req.log.info({ userId: req.session.user?.id }, 'User signed out');
  await destroySession(req);
  res.clearCookie('psc.sid');
  // Local admins have no Microsoft session to end.
  res.redirect(303, kind === 'local' ? '/auth/logged-out' : entra.logoutUrl());
}

/** GET /auth/logged-out */
function loggedOut(_req, res) {
  renderAuthPage(res, 'loggedOut', { title: res.locals.t.auth.loggedOutTitle });
}

/** GET /auth/local — the local administrator sign-in form. */
function localForm(req, res) {
  renderAuthPage(res, 'local', {
    title: res.locals.t.auth.localTitle,
    username: '',
    error: null,
    returnTo: authService.safeReturnTo(req.query.returnTo, ''),
  });
}

/** POST /auth/local */
async function localLogin(req, res) {
  const { username, password } = req.body;
  const returnTo = authService.safeReturnTo(req.body.returnTo, '/admin/users');
  const result = await authService.signInLocalAdmin({ username, password, log: req.log });
  if (!result.ok) {
    return renderAuthPage(
      res,
      'local',
      {
        title: res.locals.t.auth.localTitle,
        username,
        error: result.message,
        returnTo: req.body.returnTo ?? '',
      },
      401,
    );
  }
  await regenerateSession(req);
  if (result.admin.mustChangePassword) {
    // Not signed in yet: first the temporary password must be replaced.
    req.session.passwordChange = { adminId: result.admin.id, createdAt: Date.now(), returnTo };
    await saveSession(req);
    return res.redirect(303, '/auth/local/password');
  }
  req.session.user = authService.sessionRecordFor('local', result.admin);
  await saveSession(req);
  return res.redirect(303, returnTo);
}

/** The pending password change, if it is still valid. */
function pendingPasswordChange(req) {
  const pending = req.session.passwordChange;
  if (!pending || Date.now() - pending.createdAt > PASSWORD_CHANGE_MAX_AGE_MS) {
    throw new UnauthorizedError('Please sign in again.', 'SIGNIN_EXPIRED');
  }
  return pending;
}

/** GET /auth/local/password */
function passwordForm(req, res) {
  pendingPasswordChange(req);
  renderAuthPage(res, 'password', { title: res.locals.t.auth.passwordTitle, error: null });
}

/** POST /auth/local/password */
async function changePassword(req, res) {
  const pending = pendingPasswordChange(req);
  const result = await authService.changeLocalAdminPassword({
    adminId: pending.adminId,
    password: req.body.password,
    confirm: req.body.confirm,
    log: req.log,
  });
  if (!result.ok) {
    return renderAuthPage(
      res,
      'password',
      { title: res.locals.t.auth.passwordTitle, error: result.message },
      400,
    );
  }
  await regenerateSession(req);
  req.session.user = authService.sessionRecordFor('local', result.admin);
  await saveSession(req);
  return res.redirect(303, pending.returnTo);
}

module.exports = { login, callback, logout, loggedOut, localForm, localLogin, passwordForm, changePassword };
