'use strict';

/**
 * /setup — create the first local administrator on first start (D-27). Thin: rules are in
 * setup.service.
 */
const setupService = require('../services/setup.service');
const authService = require('../services/auth.service');
const { regenerateSession, saveSession } = require('../middleware/session');

function renderForm(res, { username = '', error = null } = {}, status = 200) {
  res.status(status).render('layouts/main', {
    page: 'pages/setup',
    title: res.locals.t.setup.title,
    username,
    error,
  });
}

/** GET /setup */
async function form(req, res) {
  if (!(await setupService.isSetupRequired())) return res.redirect('/auth/local');
  await setupService.ensureSetupToken(req.log); // e.g. after a restart: print a fresh token
  return renderForm(res);
}

/** POST /setup — on success the new administrator is signed in straight away. */
async function create(req, res) {
  const { token, username, password, confirm } = req.body;
  const result = await setupService.createFirstAdmin({ token, username, password, confirm, log: req.log });
  if (!result.ok) {
    if (result.alreadyDone) return res.redirect(303, '/auth/local');
    return renderForm(res, { username, error: result.message }, 400);
  }
  await regenerateSession(req);
  req.session.user = authService.sessionRecordFor('local', result.admin);
  await saveSession(req);
  return res.redirect(303, '/admin/users');
}

module.exports = { form, create };
