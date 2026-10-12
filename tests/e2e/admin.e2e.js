'use strict';

/**
 * Admin screens in a real browser (FR-ADM-01…19, FR-REF-02). Catches what HTTP tests cannot:
 * script errors, stale module imports, dialogs, keyboard flows, pdf.js under the CSP.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resetDb, closeDb } = require('../helpers/db');
const { main: seed } = require('../../db/seed/seed');
const { findBrowser, start, newPage, createAdmin, signIn, settle } = require('./browser');

const skip = findBrowser() ? false : 'No Chrome or Edge found (set CHROME_PATH)';

after(closeDb); // one database pool for the whole file

describe('admin editor in the browser', { skip }, () => {
  let env;
  let page;

  before(async () => {
    await resetDb();
    await seed();
    await createAdmin();
    env = await start();
    page = await newPage(env.browser);
    await signIn(page, env.base);
  });
  after(() => env?.close());

  const rows = () => page.$$eval('.standard-row', (r) => r.length);

  /** Open the SaaS editor fresh. */
  async function openSaas() {
    await page.goto(`${env.base}/admin/types`);
    const href = await page.$$eval(
      'a.tile',
      (as) => as.find((a) => a.querySelector('.tile-name').textContent === 'SaaS').href,
    );
    await page.goto(href);
    await settle(page);
  }

  test('FR-ADM-01: the paper types page lists the seeded types', async () => {
    await page.goto(`${env.base}/admin/types`);
    const names = await page.$$eval('a.tile .tile-name', (b) => b.map((x) => x.textContent.trim()));
    assert.deepEqual(names.sort(), ['Cloud Platform', 'Infrastructure', 'SaaS']);
  });

  test('FR-ADM-02: the New paper type dialog creates a type and opens its editor', async () => {
    await page.click('[data-action="new-type"]');
    await page.type('#nt-name', 'Data Platform');
    await Promise.all([page.waitForNavigation(), page.click('#new-type-form button[type=submit]')]);
    await settle(page);
    assert.match(new URL(page.url()).pathname, /^\/admin\/types\/[0-9a-f-]{36}$/);
    assert.deepEqual(await page.$$eval('.section-title', (t) => t.map((x) => x.value)), ['General']);
  });

  test('FR-ADM-16 / D-38: Add standard opens the full-screen form; it saves title, description, mandatory and references', async () => {
    await openSaas();
    const before = await rows();
    await Promise.all([page.waitForNavigation(), page.click('.admin-section .add-link')]);
    await settle(page);
    await page.type('#sf-title', 'Service accounts inventoried');
    await page.click('#sf-description .ql-editor');
    await page.keyboard.type('Every service account is listed with an owner.');
    await page.click('#sf-mandatory');
    await page.type('#ref-search', 'policy');
    await settle(page, 200);
    await page.click('#ref-results .picker-row input');
    assert.equal(await page.$eval('#ref-count', (c) => c.textContent), '1');
    await Promise.all([page.waitForNavigation(), page.click('#standard-form button[type=submit]')]);
    await settle(page);
    assert.equal(await rows(), before + 1);
    const added = await page.$eval(
      '.standard-row:has(.std-title-link)',
      () => [...document.querySelectorAll('.std-title-link')].find((a) => a.textContent.includes('Service accounts inventoried'))?.closest('.standard-row').dataset.mandatory,
    );
    assert.equal(added, 'true');
    const numbers = await page.$$eval('.std-number', (n) => n.map((x) => Number(x.textContent)));
    assert.ok(
      numbers.every((n, i) => n === i + 1),
      'numbered 1…N',
    );
  });

  test('FR-ADM-15: the optional / MANDATORY tag toggles', async () => {
    const state = () => page.$$eval('.standard-row', (r) => r[4].dataset.mandatory);
    const before = await state();
    await page.evaluate(() =>
      document.querySelectorAll('.standard-row [data-action="toggle-mandatory"]')[4].click(),
    );
    await settle(page);
    assert.notEqual(await state(), before);
  });

  test('FR-ADM-17 / D-38: the standard form edits the title; the editor shows it', async () => {
    await Promise.all([page.waitForNavigation(), page.click('.standard-row .std-title-link')]);
    await settle(page);
    await page.$eval('#sf-title', (t) => {
      t.value = 'SSO integration defined (edited)';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await Promise.all([page.waitForNavigation(), page.click('#standard-form button[type=submit]')]);
    await settle(page);
    assert.equal(await page.$eval('.standard-row .std-title-link', (a) => a.textContent.trim()), 'SSO integration defined (edited)');
  });

  test('FR-ADM-18: delete shows Undo, which brings the standard back', async () => {
    const before = await rows();
    await page.evaluate(() =>
      document.querySelectorAll('.standard-row [data-action="delete-standard"]')[1].click(),
    );
    await settle(page);
    assert.equal(await rows(), before - 1);
    await page.click('.toast [data-variant="outline"]');
    await settle(page);
    assert.equal(await rows(), before);
  });

  test('FR-ADM-14: add section selects its title for renaming', async () => {
    const before = await page.$$eval('.admin-section', (s) => s.length);
    // element.click(): a mouse click can land on the sticky jump bar when the page is scrolled
    await page.$eval('[data-action="add-section"]', (b) => b.click());
    await settle(page);
    const focused = await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className} ${location.hash}`);
    assert.ok(focused.includes('section-title'), focused);
    await page.keyboard.type('Network');
    await page.keyboard.press('Enter');
    await settle(page);
    const titles = await page.$$eval('.section-title', (t) => t.map((x) => x.value));
    assert.equal(titles.length, before + 1);
    assert.equal(titles.at(-1), 'Network');
  });

  test('FR-REF-02: the reference viewer renders the PDF with pdf.js under the CSP', async () => {
    await page.click('#references-card [data-action="view-reference"]');
    await page.waitForFunction(() => !document.querySelector('#rv-canvas').hidden, { timeout: 10_000 });
    assert.ok(await page.$eval('#rv-canvas', (c) => c.width > 0));
    await page.keyboard.press('Escape');
  });

  test('FR-ADM-12 / D-39: a reference is added on its full-screen form with a file and links', async () => {
    const file = path.join(os.tmpdir(), `psc-e2e-${process.pid}.pdf`);
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    fs.writeFileSync(file, await doc.save());
    await page.goto(`${env.base}/admin/references`);
    const before = await page.$$eval('.ref-row', (r) => r.length);
    await Promise.all([page.waitForNavigation(), page.click('a[href="/admin/references/new"]')]);
    await settle(page);
    await page.click('#reference-form .choice:nth-child(4)'); // Guide
    await page.type('#rf-title', 'E2E guide');
    await (await page.$('#rf-file')).uploadFile(file);
    await page.click('#rf-add-link');
    await page.type('#rf-link-label-0', 'Policy Hub');
    await page.type('#rf-link-url-0', 'https://intranet.example.com/e2e');
    assert.equal(await page.$eval('#pv-chip', (c) => c.textContent), 'Guide · E2E guide');
    await Promise.all([page.waitForNavigation(), page.click('#reference-form button[type=submit]')]);
    await settle(page);
    fs.rmSync(file, { force: true });
    assert.deepEqual(await page.$$eval('[data-key="url"]', (i) => i.map((x) => x.value)), ['https://intranet.example.com/e2e']);
    await page.goto(`${env.base}/admin/references`);
    assert.equal(await page.$$eval('.ref-row', (r) => r.length), before + 1);
    await openSaas();
  });

  test('D-42: the References card is under the Standards card; the jump bar lists the sections, then References', async () => {
    await openSaas();
    const chips = await page.$$eval('#jump-chips .chip', (c) => c.map((x) => x.dataset.target));
    const sections = await page.$$eval('.admin-section', (s) => s.length);
    assert.equal(chips.length, sections + 1);
    assert.equal(chips.at(-1), 'references-card');
    assert.ok(
      await page.evaluate(() => document.querySelector('#standards-card').compareDocumentPosition(document.querySelector('#references-card')) & Node.DOCUMENT_POSITION_FOLLOWING),
      'References comes after Standards',
    );
    // A middle section: the last one may sit too low on the page to reach the top.
    await page.click('#jump-chips .chip:nth-child(3)');
    await settle(page, 800);
    const top = await page.$eval(`#${chips[2]}`, (el) => el.getBoundingClientRect().top);
    assert.ok(top < 250, `section scrolled near the top (top=${top})`);
  });

  test('every autosave shows "Saved" in the header', async () => {
    await page.click('[data-field="description"]', { clickCount: 3 });
    await page.keyboard.type('Vendor-hosted software');
    await page.waitForFunction(() => document.querySelector('.save-state').dataset.state === 'saved', {
      timeout: 5000,
    });
  });

  test('no script errors or failed requests on any of the above', () => {
    assert.deepEqual(page.problems, []);
  });
});

describe('phone width (docs/03 §2: no horizontal scrolling ≥ 320 px)', { skip }, () => {
  let env;
  before(async () => {
    env = await start();
  });
  after(() => env?.close());

  for (const width of [320, 390]) {
    test(`admin pages fit ${width} px without sideways scrolling`, async () => {
      const page = await newPage(env.browser, { width, height: 800 });
      await signIn(page, env.base);
      const urls = ['/admin/types', '/admin/users'];
      await page.goto(`${env.base}/admin/types`);
      urls.push(new URL(await page.$eval('a.tile', (a) => a.href)).pathname);
      for (const url of urls) {
        await page.goto(`${env.base}${url}`);
        await settle(page, 200);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${url} is ${overflow}px too wide at ${width}px`);
      }
      await page.close();
    });
  }
});
