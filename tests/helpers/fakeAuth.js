'use strict';

/**
 * Test-only sign-in (docs/12 §2). A request can say who it is with the header
 * `X-Test-User: <users.id>` (an Entra user that exists in the test DB) or `X-Test-User: local:<id>`.
 * The middleware writes the same session record that a real sign-in would.
 *
 * `createApp()` refuses this middleware unless NODE_ENV=test.
 *
 * @type {import('express').RequestHandler}
 */
function fakeAuth(req, _res, next) {
  const header = req.get('x-test-user');
  if (header) {
    const [kind, id] = header.startsWith('local:') ? ['local', header.slice(6)] : ['entra', header];
    req.session.user = { kind, id, signedInAt: Date.now() };
    const passwordChangedAt = req.get('x-test-password-changed-at');
    if (passwordChangedAt) req.session.user.passwordChangedAt = passwordChangedAt;
  }
  next();
}

module.exports = { fakeAuth };
