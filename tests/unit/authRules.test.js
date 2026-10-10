'use strict';

const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const authService = require('../../src/services/auth.service');
const entra = require('../../src/providers/auth/entraProvider');
const { hashPassword, verifyPassword, passwordProblem } = require('../../src/utils/password');
const { UnauthorizedError } = require('../../src/utils/errors');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

describe('safeReturnTo (docs/08 §1.2 rule 1: no open redirects)', () => {
  const { safeReturnTo } = authService;

  test('keeps a path on this site, including its query', () => {
    assert.equal(safeReturnTo('/papers?tab=all'), '/papers?tab=all');
  });

  for (const bad of [
    '//evil.com',
    '/\\evil.com',
    'https://evil.com',
    'evil.com',
    '/pa\tpers',
    '/x\\y',
    '',
    42,
    null,
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(safeReturnTo(bad), '/');
    });
  }

  test('uses the given fallback', () => {
    assert.equal(safeReturnTo('//evil.com', '/admin/users'), '/admin/users');
  });
});

describe('Entra sign-in callback checks (FR-ACC-01)', () => {
  afterEach(() => mock.restoreAll());

  const authRequest = () => ({
    state: 'expected-state',
    nonce: 'n',
    codeVerifier: 'v',
    returnTo: '/papers',
    createdAt: Date.now(),
  });

  test('an Entra error (e.g. cancelled) is refused', async () => {
    await assert.rejects(
      authService.completeEntraSignIn({
        authRequest: authRequest(),
        query: { error: 'access_denied' },
        log: silentLog,
      }),
      (err) => err instanceof UnauthorizedError && err.code === 'SIGNIN_FAILED',
    );
  });

  test('a wrong state is refused before the code is exchanged', async () => {
    const exchange = mock.method(entra, 'exchangeCode', async () => ({ oid: 'x' }));
    await assert.rejects(
      authService.completeEntraSignIn({
        authRequest: authRequest(),
        query: { code: 'c', state: 'forged-state' },
        log: silentLog,
      }),
      UnauthorizedError,
    );
    assert.equal(exchange.mock.callCount(), 0);
  });

  test('a callback without a stored sign-in request is refused', async () => {
    await assert.rejects(
      authService.completeEntraSignIn({
        authRequest: undefined,
        query: { code: 'c', state: 's' },
        log: silentLog,
      }),
      UnauthorizedError,
    );
  });

  test('a sign-in request older than 10 minutes is refused', async () => {
    const old = { ...authRequest(), createdAt: Date.now() - 11 * 60 * 1000 };
    await assert.rejects(
      authService.completeEntraSignIn({
        authRequest: old,
        query: { code: 'c', state: 'expected-state' },
        log: silentLog,
      }),
      UnauthorizedError,
    );
  });

  test('startEntraSignIn stores state, nonce and PKCE verifier and sanitises returnTo', async () => {
    mock.method(entra, 'buildAuthUrl', async ({ state, nonce, codeChallenge }) => {
      assert.ok(state && nonce && codeChallenge);
      return 'https://login.microsoftonline.com/authorize';
    });
    const { url, authRequest: stored } = await authService.startEntraSignIn({ returnTo: '//evil.com' });
    assert.equal(url, 'https://login.microsoftonline.com/authorize');
    assert.equal(stored.returnTo, '/');
    assert.ok(stored.state.length >= 32 && stored.nonce.length >= 32 && stored.codeVerifier);
    assert.notEqual(stored.state, stored.nonce);
  });
});

describe('local admin passwords (FR-ACC-10)', () => {
  test('a hash verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('wrong horse battery', hash), false);
  });

  test('two hashes of the same password differ (random salt)', async () => {
    assert.notEqual(await hashPassword('same password 123'), await hashPassword('same password 123'));
  });

  test('password rules: at least 12 characters, not containing the username', () => {
    assert.match(passwordProblem('short', 'admin'), /12 characters/);
    assert.match(passwordProblem('my-admin-password', 'admin'), /username/);
    assert.equal(passwordProblem('a long enough phrase', 'admin'), null);
  });

  test('an unknown username is refused without touching the account table', async () => {
    const result = await authService.signInLocalAdmin({ username: 'NO', password: 'x', log: silentLog });
    assert.deepEqual(result, { ok: false, message: 'Wrong username or password.' });
  });
});
