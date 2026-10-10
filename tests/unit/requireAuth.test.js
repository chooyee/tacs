'use strict';

const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireAuth } = require('../../src/middleware/requireAuth');
const authService = require('../../src/services/auth.service');
const { UnauthorizedError, AccessNotGrantedError } = require('../../src/utils/errors');

const HOUR = 3600 * 1000;

/** Run requireAuth with a fake request; resolves with what happened. */
function run({ sessionUser, url = '/papers' }) {
  return new Promise((resolve) => {
    let destroyed = false;
    const req = {
      originalUrl: url,
      session: { user: sessionUser, destroy: (cb) => ((destroyed = true), cb()) },
      log: { child: () => req.log, warn() {} },
    };
    const res = { redirect: (location) => resolve({ redirect: location, destroyed, req }) };
    requireAuth(req, res, (err) => resolve({ err, destroyed, req }));
  });
}

describe('requireAuth (FR-ACC-01, docs/08 §1.2)', () => {
  afterEach(() => mock.restoreAll());

  test('no session → redirect to Entra sign-in with returnTo', async () => {
    const { redirect } = await run({ sessionUser: undefined, url: '/papers?tab=all' });
    assert.equal(redirect, '/auth/login?returnTo=%2Fpapers%3Ftab%3Dall');
  });

  test('no session on an API → 401', async () => {
    const { err } = await run({ sessionUser: undefined, url: '/api/admin/users' });
    assert.ok(err instanceof UnauthorizedError);
  });

  test('a session older than 8 hours is destroyed (absolute limit)', async () => {
    const load = mock.method(authService, 'loadCurrentUser', async () => ({ id: 'u' }));
    const { redirect, destroyed } = await run({
      sessionUser: { kind: 'entra', id: 'u', signedInAt: Date.now() - 8 * HOUR - 1000 },
    });
    assert.ok(destroyed);
    assert.match(redirect, /^\/auth\/login/);
    assert.equal(load.mock.callCount(), 0);
  });

  test('an expired local admin session goes back to the local sign-in', async () => {
    const { redirect } = await run({ sessionUser: { kind: 'local', id: 'a', signedInAt: 0 } });
    assert.match(redirect, /^\/auth\/local\?returnTo=/);
  });

  test('a valid session sets req.user from the database', async () => {
    const user = { kind: 'entra', id: 'u', roles: ['Architect'], status: 'active' };
    mock.method(authService, 'loadCurrentUser', async () => user);
    const { err, req } = await run({ sessionUser: { kind: 'entra', id: 'u', signedInAt: Date.now() } });
    assert.equal(err, undefined);
    assert.equal(req.user, user);
  });

  test('D-28: a disabled user gets ACCESS_NOT_GRANTED', async () => {
    mock.method(authService, 'loadCurrentUser', async () => ({
      id: 'u',
      roles: ['Architect'],
      status: 'disabled',
    }));
    const { err } = await run({ sessionUser: { kind: 'entra', id: 'u', signedInAt: Date.now() } });
    assert.ok(err instanceof AccessNotGrantedError);
    assert.equal(err.code, 'ACCESS_NOT_GRANTED');
  });

  test('a session whose account is gone is destroyed', async () => {
    mock.method(authService, 'loadCurrentUser', async () => null);
    const { redirect, destroyed } = await run({
      sessionUser: { kind: 'entra', id: 'u', signedInAt: Date.now() },
    });
    assert.ok(destroyed);
    assert.match(redirect, /^\/auth\/login/);
  });
});
