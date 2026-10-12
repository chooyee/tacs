'use strict';

/**
 * Papers and answers end to end (FR-PAP-01…08, FR-ANS-04…15, FR-RDY-03, FR-ACC-08, docs/06 §3).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../../src/utils/db');
const { createApp } = require('../../src/app');
const { main: seed } = require('../../db/seed/seed');
const standardService = require('../../src/services/standard.service');
const { fakeAuth } = require('../helpers/fakeAuth');
const { resetDb, createUser, closeDb, silentLog: log } = require('../helpers/db');

const app = createApp({ testAuth: fakeAuth });

/** An agent for a user, with the CSRF token from the page. */
async function agentFor(user) {
  const agent = request.agent(app).set('X-Test-User', user.id);
  const html = (await agent.get('/papers').expect(200)).text;
  agent.set('X-CSRF-Token', html.match(/name="csrf-token" content="([^"]+)"/)[1]);
  return agent;
}

let dana;
let sam;
let saasId;
let cloudId;
let paperId;
let standards; // SaaS standards in display order: [{id, number, isMandatory}]

before(async () => {
  await resetDb();
  await seed();
  dana = await agentFor(await createUser({ name: 'Dana Tan' }));
  sam = await agentFor(await createUser({ name: 'Sam Lee' }));
  const types = (await db.query('select id, name from paper_types')).rows;
  saasId = types.find((t) => t.name === 'SaaS').id;
  cloudId = types.find((t) => t.name === 'Cloud Platform').id;
  standards = (
    await db.query(
      `select s.id, s.is_mandatory as "isMandatory",
              row_number() over (order by sec.position, sec.created_at, s.position, s.created_at)::int as number
         from standards s join sections sec on sec.id = s.section_id
        where sec.paper_type_id = $1 and s.deleted_at is null order by number`,
      [saasId],
    )
  ).rows;
});
after(closeDb);

const put = (agent, standardId, body, id = paperId) => agent.put(`/api/papers/${id}/answers/${standardId}`).send(body);

describe('papers (FR-PAP-01…08)', () => {
  test('FR-PAP-06: the empty My papers page offers New paper', async () => {
    const page = await dana.get('/papers').expect(200);
    assert.match(page.text, /No papers yet/);
    assert.match(page.text, /data-action="new-paper"/);
  });

  test('FR-PAP-02: create → 201 {id, url}; title 3–150 characters; the type must exist', async () => {
    const res = await dana
      .post('/api/papers')
      .send({ title: '  Contract Management SaaS  ', vendor: 'Icertis', paperTypeId: saasId })
      .expect(201);
    paperId = res.body.data.id;
    assert.equal(res.body.data.url, `/papers/${paperId}`);
    assert.equal((await dana.post('/api/papers').send({ title: 'ab', paperTypeId: saasId }).expect(400)).body.error.details[0].field, 'title');
    await dana.post('/api/papers').send({ title: 'x'.repeat(151), paperTypeId: saasId }).expect(400);
    await dana.post('/api/papers').send({ title: 'No type', paperTypeId: '00000000-0000-4000-8000-000000000000' }).expect(400);
  });

  test('FR-PAP-01: My papers shows the card with pill, counts and AI status', async () => {
    const page = await dana.get('/papers').expect(200);
    assert.match(page.text, /Contract Management SaaS/);
    assert.match(page.text, /Icertis/);
    assert.match(page.text, /Not started/);
    assert.match(page.text, /<b>0\/33<\/b> answered/);
    assert.match(page.text, /<b>0\/20<\/b> mandatory met/);
    assert.match(page.text, /Not AI-checked/);
  });

  test('FR-PAP-07: All papers shows everyone’s papers with the owner; search and type filter', async () => {
    await sam.post('/api/papers').send({ title: 'Landing zone', paperTypeId: cloudId }).expect(201);
    const all = await sam.get('/papers?tab=all').expect(200);
    assert.match(all.text, /by Dana Tan/);
    assert.match(all.text, /by Sam Lee/);
    assert.match(all.text, /2 papers/);
    const byOwner = await sam.get('/papers?tab=all&q=dana').expect(200);
    assert.match(byOwner.text, /1 paper\b/);
    const byType = await sam.get(`/papers?tab=all&typeId=${cloudId}`).expect(200);
    assert.match(byType.text, /Landing zone/);
    assert.doesNotMatch(byType.text, /tile-name[^>]*>Contract Management/);
    const odd = await sam.get('/papers?tab=all&q=%25_%25').expect(200); // % and _ are plain text
    assert.match(odd.text, /No paper matches/);
    const mine = await sam.get('/papers').expect(200);
    assert.doesNotMatch(mine.text, /tile-name[^>]*>Contract Management/);
  });

  test('FR-PAP-03: PATCH saves title / vendor; an empty title is refused; FR-PAP-05: the type cannot change', async () => {
    const res = await dana.patch(`/api/papers/${paperId}`).send({ title: 'Contract Management SaaS v2', vendor: '' }).expect(200);
    assert.deepEqual([res.body.data.title, res.body.data.vendor], ['Contract Management SaaS v2', null]);
    await dana.patch(`/api/papers/${paperId}`).send({ title: '  ' }).expect(400);
    await dana.patch(`/api/papers/${paperId}`).send({ paperTypeId: cloudId }).expect(400);
  });

  test('FR-ACC-08: anyone may read; every write by a non-owner is 403 NOT_OWNER', async () => {
    await sam.get(`/papers/${paperId}`).expect(200);
    await sam.get(`/api/papers/${paperId}/readiness`).expect(200);
    const writes = [
      sam.patch(`/api/papers/${paperId}`).send({ title: 'Mine now' }),
      sam.delete(`/api/papers/${paperId}`),
      put(sam, standards[0].id, { value: 'yes', remark: '' }),
      sam.post(`/api/papers/${paperId}/checks/rerun`),
      sam.post(`/api/papers/${paperId}/results/apply-unanswered`),
      sam.post(`/api/papers/${paperId}/chat`).send({ text: 'hi' }),
      sam.post(`/api/papers/${paperId}/chat/quick`).send({ action: 'refs' }),
    ];
    for (const res of await Promise.all(writes)) {
      assert.equal(res.status, 403, res.req.path);
      assert.equal(res.body.error.code, 'NOT_OWNER');
    }
  });

  test('FR-PAP-08: the read-only page has a banner and no inputs', async () => {
    const page = await sam.get(`/papers/${paperId}`).expect(200);
    assert.match(page.text, /You’re viewing Dana Tan’s paper — read-only\./);
    assert.doesNotMatch(page.text, /data-remark/);
    assert.doesNotMatch(page.text, /data-action="answer"/);
    assert.doesNotMatch(page.text, /data-action="delete-paper"/);
    assert.doesNotMatch(page.text, /id="checker-composer"/);
    const own = await dana.get(`/papers/${paperId}`).expect(200);
    assert.match(own.text, /data-action="answer"/);
  });
});

describe('answers and readiness (FR-ANS-04…15, FR-RDY-01…04)', () => {
  test('FR-ANS-04/07: PUT saves value + remark (idempotent) and returns readiness and the section status', async () => {
    const body = { value: 'yes', remark: 'Section 4.2' };
    const first = await put(dana, standards[0].id, body).expect(200);
    const second = await put(dana, standards[0].id, body).expect(200);
    assert.deepEqual(first.body.data.answer, { standardId: standards[0].id, ...body });
    assert.deepEqual(second.body.data.readiness, first.body.data.readiness);
    assert.equal(first.body.data.readiness.answered, 1);
    assert.equal(first.body.data.sectionStatus.done, 1);
    const cleared = await put(dana, standards[0].id, { value: null, remark: 'Section 4.2' }).expect(200);
    assert.equal(cleared.body.data.readiness.answered, 0); // clearing the answer (second click)
  });

  test('FR-ANS-05 / FR-RDY: No on a mandatory standard without a remark gives both gaps; the remark clears one', async () => {
    const mandatory = standards.find((s) => s.isMandatory);
    let res = await put(dana, mandatory.id, { value: 'no', remark: '' }).expect(200);
    const codes = res.body.data.readiness.gaps.map((g) => g.code);
    assert.deepEqual(codes, ['UNANSWERED', 'MANDATORY_NO', 'REMARK_MISSING']);
    assert.equal(res.body.data.sectionStatus.warn, 1);
    res = await put(dana, mandatory.id, { value: 'no', remark: 'CASB onboarding in Q1 (Dana)' }).expect(200);
    assert.deepEqual(
      res.body.data.readiness.gaps.map((g) => g.code),
      ['UNANSWERED', 'MANDATORY_NO'],
    );
  });

  test('validation: value yes / no / na / null; remark ≤ 2000; a standard of another type → 404', async () => {
    await put(dana, standards[1].id, { value: 'maybe', remark: '' }).expect(400);
    await put(dana, standards[1].id, { value: 'yes', remark: 'x'.repeat(2001) }).expect(400);
    const cloudStandard = (
      await db.query(
        'select s.id from standards s join sections sec on sec.id = s.section_id where sec.paper_type_id = $1 limit 1',
        [cloudId],
      )
    ).rows[0].id;
    const res = await put(dana, cloudStandard, { value: 'yes', remark: '' }).expect(404);
    assert.equal(res.body.error.code, 'STANDARD_NOT_FOUND');
  });

  test('FR-RDY-01: all answered Yes → Ready for committee; the home page agrees (FR-RDY-03)', async () => {
    for (const s of standards) await put(dana, s.id, { value: 'yes', remark: '' }).expect(200);
    const readiness = (await dana.get(`/api/papers/${paperId}/readiness`).expect(200)).body.data;
    assert.deepEqual([readiness.ready, readiness.answered, readiness.mandatoryMet, readiness.aiTip], [true, 33, 20, true]);
    const home = await dana.get('/papers').expect(200);
    assert.match(home.text, /✓ Ready for committee/);
  });

  test('FR-ANS-15: an added standard appears unanswered; a deleted one is hidden and its answer kept', async () => {
    const sectionId = (await db.query('select section_id from standards where id = $1', [standards[0].id])).rows[0].section_id;
    const added = await standardService.addStandard({ sectionId, title: 'Added later', actor: { name: 'Admin' }, log });
    let readiness = (await dana.get(`/api/papers/${paperId}/readiness`).expect(200)).body.data;
    assert.deepEqual([readiness.ready, readiness.total, readiness.gaps[0].text], [false, 34, '1 standard not answered']);

    await standardService.deleteStandard({ standardId: added.id, actor: { name: 'Admin' }, log });
    await standardService.deleteStandard({ standardId: standards[1].id, actor: { name: 'Admin' }, log });
    readiness = (await dana.get(`/api/papers/${paperId}/readiness`).expect(200)).body.data;
    assert.deepEqual([readiness.ready, readiness.total], [true, 32]);
    const kept = await db.query('select value from answers where paper_id = $1 and standard_id = $2', [paperId, standards[1].id]);
    assert.equal(kept.rows[0].value, 'yes');
    await standardService.restoreStandard({ standardId: standards[1].id, actor: { name: 'Admin' }, log });
  });

  test('FR-PAP-04: delete → 204; the paper disappears and its page is 404', async () => {
    const { body } = await dana.post('/api/papers').send({ title: 'Short lived', paperTypeId: saasId }).expect(201);
    await dana.delete(`/api/papers/${body.data.id}`).expect(204);
    assert.doesNotMatch((await dana.get('/papers').expect(200)).text, /Short lived/);
    await dana.get(`/papers/${body.data.id}`).set('Accept', 'text/html').expect(404);
    const row = await db.query('select deleted_at from papers where id = $1', [body.data.id]);
    assert.ok(row.rows[0].deleted_at, 'soft delete');
  });

  test('NFR-SEC-04: paper writes without the CSRF token are refused', async () => {
    const noToken = request.agent(app).set('X-Test-User', (await createUser()).id);
    await noToken.post('/api/papers').send({ title: 'No token', paperTypeId: saasId }).expect(403);
  });
});
