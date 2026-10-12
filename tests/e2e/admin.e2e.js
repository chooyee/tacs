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

  test('FR-ADM-02: New paper type dialog creates a type and opens its add box', async () => {
    await page.click('[data-action="new-type"]');
    await page.type('#nt-name', 'Data Platform');
    await Promise.all([page.waitForNavigation(), page.click('#new-type-form button[type=submit]')]);
    await settle(page);
    assert.ok(await page.$('.add-box textarea'), 'add box is open');
  });

  test('FR-ADM-16: Enter adds a standard and keeps the box open; Esc closes it', async () => {
    await openSaas();
    const before = await rows();
    await page.click('[data-section-id] [data-action="open-add"]');
    await page.type('.add-box textarea', 'Service accounts inventoried');
    await page.keyboard.press('Enter');
    await settle(page);
    await page.type('.add-box textarea', 'Guest access reviewed quarterly');
    await page.keyboard.press('Enter');
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);
    assert.equal(await rows(), before + 2);
    assert.equal(await page.$('.add-box'), null);
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

  test('FR-ADM-17: the edit dialog saves text and links', async () => {
    await page.evaluate(() => document.querySelector('.standard-row [data-action="edit-standard"]').click());
    await settle(page, 200);
    assert.ok(await page.$eval('#standard-dialog', (d) => d.open));
    await page.$eval('#sf-text', (t) => (t.value = 'SSO integration defined (edited)'));
    await page.click('#standard-form button[type=submit]');
    await settle(page);
    assert.equal(
      await page.$eval('.standard-row', (r) => r.dataset.text),
      'SSO integration defined (edited)',
    );
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
    await page.click('[data-action="add-section"]');
    await settle(page);
    assert.ok(await page.evaluate(() => document.activeElement.classList.contains('section-title')));
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

  test('FR-ADM-12: a reference can be uploaded through the dialog', async () => {
    const file = path.join(os.tmpdir(), `psc-e2e-${process.pid}.pdf`);
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    fs.writeFileSync(file, await doc.save());
    const before = await page.$$eval('#references-card [data-reference-id]', (r) => r.length);
    await page.click('[data-action="add-reference"]');
    await page.click('#reference-form .choice:nth-child(4)'); // Guide
    await page.type('#rf-title', 'E2E guide');
    await (await page.$('#rf-file')).uploadFile(file);
    await page.click('#reference-form button[type=submit]');
    await settle(page);
    fs.rmSync(file, { force: true });
    assert.equal(await page.$$eval('#references-card [data-reference-id]', (r) => r.length), before + 1);
  });

  test('the jump bar lists References and every section, and jumps there', async () => {
    await openSaas();
    const chips = await page.$$eval('#jump-chips .chip', (c) => c.map((x) => x.dataset.target));
    const sections = await page.$$eval('.admin-section', (s) => s.length);
    assert.equal(chips.length, sections + 1);
    assert.equal(chips[0], 'references-card');
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
