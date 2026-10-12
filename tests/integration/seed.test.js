'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const db = require('../../src/utils/db');
const paperTypeService = require('../../src/services/paperType.service');
const { getStorage } = require('../../src/factories/storageFactory');
const { main: seed, placeholderPdf } = require('../../db/seed/seed');
const { resetDb, closeDb } = require('../helpers/db');

before(async () => {
  await resetDb();
  getStorage().clear();
});
after(closeDb);

describe('npm run seed (docs/05 §6, D-31)', () => {
  test('loads SaaS (33 standards in 5 sections), Cloud Platform and Infrastructure', async () => {
    await seed();
    const types = await paperTypeService.listTypes();
    const byName = Object.fromEntries(types.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ['Cloud Platform', 'Infrastructure', 'SaaS']);
    assert.deepEqual(
      [byName.SaaS.standardsCount, byName.SaaS.mandatoryCount, byName.SaaS.referencesCount],
      [33, 20, 10], // mandatory: 8 + 3 + 3 + 4 + 2 (prototype seedTypes)
    );
    assert.deepEqual(
      [byName['Cloud Platform'].standardsCount, byName.Infrastructure.standardsCount],
      [12, 9],
    );

    const saas = await paperTypeService.getEditor(byName.SaaS.id);
    assert.equal(saas.sections.length, 5);
    assert.deepEqual(
      [saas.sections[0].letter, saas.sections[0].title],
      ['A', 'Identity & Access Management'],
    );
    const casb = saas.sections[0].standards.find((s) => s.number === 3);
    assert.equal(casb.title, 'CASB protection implemented for all user access');
    assert.deepEqual(casb.references.map((r) => r.title).sort(), [
      'CASB reference architecture',
      'SaaS Security Policy v3',
    ]);
  });

  test('every reference has a readable placeholder PDF in storage', async () => {
    const { rows } = await db.query('select s3_key, page_count, mime_type from reference_docs');
    assert.equal(rows.length, 17);
    for (const row of rows) {
      assert.equal(row.mime_type, 'application/pdf');
      assert.equal(row.page_count, 1);
      assert.ok(getStorage().objects.has(row.s3_key), row.s3_key);
    }
    // The seed's file names are readable (they were all ".pdf" before the fix).
    const names = await db.query('select file_name from reference_docs');
    assert.ok(names.rows.every((r) => /^[\w.-]+\.pdf$/.test(r.file_name) && r.file_name.length > 4));
  });

  test('running it again changes nothing (idempotent)', async () => {
    await seed();
    const { rows } = await db.query('select count(*)::int as n from paper_types where deleted_at is null');
    assert.equal(rows[0].n, 3);
  });

  test('placeholder PDFs survive characters the PDF font lacks', async () => {
    const pdf = await placeholderPdf({
      type: 'Guide',
      title: 'Arrows ↗ and emoji 🧭',
      note: 'Roles × permissions — ok',
    });
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  });
});
