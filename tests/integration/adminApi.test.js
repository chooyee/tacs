'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { fakeAuth } = require('../helpers/fakeAuth');
const { resetDb, createUser, closeDb } = require('../helpers/db');
const { makePdf, PNG_BYTES, ENCRYPTED_PDF } = require('../helpers/files');

const app = createApp({ testAuth: fakeAuth });
let admin; // agent signed in as an Entra admin, with its CSRF token
let architect;

/** An agent for a user, with the CSRF token from the top bar. */
async function agentFor(user, page) {
  const agent = request.agent(app).set('X-Test-User', user.id);
  const html = (await agent.get(page).expect(200)).text;
  const token = html.match(/name="_csrf" value="([^"]+)"/)[1];
  agent.set('X-CSRF-Token', token);
  return agent;
}

before(async () => {
  await resetDb();
  admin = await agentFor(await createUser({ role: 'admin', name: 'Ada Admin' }), '/admin/types');
  architect = await agentFor(await createUser({ name: 'Ari Architect' }), '/papers');
});
after(closeDb);

describe('admin pages (FR-ACC-04, D-32)', () => {
  test('the mode switch and /admin lead to paper types; tabs link to Users', async () => {
    assert.equal((await admin.get('/admin').expect(302)).headers.location, '/admin/types');
    const page = await admin.get('/admin/types').expect(200);
    assert.match(page.text, /href="\/admin\/users"/);
    assert.match(page.text, /New paper type/);
  });

  test('/ remembers the last mode of an Entra admin', async () => {
    await admin.get('/admin/types').expect(200);
    assert.equal((await admin.get('/').expect(302)).headers.location, '/admin/types');
    await admin.get('/papers').expect(200);
    assert.equal((await admin.get('/').expect(302)).headers.location, '/papers');
  });

  test('FR-ACC-04: architects cannot open admin pages or call the admin API', async () => {
    await architect.get('/admin/types').set('Accept', 'text/html').expect(403);
    const res = await architect.post('/api/admin/types').send({ name: 'Nope' }).expect(403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  test('an unknown paper type shows the 404 page', async () => {
    await admin
      .get('/admin/types/00000000-0000-4000-8000-000000000000')
      .set('Accept', 'text/html')
      .expect(404);
  });
});

describe('admin API end to end (docs/06 §4)', () => {
  let typeId;
  let sectionId;
  let standardId;
  let referenceId;

  test('FR-ADM-02: POST /api/admin/types creates a type → 201 {id, url}', async () => {
    const res = await admin
      .post('/api/admin/types')
      .send({ name: '  SaaS API  ', description: 'Vendor-hosted' })
      .expect(201);
    typeId = res.body.data.id;
    assert.equal(res.body.data.url, `/admin/types/${typeId}`);
    const editor = await admin.get(res.body.data.url).expect(200);
    assert.match(editor.text, /value="SaaS API"/); // trimmed
    assert.match(editor.text, /General/);
    sectionId = editor.text.match(/data-section-id="([0-9a-f-]{36})"/)[1];
  });

  test('validation: name required, ≤ 80 characters; 409 NAME_TAKEN', async () => {
    const bad = await admin
      .post('/api/admin/types')
      .send({ name: 'x'.repeat(81) })
      .expect(400);
    assert.equal(bad.body.error.details[0].field, 'name');
    await admin.post('/api/admin/types').send({ name: '' }).expect(400);
    const dup = await admin.post('/api/admin/types').send({ name: 'saas api' }).expect(409);
    assert.equal(dup.body.error.code, 'NAME_TAKEN');
  });

  test('FR-ADM-10: PATCH saves the description; an empty one clears it', async () => {
    const res = await admin.patch(`/api/admin/types/${typeId}`).send({ description: '  ' }).expect(200);
    assert.equal(res.body.data.description, null);
  });

  test('FR-ADM-16: POST a standard; the standards card shows it numbered', async () => {
    const res = await admin
      .post(`/api/admin/sections/${sectionId}/standards`)
      .send({ text: 'Service accounts inventoried' })
      .expect(201);
    standardId = res.body.data.id;
    assert.equal(res.body.data.isMandatory, false);
    await admin
      .post(`/api/admin/sections/${sectionId}/standards`)
      .send({ text: 'x'.repeat(501) })
      .expect(400);

    const card = await admin.get(`/admin/types/${typeId}/cards/standards`).expect(200);
    assert.match(card.text.trim(), /^<section class="panel" id="standards-card">/);
    assert.match(card.text, /Service accounts inventoried/);
    assert.doesNotMatch(card.text, /<html/); // a fragment, not a full page
  });

  test('FR-ADM-12: upload a PDF reference (multipart) → 201 without storage details', async () => {
    const res = await admin
      .post(`/api/admin/types/${typeId}/references`)
      .field('type', 'Policy')
      .field('title', 'Identity Standard')
      .field('url', 'https://intranet.example.com/idp')
      .field('note', 'Look for SSO')
      .attach('file', await makePdf(3), { filename: 'idp.pdf', contentType: 'application/pdf' })
      .expect(201);
    referenceId = res.body.data.id;
    assert.deepEqual(
      [res.body.data.title, res.body.data.pageCount, res.body.data.fileName],
      ['Identity Standard', 3, 'idp.pdf'],
    );
    assert.equal(res.body.data.s3Key, undefined);
  });

  test('NFR-SEC-06: upload rejections (415, 422, 413, 400)', async () => {
    const post = () =>
      admin.post(`/api/admin/types/${typeId}/references`).field('type', 'Policy').field('title', 'Bad');
    const fake = await post()
      .attach('file', Buffer.from('MZ not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(415);
    assert.equal(fake.body.error.code, 'FILE_TYPE');
    const encrypted = await post()
      .attach('file', ENCRYPTED_PDF, { filename: 'locked.pdf', contentType: 'application/pdf' })
      .expect(422);
    assert.equal(encrypted.body.error.code, 'PDF_ENCRYPTED');
    const big = await post()
      .attach('file', Buffer.alloc(15 * 1024 * 1024 + 1, 0x25), {
        filename: 'big.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);
    assert.equal(big.body.error.code, 'FILE_TOO_LARGE');
    const missing = await post().expect(400);
    assert.match(missing.body.error.message, /Choose a file/);
    const httpLink = await admin
      .post(`/api/admin/types/${typeId}/references`)
      .field('type', 'Policy')
      .field('title', 'Link')
      .field('url', 'http://intranet/x')
      .attach('file', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' })
      .expect(400);
    assert.equal(httpLink.body.error.details[0].field, 'url');
  });

  test('FR-ADM-17: link the reference to the standard; another type’s reference is refused', async () => {
    const res = await admin
      .patch(`/api/admin/standards/${standardId}`)
      .send({ isMandatory: true, referenceIds: [referenceId] })
      .expect(200);
    assert.deepEqual([res.body.data.isMandatory, res.body.data.warnings], [true, []]);
    const card = await admin.get(`/admin/types/${typeId}/cards/references`).expect(200);
    assert.match(card.text, /linked to 1 standard\b/);
    await admin
      .patch(`/api/admin/standards/${standardId}`)
      .send({ referenceIds: ['00000000-0000-4000-8000-000000000000'] })
      .expect(400);
  });

  test('FR-REF-02 / FR-REF-04: any signed-in user can view a reference and stream its file', async () => {
    const viewer = await architect.get(`/api/references/${referenceId}`).expect(200);
    assert.deepEqual(
      viewer.body.data.usedFor.map((s) => s.text),
      ['Service accounts inventoried'],
    );
    const file = await architect.get(viewer.body.data.fileUrl).buffer(true).expect(200);
    assert.equal(file.headers['content-type'], 'application/pdf');
    assert.match(file.headers['content-disposition'], /^inline; filename="idp\.pdf"/);
    assert.equal(file.headers['cache-control'], 'private, max-age=300');
    assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
  });

  test('files are not public: no session → sign-in', async () => {
    await request(app).get(`/files/references/${referenceId}`).expect(302);
  });

  test('FR-ADM-19: moving the only standard is a 409', async () => {
    const res = await admin
      .post(`/api/admin/standards/${standardId}/move`)
      .send({ direction: 'up' })
      .expect(409);
    assert.equal(res.body.error.code, 'CANNOT_MOVE');
    await admin.post(`/api/admin/standards/${standardId}/move`).send({ direction: 'sideways' }).expect(400);
  });

  test('FR-ADM-13 / FR-ADM-18: delete → 204, restore → 204, restore again → 409', async () => {
    await admin.delete(`/api/admin/references/${referenceId}`).expect(204);
    await architect.get(`/api/references/${referenceId}`).expect(404);
    await admin.post(`/api/admin/references/${referenceId}/restore`).expect(204);
    await admin.post(`/api/admin/references/${referenceId}/restore`).expect(409);

    await admin.delete(`/api/admin/sections/${sectionId}`).expect(204);
    await admin.patch(`/api/admin/standards/${standardId}`).send({ text: 'x' }).expect(404); // hidden with its section
    await admin.post(`/api/admin/sections/${sectionId}/restore`).expect(204);
    await admin.patch(`/api/admin/standards/${standardId}`).send({ text: 'Back again' }).expect(200);
  });

  test('NFR-SEC-04: admin writes without the CSRF token are refused, uploads included', async () => {
    const noToken = request.agent(app).set('X-Test-User', (await createUser({ role: 'admin' })).id);
    await noToken.post('/api/admin/types').send({ name: 'No token' }).expect(403);
    await noToken
      .post(`/api/admin/types/${typeId}/references`)
      .field('type', 'Policy')
      .field('title', 't')
      .attach('file', PNG_BYTES, { filename: 'a.png', contentType: 'image/png' })
      .expect(403);
  });

  test('FR-ADM-03: DELETE type → 204 and it disappears', async () => {
    const { body } = await admin.post('/api/admin/types').send({ name: 'Short lived' }).expect(201);
    await admin.delete(`/api/admin/types/${body.data.id}`).expect(204);
    const list = await admin.get('/admin/types').expect(200);
    assert.doesNotMatch(list.text, /Short lived/);
  });
});
