'use strict';

const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const { createApp } = require('../../src/app');
const db = require('../../src/utils/db');

// These tests use the real app with an in-memory session store and need no database.

/** Get a CSRF token: the local sign-in form renders one for an anonymous session. */
async function agentWithCsrfToken(app) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/local').expect(200);
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { agent, token };
}

describe('CSRF protection (NFR-SEC-04)', () => {
  const app = createApp();

  test('a POST without a token is refused with 403 CSRF_INVALID', async () => {
    const res = await request(app).post('/auth/logout').set('Accept', 'application/json').expect(403);
    assert.equal(res.body.error.code, 'CSRF_INVALID');
  });

  test('a POST with a wrong token is refused', async () => {
    const { agent } = await agentWithCsrfToken(app);
    const res = await agent
      .post('/auth/local')
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: 'wrong-token', username: 'x', password: 'y' })
      .expect(403);
    assert.equal(res.body.error.code, 'CSRF_INVALID');
  });

  test('a POST with the session token in the form passes the check', async () => {
    const { agent, token } = await agentWithCsrfToken(app);
    // Passes CSRF, then fails sign-in (unknown user) → 401 sign-in form, not 403.
    const res = await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: token, username: 'x', password: 'y' });
    assert.equal(res.status, 401);
    assert.match(res.text, /Wrong username or password/);
  });

  test('the X-CSRF-Token header is accepted too', async () => {
    const { agent, token } = await agentWithCsrfToken(app);
    const res = await agent
      .post('/auth/local')
      .set('X-CSRF-Token', token)
      .type('form')
      .send({ username: 'x', password: 'y' });
    assert.equal(res.status, 401);
  });

  test('a token from another session is refused', async () => {
    const { token } = await agentWithCsrfToken(app);
    const { agent: other } = await agentWithCsrfToken(app);
    await other
      .post('/auth/local')
      .set('Accept', 'application/json')
      .type('form')
      .send({ _csrf: token, username: 'x', password: 'y' })
      .expect(403);
  });
});

describe('security headers and cookies (NFR-SEC-02, NFR-SEC-03)', () => {
  const app = createApp();

  test('CSP forbids inline scripts and framing', async () => {
    const res = await request(app).get('/auth/logged-out').expect(200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /worker-src 'self' blob:/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  test('the session cookie is psc.sid, HttpOnly and SameSite=Lax', async () => {
    const res = await request(app).get('/auth/local').expect(200);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('psc.sid='));
    assert.ok(cookie, 'psc.sid cookie set');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('pages that do not need a session do not create one', async () => {
    const res = await request(app).get('/auth/logged-out').expect(200);
    assert.equal(res.headers['set-cookie'], undefined);
  });
});

describe('sign-in redirects (FR-ACC-01)', () => {
  const app = createApp();

  test('a page without a session redirects to sign-in with returnTo', async () => {
    const res = await request(app).get('/papers?tab=all').expect(302);
    assert.equal(res.headers.location, '/auth/login?returnTo=%2Fpapers%3Ftab%3Dall');
  });

  test('GET API call without a session gets 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/admin/users').expect(401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });
});

describe('fake auth guard (docs/12 §2)', () => {
  test('createApp refuses testAuth outside NODE_ENV=test', () => {
    // A separate process, because this one is already configured as NODE_ENV=test.
    const result = spawnSync(
      process.execPath,
      ['-e', "require('./src/app').createApp({ testAuth: (q, s, n) => n() })"],
      {
        cwd: path.join(__dirname, '..', '..'),
        env: { ...process.env, NODE_ENV: 'development' },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /testAuth may only be used when NODE_ENV=test/);
  });
});

describe('health checks (NFR-OPS-01)', () => {
  const app = createApp();
  afterEach(() => mock.restoreAll());

  test('GET /health → 200 without touching the database', async () => {
    const ping = mock.method(db, 'ping', async () => {});
    const res = await request(app).get('/health').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.equal(ping.mock.callCount(), 0);
  });

  test('GET /health/ready → 200 when the database answers', async () => {
    mock.method(db, 'ping', async () => {});
    const res = await request(app).get('/health/ready').expect(200);
    assert.deepEqual(res.body, { status: 'ok', checks: { db: 'ok' } });
  });

  test('GET /health/ready → 503 NOT_READY when the database is down, without details of the cause', async () => {
    mock.method(db, 'ping', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
    });
    const res = await request(app).get('/health/ready').expect(503);
    assert.equal(res.body.error.code, 'NOT_READY');
    assert.deepEqual(res.body.error.details, [{ check: 'db', status: 'fail' }]);
    assert.doesNotMatch(JSON.stringify(res.body), /ECONNREFUSED/);
  });

  test('health checks do not set a session cookie', async () => {
    mock.method(db, 'ping', async () => {});
    const res = await request(app).get('/health/ready').expect(200);
    assert.equal(res.headers['set-cookie'], undefined);
  });
});
