'use strict';

/**
 * AI checks end to end with fake providers (docs/12 §2.1 items 4, 6, 8; FR-AI-02…18, FR-CHAT, FR-RET).
 * No real AI calls: every provider here is a fake.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../../src/utils/db');
const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { main: seed } = require('../../db/seed/seed');
const { createWorker } = require('../../src/workers/checkWorker');
const checkService = require('../../src/services/check.service');
const retentionService = require('../../src/services/retention.service');
const standardService = require('../../src/services/standard.service');
const referenceService = require('../../src/services/reference.service');
const { FakeAiProvider } = require('../../src/providers/ai/fakeAiProvider');
const { setAiProviderForTests } = require('../../src/factories/aiProviderFactory');
const { getStorage } = require('../../src/factories/storageFactory');
const { fakeAuth } = require('../helpers/fakeAuth');
const { resetDb, createUser, closeDb, silentLog: log } = require('../helpers/db');
const { makePdf, PNG_BYTES, ENCRYPTED_PDF } = require('../helpers/files');

const app = createApp({ testAuth: fakeAuth });
const storage = getStorage();
const fake = new FakeAiProvider();

async function agentFor(user) {
  const agent = request.agent(app).set('X-Test-User', user.id);
  const html = (await agent.get('/papers').expect(200)).text;
  agent.set('X-CSRF-Token', html.match(/name="csrf-token" content="([^"]+)"/)[1]);
  return agent;
}

let owner;
let ownerUser;
let other;
let saasId;

async function newPaper(title = 'Checked paper') {
  const { body } = await owner.post('/api/papers').send({ title, paperTypeId: saasId }).expect(201);
  return body.data.id;
}

const pdfFile = async (pages = 3) => ({ buffer: await makePdf(pages), name: 'paper.pdf' });
const upload = (agent, paperId, files) => {
  let req = agent.post(`/api/papers/${paperId}/checks`);
  for (const f of files) req = req.attach('files', f.buffer, { filename: f.name, contentType: 'application/pdf' });
  return req;
};

/** Run the worker once and wait until the check is no longer queued / running. */
async function runWorker(checkId) {
  const worker = createWorker({ log });
  await worker.tick();
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await db.query('select status from checks where id = $1', [checkId]);
    if (!['queued', 'running'].includes(rows[0].status)) return rows[0].status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('check did not finish');
}

async function checkedPaper(title) {
  const paperId = await newPaper(title);
  const { body } = await upload(owner, paperId, [await pdfFile(4)]).expect(202);
  assert.equal(await runWorker(body.data.checkId), 'done');
  return { paperId, checkId: body.data.checkId };
}

before(async () => {
  await resetDb();
  storage.clear();
  await seed();
  ownerUser = await createUser({ name: 'Dana Tan' });
  owner = await agentFor(ownerUser);
  other = await agentFor(await createUser({ name: 'Sam Lee' }));
  saasId = (await db.query(`select id from paper_types where name = 'SaaS'`)).rows[0].id;
});
beforeEach(async () => {
  setAiProviderForTests(fake);
  // The owner starts many checks in this file; the hourly limit has its own test with its own user.
  if (ownerUser) {
    await db.query("update checks set created_at = created_at - interval '2 hours' where requested_by = $1", [ownerUser.id]);
  }
});
after(async () => {
  setAiProviderForTests(undefined);
  await closeDb();
});

describe('upload rejections (FR-AI-02, FR-AI-05, NFR-SEC-06)', () => {
  let paperId;
  before(async () => {
    paperId = await newPaper('Upload rules');
  });

  test('only non-PDF files → 415 naming them; a fake PDF (wrong magic bytes) too', async () => {
    const res = await upload(owner, paperId, [{ buffer: PNG_BYTES, name: 'diagram.png' }]).expect(415);
    assert.match(res.body.error.message, /Skipped: diagram\.png/);
    await upload(owner, paperId, [{ buffer: Buffer.from('MZ not a pdf'), name: 'x.pdf' }]).expect(415);
  });

  test('an encrypted PDF → 422 naming the file; too many pages → 413; more than 3 files → 400', async () => {
    const enc = await upload(owner, paperId, [{ buffer: ENCRYPTED_PDF, name: 'locked.pdf' }]).expect(422);
    assert.equal(enc.body.error.code, 'PDF_ENCRYPTED');
    assert.match(enc.body.error.message, /^locked\.pdf: /);
    const pages = await upload(owner, paperId, [await pdfFile(config.uploads.maxPages + 1)]).expect(413);
    assert.equal(pages.body.error.code, 'TOO_MANY_PAGES');
    const four = await Promise.all([1, 2, 3, 4].map(() => pdfFile(1)));
    await upload(owner, paperId, four).expect(400);
  });

  test('a file over the size limit → 413 FILE_TOO_LARGE; nothing is stored', async () => {
    const before = storage.objects.size;
    const big = Buffer.alloc(config.uploads.maxPaperMb * 1024 * 1024 + 1, 0x25);
    const res = await upload(owner, paperId, [{ buffer: big, name: 'big.pdf' }]).expect(413);
    assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
    assert.equal(storage.objects.size, before);
  });

  test('FR-AI-02/05: PDF + non-PDF → 202 with the skipped name; a second upload while it runs → 409', async () => {
    const res = await upload(owner, paperId, [await pdfFile(2), { buffer: PNG_BYTES, name: 'notes.png' }]).expect(202);
    assert.deepEqual([res.body.data.status, res.body.data.skipped], ['queued', ['notes.png']]);
    const again = await upload(owner, paperId, [await pdfFile(1)]).expect(409);
    assert.equal(again.body.error.code, 'CHECK_RUNNING');
    const status = await other.get(`/api/checks/${res.body.data.checkId}`).expect(200);
    assert.deepEqual([status.body.data.status, status.body.data.totalSteps, status.body.data.stepLabels[0]], ['queued', 4, 'Reading your PDF (2 pages)']);
    await runWorker(res.body.data.checkId);
  });

  test('FR-AI-18: a non-owner is refused before the upload is read', async () => {
    const res = await upload(other, paperId, [await pdfFile(1)]).expect(403);
    assert.equal(res.body.error.code, 'NOT_OWNER');
  });

  test('rate limit: more than RATE_LIMIT_CHECKS_PER_HOUR checks → 429', async () => {
    const user = await createUser({ name: 'Busy' });
    const busy = await agentFor(user);
    const { body } = await busy.post('/api/papers').send({ title: 'Busy paper', paperTypeId: saasId }).expect(201);
    for (let i = 0; i < config.checks.rateLimitPerHour; i += 1) {
      await db.query(`insert into checks (paper_id, requested_by, status) values ($1, $2, 'done')`, [body.data.id, user.id]);
    }
    const res = await upload(busy, body.data.id, [await pdfFile(1)]).expect(429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
  });
});

describe('the worker (docs/04 §7, FR-AI-03…16)', () => {
  test('a check is claimed once even with two workers in parallel', async () => {
    let calls = 0;
    setAiProviderForTests({
      ...fake,
      name: 'fake',
      model: 'counting',
      compareSection: async (input) => {
        calls += input.standards.length;
        await new Promise((r) => setTimeout(r, 20));
        return fake.compareSection(input);
      },
    });
    const paperId = await newPaper('Two workers');
    const { body } = await upload(owner, paperId, [await pdfFile(2)]).expect(202);
    const [a, b] = [createWorker({ log }), createWorker({ log })];
    await Promise.all([a.tick(), b.tick()]);
    await runWorker(body.data.checkId);
    assert.equal(calls, 33, 'every standard was sent once');
    const { rows } = await db.query('select count(*)::int as n from check_results where check_id = $1', [body.data.checkId]);
    assert.equal(rows[0].n, 33);
  });

  test('FR-AI-06/16: results per standard, provider / model / prompt version / tokens stored, report posted', async () => {
    const { paperId, checkId } = await checkedPaper('Stored results');
    const { rows } = await db.query('select provider, model, prompt_version, input_tokens, step from checks where id = $1', [checkId]);
    assert.deepEqual(rows[0].provider === 'fake' && rows[0].prompt_version === '1.0.0' && rows[0].step === 4, true);
    assert.ok(rows[0].input_tokens > 0);
    const latest = (await other.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    assert.equal(latest.results.length, 33);
    assert.deepEqual(Object.values(latest.counts).reduce((a, b) => a + b, 0), 33);
    assert.equal(latest.check.pdfsAvailable, true);
    const chat = (await other.get(`/api/papers/${paperId}/chat`).expect(200)).body.data.messages;
    assert.deepEqual(
      chat.map((m) => m.kind),
      ['files', 'report'],
    );
  });

  test('post-processing: unknown keys dropped, missing → none, pages clamped, HTML stripped (docs/07 §4)', async () => {
    setAiProviderForTests({
      name: 'fake',
      model: 'messy',
      compareSection: async (input) => {
        const results = input.standards.slice(1).map((s, i) => ({
          standardKey: s.key,
          verdict: 'partial',
          fileKey: 'P1',
          page: i === 0 ? 999 : 1,
          area: 'text',
          finding: `<b>Bold</b> claim <script>x()</script> ${'long '.repeat(80)}`,
          referenceKey: 'R99',
          referencePage: 1,
          confidence: null,
        }));
        results.push({ ...results[0], standardKey: 'S999' });
        return { raw: JSON.stringify({ results }), usage: { inputTokens: 1, outputTokens: 1 }, model: 'messy', promptVersion: '1.0.0' };
      },
    });
    const { paperId } = await checkedPaper('Messy AI');
    const latest = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    assert.equal(latest.results.length, 33, 'S999 dropped');
    const first = latest.results.find((r) => r.finding.startsWith('The AI did not return'));
    assert.equal(first.verdict, 'none', 'a standard without a result is "none"');
    const clamped = latest.results.find((r) => r.verdict === 'partial' && r.page === null);
    assert.ok(clamped, 'page 999 of a 4-page PDF becomes null');
    const cleaned = latest.results.find((r) => r.verdict === 'partial' && r.page === 1);
    assert.doesNotMatch(cleaned.finding, /<|>/);
    assert.ok(cleaned.finding.length <= 300);
    assert.equal(cleaned.referenceId, null, 'an unknown reference key is dropped');
  });

  test('docs/07 §6.4: invalid JSON is repaired once; a second invalid answer fails the check', async () => {
    let calls = 0;
    setAiProviderForTests({
      name: 'fake',
      model: 'repairing',
      compareSection: async (input) => {
        calls += 1;
        if (!input.repairNote) return { raw: '{ not json', usage: { inputTokens: 1, outputTokens: 1 }, model: 'repairing', promptVersion: '1.0.0' };
        return fake.compareSection(input);
      },
    });
    await checkedPaper('Repaired once');
    assert.ok(calls >= 2);

    setAiProviderForTests({
      name: 'fake',
      model: 'broken',
      compareSection: async () => ({ raw: { results: [{ verdict: 'great' }] }, usage: { inputTokens: 1, outputTokens: 1 }, model: 'broken', promptVersion: '1.0.0' }),
    });
    const paperId = await newPaper('Broken AI');
    const { body } = await upload(owner, paperId, [await pdfFile(1)]).expect(202);
    assert.equal(await runWorker(body.data.checkId), 'failed');
    const status = (await owner.get(`/api/checks/${body.data.checkId}`).expect(200)).body.data;
    assert.match(status.errorMessage, /^The check couldn’t finish: the AI gave an answer we could not use\. Try again\.$/);
    const chat = (await owner.get(`/api/papers/${paperId}/chat`).expect(200)).body.data.messages;
    assert.equal(chat.at(-1).kind, 'error');
  });

  test('FR-AI-14: a provider error fails the check with a friendly reason (no technical details)', async () => {
    setAiProviderForTests({
      name: 'fake',
      model: 'down',
      compareSection: async () => {
        const { AiProviderError } = require('../../src/utils/errors');
        throw new AiProviderError('socket hang up at 10.0.0.1', { code: 'AI_UNAVAILABLE' });
      },
    });
    const paperId = await newPaper('Provider down');
    const { body } = await upload(owner, paperId, [await pdfFile(1)]).expect(202);
    assert.equal(await runWorker(body.data.checkId), 'failed');
    const { rows } = await db.query('select error_code, error_message from checks where id = $1', [body.data.checkId]);
    assert.equal(rows[0].error_code, 'AI_UNAVAILABLE');
    assert.doesNotMatch(rows[0].error_message, /socket|10\.0\.0\.1/);
  });

  test('docs/04 §7 rule 4: a stuck check is failed by the sweep; its late results are then dropped', async () => {
    let release;
    setAiProviderForTests({
      name: 'fake',
      model: 'slow',
      compareSection: async (input) => {
        await new Promise((r) => {
          release = r;
        });
        return fake.compareSection(input);
      },
    });
    const paperId = await newPaper('Stuck');
    const { body } = await upload(owner, paperId, [await pdfFile(1)]).expect(202);
    await createWorker({ log }).tick();
    while (!release) await new Promise((r) => setTimeout(r, 10));
    await db.query(`update checks set started_at = now() - interval '1 hour' where id = $1`, [body.data.checkId]);
    assert.equal(await checkService.failStuckChecks(log), 1);
    release();
    await new Promise((r) => setTimeout(r, 300));
    const { rows } = await db.query(
      `select c.status, (select count(*)::int from check_results where check_id = c.id) as n from checks c where c.id = $1`,
      [body.data.checkId],
    );
    assert.deepEqual(rows[0], { status: 'failed', n: 0 });
    const chat = (await owner.get(`/api/papers/${paperId}/chat`).expect(200)).body.data.messages;
    assert.deepEqual(chat.filter((m) => m.kind === 'report').length, 0);
    assert.match(chat.at(-1).content.message, /took too long/);
  });

  test('FR-AI-13/15: Re-check uses the same files; a new standard → standardsChanged', async () => {
    const { paperId } = await checkedPaper('Recheck me');
    const sectionId = (await db.query('select id from sections where paper_type_id = $1 order by position limit 1', [saasId])).rows[0].id;
    const added = await standardService.addStandard({ sectionId, title: 'Added after the check', actor: { name: 'Admin' }, log });
    let latest = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    assert.equal(latest.standardsChanged, true);
    assert.ok(!latest.results.some((r) => r.standardId === added.id), 'no AI line for the new standard');
    const { body } = await owner.post(`/api/papers/${paperId}/checks/rerun`).expect(202);
    await runWorker(body.data.checkId);
    latest = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    assert.equal(latest.standardsChanged, false);
    assert.equal(latest.check.id, body.data.checkId, 'only the latest completed check drives the UI');
    await standardService.deleteStandard({ standardId: added.id, actor: { name: 'Admin' }, log });
  });
});

describe('acting on results (FR-AI-08…12)', () => {
  let paperId;
  let latest;
  before(async () => {
    ({ paperId } = await checkedPaper('Act on results'));
    latest = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
  });
  const resultOf = (verdict) => latest.results.find((r) => r.verdict === verdict);

  test('FR-AI-08: Yes against "gap" → an AI_CONFLICT gap; Keep mine resolves it (FR-AI-10)', async () => {
    const gap = resultOf('gap');
    const res = await owner.put(`/api/papers/${paperId}/answers/${gap.standardId}`).send({ value: 'yes', remark: '' }).expect(200);
    assert.ok(res.body.data.readiness.gaps.some((g) => g.code === 'AI_CONFLICT'));
    const kept = await owner.post(`/api/papers/${paperId}/results/${gap.standardId}/keep`).expect(200);
    assert.ok(!kept.body.data.readiness.gaps.some((g) => g.code === 'AI_CONFLICT'));
    assert.equal(kept.body.data.latest.results.find((r) => r.standardId === gap.standardId).kept, true);
  });

  test('FR-AI-09: Use AI answer — comply → Yes + citation only; gap → No + finding + citation', async () => {
    const comply = resultOf('comply');
    const a = (await owner.post(`/api/papers/${paperId}/results/${comply.standardId}/apply`).expect(200)).body.data.answer;
    assert.equal(a.value, 'yes');
    assert.match(a.remark, /^\[Paper p\.\d+ vs .+\]$/);
    const none = resultOf('none');
    const b = (await owner.post(`/api/papers/${paperId}/results/${none.standardId}/apply`).expect(200)).body.data.answer;
    assert.equal(b.value, 'no');
    assert.ok(b.remark.startsWith(none.finding));
  });

  test('FR-AI-12: Fill fills only the unanswered standards', async () => {
    const before = await db.query('select count(*)::int as n from answers where paper_id = $1 and value is not null', [paperId]);
    const res = (await owner.post(`/api/papers/${paperId}/results/apply-unanswered`).expect(200)).body.data;
    assert.equal(res.filled, 33 - before.rows[0].n);
    assert.equal(res.readiness.answered, 33);
    const gap = resultOf('gap');
    assert.equal(res.answers[gap.standardId].value, 'yes', 'answered standards are left alone');
  });

  test('a standard without a result → 404 NO_RESULT', async () => {
    const res = await owner.post(`/api/papers/${paperId}/results/00000000-0000-4000-8000-000000000000/apply`).expect(404);
    assert.equal(res.body.error.code, 'NO_RESULT');
  });
});

describe('chat (FR-CHAT-01…06)', () => {
  let paperId;
  before(async () => {
    ({ paperId } = await checkedPaper('Chatty'));
  });
  const say = (text) => owner.post(`/api/papers/${paperId}/chat`).send({ text });

  test('FR-CHAT-03: "#4", "standard 4" and "4" → compare card; an invalid number explains', async () => {
    for (const text of ['#4', 'standard 4', '4']) {
      const [question, reply] = (await say(text).expect(200)).body.data.messages;
      assert.deepEqual([question.content.text, reply.kind], [text, 'compare']);
    }
    const reply = (await say('#99').expect(200)).body.data.messages[1];
    assert.equal(reply.content.text, 'There’s no standard #99 — this paper type has 33.');
  });

  test('FR-CHAT-04: other questions go to the AI with the context, as plain text', async () => {
    setAiProviderForTests({ ...fake, name: 'fake', model: 'html', answerQuestion: async () => ({ text: '<b>Fix #4</b> first.', usage: {}, model: 'html' }) });
    const reply = (await say('What should I fix first?').expect(200)).body.data.messages[1];
    assert.equal(reply.content.text, 'Fix #4 first.');
  });

  test('FR-CHAT-04: before any check the AI is not asked', async () => {
    const fresh = await newPaper('No check yet');
    const reply = (await owner.post(`/api/papers/${fresh}/chat`).send({ text: 'Am I ready?' }).expect(200)).body.data.messages[1];
    assert.match(reply.content.text, /^Upload your paper PDF first/);
  });

  test('FR-CHAT-02: quick actions answer from the database', async () => {
    for (const action of ['gaps', 'refs', 'summary', 'compare']) {
      const [reply] = (await owner.post(`/api/papers/${paperId}/chat/quick`).send({ action }).expect(200)).body.data.messages;
      assert.equal(reply.kind, action);
    }
    await owner.post(`/api/papers/${paperId}/chat/quick`).send({ action: 'delete-all' }).expect(400);
  });

  test('FR-CHAT-05: 1–1000 characters; 20 messages per user per 10 minutes', async () => {
    await say('').expect(400);
    await say('x'.repeat(1001)).expect(400);
    await db.query(
      `insert into chat_messages (paper_id, role, kind, content)
       select $1, 'user', 'text', '{"text":"x"}' from generate_series(1, 20)`,
      [paperId],
    );
    assert.equal((await say('one more').expect(429)).body.error.code, 'RATE_LIMITED');
    assert.equal((await owner.post(`/api/papers/${paperId}/chat/quick`).send({ action: 'refs' }).expect(429)).body.error.code, 'RATE_LIMITED');
  });
});

describe('retention (FR-RET-01…03, FR-AI-17)', () => {
  test('PDFs and chat older than 7 days go; results and answers stay; Re-check needs a new upload', async () => {
    const { paperId } = await checkedPaper('Old paper');
    const latest = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    const doc = latest.check.documents[0];
    await owner.put(`/api/papers/${paperId}/answers/${latest.results[0].standardId}`).send({ value: 'yes', remark: 'kept' }).expect(200);
    const key = (await db.query('select s3_key from paper_documents where id = $1', [doc.id])).rows[0].s3_key;
    await other.get(`/files/documents/${doc.id}`).expect(200);

    await db.query(`update paper_documents set created_at = now() - interval '8 days' where paper_id = $1`, [paperId]);
    await db.query(`update chat_messages set created_at = now() - interval '8 days' where paper_id = $1`, [paperId]);
    const counts = await retentionService.run(log);
    assert.ok(counts.documents >= 1 && counts.chatMessages >= 2 && counts.errors === 0);
    assert.ok(!storage.objects.has(key), 'the S3 object is deleted');

    const after = (await owner.get(`/api/papers/${paperId}/checks/latest`).expect(200)).body.data;
    assert.deepEqual([after.results.length, after.check.pdfsAvailable], [33, false]);
    const answer = await db.query('select remark from answers where paper_id = $1', [paperId]);
    assert.equal(answer.rows[0].remark, 'kept');
    await other.get(`/files/documents/${doc.id}`).expect(404);
    assert.equal((await owner.post(`/api/papers/${paperId}/checks/rerun`).expect(409)).body.error.code, 'NO_DOCUMENTS');
    const readiness = (await owner.get(`/api/papers/${paperId}/readiness`).expect(200)).body.data;
    assert.equal(readiness.aiTip, true, 'FR-RDY-05: the tip comes back once the PDFs are gone');
  });

  test('soft-deleted papers and admin items older than 7 days are purged; newer ones stay', async () => {
    const { paperId } = await checkedPaper('Deleted paper');
    await owner.delete(`/api/papers/${paperId}`).expect(204);
    const recent = await newPaper('Deleted today');
    await owner.delete(`/api/papers/${recent}`).expect(204);
    await db.query(`update papers set deleted_at = now() - interval '8 days' where id = $1`, [paperId]);

    const ref = await referenceService.addReference({
      fields: { type: 'Guide', title: 'Old guide' },
      file: { buffer: await makePdf(1), originalname: 'g.pdf', size: 10, mimetype: 'application/pdf' },
      actor: { name: 'Admin' },
      log,
    });
    await referenceService.deleteReference({ referenceId: ref.id, actor: { name: 'Admin' }, log });
    await db.query(`update reference_docs set deleted_at = now() - interval '8 days' where id = $1`, [ref.id]);

    const counts = await retentionService.run(log);
    assert.ok(counts.papers >= 1 && counts.references >= 1, JSON.stringify(counts));
    const papers = await db.query('select id from papers where id = any($1::uuid[])', [[paperId, recent]]);
    assert.deepEqual(papers.rows.map((r) => r.id), [recent]);
    const leftovers = await db.query('select count(*)::int as n from answers where paper_id = $1', [paperId]);
    assert.equal(leftovers.rows[0].n, 0, 'answers, checks and results go with the paper');
    assert.ok(!storage.objects.has(ref.s3Key));
  });
});
