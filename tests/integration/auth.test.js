'use strict';

const { test, describe, before, after, beforeEach, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const entra = require('../../src/providers/auth/entraProvider');
const db = require('../../src/utils/db');
const localAdminModel = require('../../src/models/localAdmin.model');
const { hashPassword } = require('../../src/utils/password');
const { fakeAuth } = require('../helpers/fakeAuth');
const { resetDb, createUser, closeDb } = require('../helpers/db');

const LOCAL_PASSWORD = 'temporary-pass-123';

/** Read the CSRF token from a page the agent can open. */
async function csrfFrom(agent, url) {
  const page = await agent.get(url).expect(200);
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

before(resetDb);
after(closeDb);

describe('Entra sign-in end to end (FR-ACC-01, FR-ACC-06, D-26)', () => {
  const app = createApp();
  let lastState;

  beforeEach(() => {
    mock.method(entra, 'createPkce', async () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }));
    mock.method(entra, 'buildAuthUrl', async ({ state }) => {
      lastState = state;
      return `https://login.microsoftonline.com/fake/authorize?state=${state}`;
    });
  });
  afterEach(() => mock.restoreAll());

  test('FR-ACC-06: first sign-in creates an Architect and returns to the page asked for', async () => {
    const exchange = mock.method(entra, 'exchangeCode', async () => ({
      oid: 'oid-dana',
      name: 'Dana Tan',
      preferred_username: 'dana@example.com',
    }));
    const agent = request.agent(app);

    const start = await agent.get('/papers?tab=all').expect(302);
    assert.equal(start.headers.location, '/auth/login?returnTo=%2Fpapers%3Ftab%3Dall');
    const login = await agent.get(start.headers.location).expect(302);
    assert.match(login.headers.location, /^https:\/\/login\.microsoftonline\.com\//);
    const cookieBefore = login.headers['set-cookie'][0].split(';')[0];

    const back = await agent.get(`/auth/callback?code=the-code&state=${lastState}`).expect(302);
    assert.equal(back.headers.location, '/papers?tab=all');
    // The session ID changes after sign-in (session fixation).
    assert.notEqual(back.headers['set-cookie'][0].split(';')[0], cookieBefore);
    // PKCE verifier and nonce from step 1 are passed to the token exchange.
    assert.equal(exchange.mock.calls[0].arguments[0].codeVerifier, 'verifier-1');
    assert.ok(exchange.mock.calls[0].arguments[0].nonce);

    const { rows } = await db.query('select * from users where entra_oid = $1', ['oid-dana']);
    assert.equal(rows[0].role, 'architect');
    assert.equal(rows[0].email, 'dana@example.com');

    const papers = await agent.get('/papers').expect(200);
    assert.match(papers.text, /My papers/);
    assert.match(papers.text, /DT/); // initials in the user menu
    assert.doesNotMatch(papers.text, /href="\/admin\/users"/); // FR-ACC-05: no mode switch for architects
  });

  test('FR-ACC-06: a later sign-in updates name and email but never the role', async () => {
    await db.query(`update users set role = 'admin' where entra_oid = 'oid-dana'`);
    mock.method(entra, 'exchangeCode', async () => ({
      oid: 'oid-dana',
      name: 'Dana T.',
      email: 'dt@example.com',
    }));
    const agent = request.agent(app);
    await agent.get('/auth/login').expect(302);
    await agent.get(`/auth/callback?code=c&state=${lastState}`).expect(302);
    const { rows } = await db.query('select * from users where entra_oid = $1', ['oid-dana']);
    assert.equal(rows[0].role, 'admin');
    assert.equal(rows[0].display_name, 'Dana T.');
  });

  test('a callback with a forged state is refused and nobody is signed in', async () => {
    const exchange = mock.method(entra, 'exchangeCode', async () => ({ oid: 'oid-x' }));
    const agent = request.agent(app);
    await agent.get('/auth/login').expect(302);
    const res = await agent.get('/auth/callback?code=c&state=forged').set('Accept', 'text/html').expect(401);
    assert.match(res.text, /sign-in expired/i);
    assert.equal(exchange.mock.callCount(), 0);
    await agent.get('/papers').expect(302);
  });

  test('a returnTo pointing to another site is replaced by /', async () => {
    mock.method(entra, 'exchangeCode', async () => ({ oid: 'oid-dana', name: 'Dana' }));
    const agent = request.agent(app);
    await agent.get('/auth/login?returnTo=//evil.example.com').expect(302);
    const back = await agent.get(`/auth/callback?code=c&state=${lastState}`).expect(302);
    assert.equal(back.headers.location, '/');
  });

  test('FR-ACC-07: sign-out ends the session and goes to the Entra logout URL', async () => {
    mock.method(entra, 'exchangeCode', async () => ({ oid: 'oid-dana', name: 'Dana' }));
    const agent = request.agent(app);
    await agent.get('/auth/login').expect(302);
    await agent.get(`/auth/callback?code=c&state=${lastState}`).expect(302);
    const token = await csrfFrom(agent, '/papers');
    const out = await agent.post('/auth/logout').type('form').send({ _csrf: token }).expect(303);
    assert.match(out.headers.location, /oauth2\/v2\.0\/logout\?post_logout_redirect_uri=.*auth%2Flogged-out/);
    await agent.get('/papers').expect(302);
  });
});

describe('roles and disabled users (FR-ACC-03, FR-ACC-04, FR-ACC-05, D-28)', () => {
  const app = createApp({ testAuth: fakeAuth });

  test('FR-ACC-04: an architect gets 403 on admin pages and admin APIs', async () => {
    const architect = await createUser();
    const agent = request.agent(app).set('X-Test-User', architect.id);
    const page = await agent.get('/admin/users').set('Accept', 'text/html').expect(403);
    assert.match(page.text, /No access/);
    const token = await csrfFrom(agent, '/papers');
    const api = await agent
      .patch(`/api/admin/users/${architect.id}`)
      .set('X-CSRF-Token', token)
      .send({ role: 'admin' })
      .expect(403);
    assert.equal(api.body.error.code, 'FORBIDDEN');
  });

  test('FR-ACC-05: an Entra admin sees the mode switch and both areas', async () => {
    const admin = await createUser({ role: 'admin', name: 'Ada Admin' });
    const agent = request.agent(app).set('X-Test-User', admin.id);
    const papers = await agent.get('/papers').expect(200);
    assert.match(papers.text, /href="\/admin\/users"/);
    const users = await agent.get('/admin/users').expect(200);
    assert.match(users.text, /Ada Admin/);
  });

  test('FR-ACC-03: a disabled user sees "Access not granted" and can still sign out', async () => {
    const disabled = await createUser({ status: 'disabled' });
    const agent = request.agent(app).set('X-Test-User', disabled.id);
    const res = await agent.get('/papers').set('Accept', 'text/html').expect(403);
    assert.match(res.text, /Access not granted/);
    assert.match(res.text, /Ask the Architecture Office/);
    assert.match(res.text, /Sign out/);
  });

  test('D-26: a session for a user that no longer exists is ended', async () => {
    const agent = request.agent(app).set('X-Test-User', '00000000-0000-4000-8000-000000000000');
    const res = await agent.get('/papers').expect(302);
    assert.match(res.headers.location, /^\/auth\/login/);
  });

  test('/ sends architects to /papers', async () => {
    const architect = await createUser();
    const res = await request(app).get('/').set('X-Test-User', architect.id).expect(302);
    assert.equal(res.headers.location, '/papers');
  });
});

describe('Users page API (FR-ACC-09, D-26, D-28)', () => {
  const app = createApp({ testAuth: fakeAuth });
  let admin;
  let agent;
  let token;

  before(async () => {
    admin = await createUser({ role: 'admin', name: 'Ada Admin' });
    agent = request.agent(app).set('X-Test-User', admin.id);
    token = await csrfFrom(agent, '/papers');
  });

  test('FR-ACC-09: promoting a user applies on their next request', async () => {
    const target = await createUser({ name: 'Ben Architect' });
    const targetAgent = request.agent(app).set('X-Test-User', target.id);
    await targetAgent.get('/admin/users').set('Accept', 'text/html').expect(403);

    const res = await agent
      .patch(`/api/admin/users/${target.id}`)
      .set('X-CSRF-Token', token)
      .send({ role: 'admin' })
      .expect(200);
    assert.equal(res.body.data.role, 'admin');

    await targetAgent.get('/admin/users').expect(200); // immediately, no new sign-in needed

  });

  test('D-28: disabling a user locks them out on their next request', async () => {
    const target = await createUser();
    await agent
      .patch(`/api/admin/users/${target.id}`)
      .set('X-CSRF-Token', token)
      .send({ status: 'disabled' })
      .expect(200);
    await request(app).get('/papers').set('X-Test-User', target.id).set('Accept', 'text/html').expect(403);
  });

  test('D-28: an admin cannot change their own role or status', async () => {
    const res = await agent
      .patch(`/api/admin/users/${admin.id}`)
      .set('X-CSRF-Token', token)
      .send({ role: 'architect' })
      .expect(409);
    assert.equal(res.body.error.code, 'CANNOT_CHANGE_SELF');
  });

  test('invalid input → 400 with details; unknown user → 404', async () => {
    const target = await createUser();
    const bad = await agent
      .patch(`/api/admin/users/${target.id}`)
      .set('X-CSRF-Token', token)
      .send({ role: 'owner' })
      .expect(400);
    assert.equal(bad.body.error.details[0].field, 'role');
    await agent
      .patch(`/api/admin/users/not-a-uuid`)
      .set('X-CSRF-Token', token)
      .send({ role: 'admin' })
      .expect(400);
    await agent
      .patch(`/api/admin/users/00000000-0000-4000-8000-000000000000`)
      .set('X-CSRF-Token', token)
      .send({ role: 'admin' })
      .expect(404);
  });

  test('NFR-SEC-04: the API refuses a change without the CSRF token', async () => {
    const target = await createUser();
    const res = await agent.patch(`/api/admin/users/${target.id}`).send({ role: 'admin' }).expect(403);
    assert.equal(res.body.error.code, 'CSRF_INVALID');
  });
});

describe('local administrators (FR-ACC-10, D-27)', () => {
  const app = createApp();

  /** A fresh local admin with the temporary password LOCAL_PASSWORD. */
  async function newLocalAdmin(username) {
    return localAdminModel.create({
      username,
      passwordHash: await hashPassword(LOCAL_PASSWORD),
      createdBy: 'test',
    });
  }

  async function signIn(agent, username, password) {
    const token = await csrfFrom(agent, '/auth/local');
    return agent.post('/auth/local').type('form').send({ _csrf: token, username, password });
  }

  test('first sign-in must change the temporary password, then opens the admin area only', async () => {
    await newLocalAdmin('breakglass');
    const agent = request.agent(app);

    const first = await signIn(agent, 'BreakGlass', LOCAL_PASSWORD); // usernames are case-insensitive
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, '/auth/local/password');
    await agent.get('/admin/users').expect(302); // not signed in until the password is changed

    let token = await csrfFrom(agent, '/auth/local/password');
    const mismatch = await agent
      .post('/auth/local/password')
      .type('form')
      .send({ _csrf: token, password: 'a brand new password', confirm: 'something else entirely' })
      .expect(400);
    assert.match(mismatch.text, /not the same/);

    token = await csrfFrom(agent, '/auth/local/password');
    const done = await agent
      .post('/auth/local/password')
      .type('form')
      .send({ _csrf: token, password: 'a brand new password', confirm: 'a brand new password' })
      .expect(303);
    assert.equal(done.headers.location, '/admin/users');

    const users = await agent.get('/admin/users').expect(200);
    assert.match(users.text, /Local administrator/);
    assert.doesNotMatch(users.text, /href="\/papers"[^>]*aria-current/); // no mode switch
    await agent.get('/papers').set('Accept', 'text/html').expect(403); // D-27: no papers
    const home = await agent.get('/').expect(302);
    assert.equal(home.headers.location, '/admin/users');
  });

  test('a local admin can promote a user', async () => {
    const admin = await newLocalAdmin('promoter');
    await localAdminModel.setPassword(admin.id, {
      passwordHash: await hashPassword(LOCAL_PASSWORD),
      mustChangePassword: false,
    });
    const agent = request.agent(app);
    const res = await signIn(agent, 'promoter', LOCAL_PASSWORD);
    assert.equal(res.headers.location, '/admin/users');

    const target = await createUser();
    const token = await csrfFrom(agent, '/admin/users'); // from the top bar's sign-out form
    await agent
      .patch(`/api/admin/users/${target.id}`)
      .set('X-CSRF-Token', token)
      .send({ role: 'admin' })
      .expect(200);
    const { rows } = await db.query('select role from users where id = $1', [target.id]);
    assert.equal(rows[0].role, 'admin');
  });

  test('FR-ACC-10: five wrong passwords lock the account for 15 minutes', async () => {
    await newLocalAdmin('lockme');
    const agent = request.agent(app);
    for (let i = 0; i < 5; i += 1) {
      const res = await signIn(agent, 'lockme', 'wrong-password-xyz');
      assert.equal(res.status, 401);
    }
    const locked = await signIn(agent, 'lockme', LOCAL_PASSWORD);
    assert.equal(locked.status, 401);
    assert.match(locked.text, /Too many wrong passwords/);
  });

  test('a password reset signs out existing sessions of that account', async () => {
    const admin = await newLocalAdmin('resetme');
    await localAdminModel.setPassword(admin.id, {
      passwordHash: await hashPassword(LOCAL_PASSWORD),
      mustChangePassword: false,
    });
    const agent = request.agent(app);
    await signIn(agent, 'resetme', LOCAL_PASSWORD);
    await agent.get('/admin/users').expect(200);

    // Same moment as `npm run admin -- reset resetme`.
    await localAdminModel.setPassword(admin.id, {
      passwordHash: await hashPassword('x'.repeat(20)),
      mustChangePassword: true,
    });
    const res = await agent.get('/admin/users').expect(302);
    assert.match(res.headers.location, /^\/auth\/local\?returnTo=/);
  });

  test('D-27: only the first account is created by the bootstrap path', async () => {
    const skipped = await localAdminModel.create({
      username: 'second',
      passwordHash: await hashPassword(LOCAL_PASSWORD),
      createdBy: 'bootstrap',
      onlyIfNone: true,
    });
    assert.equal(skipped, null); // accounts already exist from the tests above
  });
});

describe('migrations (docs/05 §3.16)', () => {
  test('running the migrations again applies nothing', async () => {
    const { migrate } = require('../../db/migrate');
    const applied = await migrate({ log: { info() {} } });
    assert.deepEqual(applied, []);
    const { rows } = await db.query('select filename from schema_migrations');
    assert.ok(rows.some((r) => r.filename === '001_init.sql'));
  });
});
