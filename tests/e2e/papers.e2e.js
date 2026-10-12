'use strict';

/**
 * The architect side in a real browser (FR-PAP, FR-ANS, FR-RDY, FR-AI, FR-CHAT): what HTTP tests
 * cannot see — script errors, the live readiness panel, filters, the AI checker panel, pdf.js page
 * previews under the CSP, the read-only view. The AI is the fake provider (no network).
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const db = require('../../src/utils/db');
const { resetDb, createUser, closeDb, silentLog } = require('../helpers/db');
const { fakeAuth } = require('../helpers/fakeAuth');
const { main: seed } = require('../../db/seed/seed');
const { createWorker } = require('../../src/workers/checkWorker');
const { findBrowser, start, newPage, settle } = require('./browser');

const skip = findBrowser() ? false : 'No Chrome or Edge found (set CHROME_PATH)';

after(closeDb);

describe('papers and the AI checker in the browser', { skip }, () => {
  let env;
  let page;
  let worker;
  let paperUrl;
  let danaId;
  let samId;
  const pdfPath = path.join(os.tmpdir(), `psc-e2e-paper-${process.pid}.pdf`);
  const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
  // element.click(): a mouse click can land on the sticky bars when the page is scrolled
  const click = (sel) => page.$eval(sel, (e) => e.click());

  before(async () => {
    await resetDb();
    await seed();
    danaId = (await createUser({ name: 'Dana Tan' })).id;
    samId = (await createUser({ name: 'Sam Lee' })).id;
    env = await start({ testAuth: fakeAuth });
    worker = createWorker({ log: silentLog });
    worker.start();
    page = await newPage(env.browser, { userId: danaId });
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i += 1) doc.addPage([400, 560]);
    fs.writeFileSync(pdfPath, await doc.save());
  });
  after(async () => {
    await worker?.stop();
    await env?.close();
    fs.rmSync(pdfPath, { force: true });
  });

  test('FR-PAP-02: New paper creates the paper and opens it', async () => {
    await page.goto(`${env.base}/papers`);
    await click('[data-action="new-paper"]');
    await page.type('#np-title', 'Contract Management SaaS');
    const saas = await page.$$eval('#new-paper-form .check-card', (cards) =>
      cards.findIndex((c) => c.querySelector('b').textContent === 'SaaS'),
    );
    await page.click(`#new-paper-form .check-card:nth-child(${saas + 1}) input`);
    await Promise.all([page.waitForNavigation(), page.click('#new-paper-form [type=submit]')]);
    await settle(page);
    paperUrl = page.url();
    assert.match(paperUrl, /\/papers\/[0-9a-f-]{36}$/);
    assert.equal(await text('#head-pill'), 'Not started');
    assert.equal(await page.$$eval('.answer-row', (r) => r.length), 33);
  });

  test('FR-ANS-05: No moves focus to the remark and turns the row red; a remark clears it and saves', async () => {
    const id = await page.$$eval('.answer-row', (rows) => rows.find((r) => r.querySelector('.mtag')).dataset.standardId);
    await click(`#std-${id} [data-value="no"]`);
    await settle(page, 300);
    assert.ok(await page.$eval(`#std-${id}`, (r) => r.classList.contains('need-remark')));
    assert.ok(await page.evaluate((sid) => document.activeElement === document.querySelector(`#std-${sid} [data-remark]`), id));
    const gaps = await page.$$eval('#ready-card .gap-list button', (b) => b.map((x) => x.textContent));
    assert.ok(gaps.some((g) => g.startsWith('Explain your')));
    await page.keyboard.type('CASB onboarding planned for Q1 (Dana)');
    await page.waitForFunction((sid) => document.querySelector(`#std-${sid} .remark-state`).textContent === 'Saved', { timeout: 5000 }, id);
    assert.ok(!(await page.$eval(`#std-${id}`, (r) => r.classList.contains('need-remark'))));
  });

  test('FR-ANS-09/11: the To do filter keeps a just-answered row visible until the filter changes', async () => {
    await click('[data-action="filter"][data-filter="todo"]');
    const first = await page.$$eval('.answer-row', (rows) => rows.find((r) => !r.hidden).dataset.standardId);
    await click(`#std-${first} [data-value="yes"]`);
    await settle(page, 300);
    assert.ok(await page.$eval(`#std-${first}`, (r) => !r.hidden));
    await click('[data-action="filter"][data-filter="all"]');
    await click('[data-action="filter"][data-filter="todo"]');
    assert.ok(await page.$eval(`#std-${first}`, (r) => r.hidden));
    await click('[data-action="filter"][data-filter="all"]');
  });

  test('FR-AI-02/03/07: uploading in the checker runs a check; AI lines and the report appear', async () => {
    assert.equal(await text('#checker-badge'), 'Not checked');
    await click('#checker-fab');
    await settle(page, 300);
    assert.match(await text('#checker-messages .msg.assistant'), /^Hi Dana 👋/);
    await (await page.$('#checker-files')).uploadFile(pdfPath);
    await page.waitForFunction(() => /Check finished/.test(document.querySelector('#checker-messages').textContent), {
      timeout: 20_000,
    });
    await settle(page, 500);
    assert.equal(await page.$$eval('.ai-line:not([hidden])', (l) => l.length), 33);
    assert.match(await text('#checker-bar'), /psc-e2e-paper-\d+\.pdf · 3 pages · removed in 7 days/);
    await page.keyboard.press('Escape');
  });

  test('FR-AI-08/10: Yes against a "Does not comply" result is an issue; Keep mine resolves it', async () => {
    const id = await page.$$eval('.ai-line', (l) => l.find((x) => x.dataset.verdict === 'gap').closest('.answer-row').dataset.standardId);
    await click(`#std-${id} [data-value="yes"]`);
    await settle(page, 500);
    assert.match(await text(`#std-${id} .ai-line .issue`), /doesn’t back up your “Yes”/);
    assert.match(await text('#checker-badge'), /to fix/);
    await click(`#std-${id} [data-action="keep-mine"]`);
    await settle(page, 500);
    assert.match(await text(`#std-${id} .ai-line`), /You kept your answer/);
  });

  test('FR-AI-11: Compare side by side renders both pages with pdf.js and outlines them', async () => {
    const id = await page.$$eval('.ai-line', (l) => l.find((x) => x.dataset.verdict === 'comply').closest('.answer-row').dataset.standardId);
    await click(`#std-${id} [data-action="compare"]`);
    await page.waitForFunction(() => document.querySelector('#cmp-paper canvas')?.width > 0, { timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('#cmp-ref canvas, #cmp-ref img'), { timeout: 10_000 });
    assert.equal(await page.$$eval('#compare-dialog .cmp-mark', (m) => m.length), 2);
    await page.keyboard.press('Escape');
  });

  test('FR-CHAT-03: "#4" in the chat shows the compare card', async () => {
    await click('#checker-fab');
    await page.type('#checker-input', '#4');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('#checker-messages .cmp-card')].some((c) => /#4/.test(c.textContent)), {
      timeout: 5000,
    });
    await page.keyboard.press('Escape');
  });

  test('FR-PAP-08: another architect sees a read-only page and the chat history only', async () => {
    const other = await newPage(env.browser, { userId: samId });
    await other.goto(paperUrl);
    await settle(other);
    assert.match(await other.$eval('.banner', (b) => b.textContent), /Dana Tan’s paper — read-only/);
    assert.equal(await other.$$eval('.answer-row input, .answer-row .yn, [data-action="apply-ai"]', (e) => e.length), 0);
    await other.$eval('#checker-fab', (b) => b.click());
    await settle(other, 800);
    assert.equal(await other.$('#checker-composer'), null);
    assert.ok((await other.$$eval('#checker-messages .msg', (m) => m.length)) > 2);
    assert.deepEqual(other.problems, []);
    await other.close();
  });

  test('phone width: the paper page and the checker fit 390 px', async () => {
    const phone = await newPage(env.browser, { userId: danaId, width: 390, height: 844 });
    await phone.goto(paperUrl);
    await settle(phone);
    await phone.$eval('#checker-fab', (b) => b.click());
    await settle(phone, 500);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.ok(await phone.$eval('#checker', (c) => c.getBoundingClientRect().width >= 389));
    await phone.close();
  });

  test('no script errors or failed requests on any of the above', async () => {
    assert.deepEqual(page.problems, []);
    const { rows } = await db.query(`select count(*)::int as n from checks where status = 'done'`);
    assert.equal(rows[0].n, 1);
  });
});
