'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const db = require('../../src/utils/db');
const setupService = require('../../src/services/setup.service');
const { resetDb, silentLog, closeDb } = require('../helpers/db');

const PASSWORD = 'first admin password';

/** An agent with its own session and the CSRF token from the /setup form. */
async function setupAgent(app) {
  const agent = request.agent(app);
  const page = await agent.get('/setup').expect(200);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { agent, csrf };
}

before(async () => {
  await resetDb();
  setupService.resetForTests();
});
after(closeDb);

describe('first-start setup of the first local administrator (D-27, FR-ACC-10)', () => {
  const app = createApp();
  let token;

  test('with no administrator, the start page and the local sign-in lead to /setup', async () => {
    assert.equal((await request(app).get('/').expect(302)).headers.location, '/setup');
    assert.equal((await request(app).get('/auth/local').expect(302)).headers.location, '/setup');
  });

  test('Entra sign-in is not blocked while setup is pending', async () => {
    const res = await request(app).get('/papers').expect(302);
    assert.match(res.headers.location, /^\/auth\/login/);
  });

  test('the setup page asks for the token from the server log', async () => {
    const res = await request(app).get('/setup').expect(200);
    assert.match(res.text, /Create the administrator/);
    assert.match(res.text, /Setup token/);
    token = await setupService.ensureSetupToken(silentLog); // the same token the log showed
    assert.ok(token && token.length >= 20);
  });

  test('a wrong setup token is refused and creates nothing', async () => {
    const { agent, csrf } = await setupAgent(app);
    const res = await agent
      .post('/setup')
      .type('form')
      .send({ _csrf: csrf, token: 'guess', username: 'root', password: PASSWORD, confirm: PASSWORD })
      .expect(400);
    assert.match(res.text, /setup token is not right/);
    const { rows } = await db.query('select count(*)::int as n from local_admins');
    assert.equal(rows[0].n, 0);
  });

  test('invalid username or mismatched passwords are explained', async () => {
    const { agent, csrf } = await setupAgent(app);
    const bad = await agent
      .post('/setup')
      .type('form')
      .send({ _csrf: csrf, token, username: 'A B', password: PASSWORD, confirm: PASSWORD })
      .expect(400);
    assert.match(bad.text, /lowercase letters/);
    const mismatch = await agent
      .post('/setup')
      .type('form')
      .send({ _csrf: csrf, token, username: 'root', password: PASSWORD, confirm: 'something else 123' })
      .expect(400);
    assert.match(mismatch.text, /not the same/);
  });

  test('two people submitting at once create exactly one administrator', async () => {
    const first = await setupAgent(app);
    const second = await setupAgent(app);
    const submit = ({ agent, csrf }, username) =>
      agent
        .post('/setup')
        .type('form')
        .send({ _csrf: csrf, token, username, password: PASSWORD, confirm: PASSWORD });

    const results = await Promise.all([submit(first, 'root'), submit(second, 'other')]);
    const locations = results.map((r) => r.headers.location).sort();
    assert.deepEqual(locations, ['/admin/users', '/auth/local']);

    const { rows } = await db.query('select username, created_by, must_change_password from local_admins');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_by, 'setup');
    assert.equal(rows[0].must_change_password, false); // they chose the password themselves

    // The winner is signed in straight away.
    const winner = results[0].headers.location === '/admin/users' ? first : second;
    const users = await winner.agent.get('/admin/users').expect(200);
    assert.match(users.text, new RegExp(rows[0].username));
  });

  test('after setup, /setup is closed and the old token no longer works', async () => {
    assert.equal((await request(app).get('/setup').expect(302)).headers.location, '/auth/local');
    const { agent, csrf } = await (async () => {
      const a = request.agent(app);
      const page = await a.get('/auth/local').expect(200);
      return { agent: a, csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1] };
    })();
    const res = await agent
      .post('/setup')
      .type('form')
      .send({ _csrf: csrf, token, username: 'late', password: PASSWORD, confirm: PASSWORD })
      .expect(303);
    assert.equal(res.headers.location, '/auth/local');
    assert.equal(await setupService.ensureSetupToken(silentLog), null);
  });

  test('after setup, the start page goes to sign-in again', async () => {
    const res = await request(app).get('/').expect(302);
    assert.match(res.headers.location, /^\/auth\/login/);
  });
});
