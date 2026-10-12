'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/utils/db');
const paperTypeService = require('../../src/services/paperType.service');
const sectionService = require('../../src/services/section.service');
const standardService = require('../../src/services/standard.service');
const referenceService = require('../../src/services/reference.service');
const { getStorage } = require('../../src/factories/storageFactory');
const {
  ConflictError,
  ValidationError,
  FileRejectedError,
  NotFoundError,
} = require('../../src/utils/errors');
const { resetDb, createUser, silentLog: log, closeDb } = require('../helpers/db');
const { makePdf, PNG_BYTES, ENCRYPTED_PDF } = require('../helpers/files');

const storage = getStorage(); // MemoryStorage in tests

/** A multer-like file object. */
const upload = async (buffer, name = 'policy.pdf') => ({
  buffer: buffer ?? (await makePdf(2)),
  originalname: name,
  size: (buffer ?? Buffer.alloc(0)).length,
  mimetype: 'application/pdf',
});

/** A new type with sections A (2 standards) and B (1 standard) and two references. */
async function buildType(name) {
  const { id } = await paperTypeService.createType({ name, log });
  const [general] = (await paperTypeService.getEditor(id)).sections;
  const second = await sectionService.addSection({ typeId: id, title: 'Security', log });
  const s1 = await standardService.addStandard({ sectionId: general.id, text: 'SSO defined', log });
  const s2 = await standardService.addStandard({ sectionId: general.id, text: 'MFA enforced', log });
  const s3 = await standardService.addStandard({ sectionId: second.id, text: 'Logs in SIEM', log });
  const policy = await referenceService.addReference({
    typeId: id,
    fields: { type: 'Policy', title: 'Identity Standard', note: 'Look for SSO' },
    file: await upload(),
    log,
  });
  const sample = await referenceService.addReference({
    typeId: id,
    fields: { type: 'Sample', title: 'Diagram', url: 'https://intranet/x' },
    file: await upload(PNG_BYTES, 'diagram.png'),
    log,
  });
  await standardService.updateStandard({
    standardId: s1.id,
    isMandatory: true,
    referenceIds: [policy.id, sample.id],
    log,
  });
  return { id, general, second, s1, s2, s3, policy, sample };
}

before(async () => {
  await resetDb();
  storage.clear();
});
after(closeDb);

describe('paper types (FR-ADM-01…03, FR-ADM-10)', () => {
  test('FR-ADM-02: a blank type starts with one "General" section', async () => {
    const { id, url } = await paperTypeService.createType({ name: 'Blank One', description: 'When X', log });
    assert.equal(url, `/admin/types/${id}`);
    const editor = await paperTypeService.getEditor(id);
    assert.deepEqual(
      editor.sections.map((s) => [s.letter, s.title]),
      [['A', 'General']],
    );
    assert.equal(editor.type.description, 'When X');
  });

  test('FR-ADM-02: names are unique among types, ignoring case', async () => {
    await assert.rejects(
      paperTypeService.createType({ name: 'blank one', log }),
      (err) => err instanceof ConflictError && err.code === 'NAME_TAKEN',
    );
  });

  test('FR-ADM-01: the list shows standards, mandatory, references and papers counts', async () => {
    const built = await buildType('Stats Type');
    const card = (await paperTypeService.listTypes()).find((t) => t.id === built.id);
    assert.deepEqual(
      { s: card.standardsCount, m: card.mandatoryCount, r: card.referencesCount, p: card.papersCount },
      { s: 3, m: 1, r: 2, p: 0 },
    );
  });

  test('FR-ADM-10: name and description autosave; a taken name is refused', async () => {
    const { id } = await paperTypeService.createType({ name: 'Rename Me', log });
    const updated = await paperTypeService.updateType({
      typeId: id,
      name: 'Renamed',
      description: null,
      log,
    });
    assert.deepEqual([updated.name, updated.description], ['Renamed', null]);
    await assert.rejects(
      paperTypeService.updateType({ typeId: id, name: 'Stats Type', log }),
      /already exists/,
    );
  });

  test('FR-ADM-02: copy duplicates sections, standards, mandatory flags, references (new S3 files) and links', async () => {
    const source = await buildType('Copy Source');
    const { id } = await paperTypeService.createType({ name: 'Copy Target', copyFromTypeId: source.id, log });
    const [from, to] = await Promise.all([
      paperTypeService.getEditor(source.id),
      paperTypeService.getEditor(id),
    ]);

    assert.deepEqual(
      to.sections.map((s) => [
        s.title,
        s.standards.map((x) => [x.number, x.text, x.isMandatory, x.references.length]),
      ]),
      from.sections.map((s) => [
        s.title,
        s.standards.map((x) => [x.number, x.text, x.isMandatory, x.references.length]),
      ]),
    );
    // New reference rows, linked to the NEW references, with their own files.
    const newRefIds = to.references.map((r) => r.id);
    assert.ok(to.sections[0].standards[0].references.every((r) => newRefIds.includes(r.id)));
    assert.ok(newRefIds.every((rid) => !from.references.some((r) => r.id === rid)));
    const { rows } = await db.query('select s3_key from reference_docs where paper_type_id = $1', [id]);
    for (const { s3_key: key } of rows) {
      assert.ok(key.startsWith(`references/${id}/`), key);
      assert.ok(storage.objects.has(key), `copied object ${key}`);
    }
  });

  test('FR-ADM-03: a type used by a paper cannot be deleted; an unused one can', async () => {
    const used = await buildType('Used Type');
    const owner = await createUser();
    await db.query(`insert into papers (owner_id, paper_type_id, title) values ($1, $2, 'A paper')`, [
      owner.id,
      used.id,
    ]);
    await assert.rejects(
      paperTypeService.deleteType({ typeId: used.id, log }),
      (err) => err.code === 'TYPE_IN_USE' && /1 paper/.test(err.message),
    );
    assert.equal((await paperTypeService.getEditor(used.id)).papersInProgress, 1);

    const { id } = await paperTypeService.createType({ name: 'Unused Type', log });
    await paperTypeService.deleteType({ typeId: id, log });
    assert.ok(!(await paperTypeService.listTypes()).some((t) => t.id === id));
    await assert.rejects(paperTypeService.getEditor(id), NotFoundError);
    // The name of a deleted type can be used again.
    await paperTypeService.createType({ name: 'Unused Type', log });
  });
});

describe('sections and standards (FR-ADM-14…19, FR-ANS-02)', () => {
  let t;
  before(async () => {
    t = await buildType('Editor Type');
  });

  test('FR-ANS-02: standards are numbered 1…N across sections', async () => {
    const editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections.map((s) => s.standards.map((x) => [x.number, x.text])),
      [
        [
          [1, 'SSO defined'],
          [2, 'MFA enforced'],
        ],
        [[3, 'Logs in SIEM']],
      ],
    );
  });

  test('FR-ADM-19: move swaps with the neighbour; the first cannot move up', async () => {
    await standardService.moveStandard({ standardId: t.s2.id, direction: 'up', log });
    let editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections[0].standards.map((x) => x.text),
      ['MFA enforced', 'SSO defined'],
    );
    await assert.rejects(
      standardService.moveStandard({ standardId: t.s2.id, direction: 'up', log }),
      (err) => err.code === 'CANNOT_MOVE',
    );
    await sectionService.moveSection({ sectionId: t.second.id, direction: 'up', log });
    editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections.map((s) => [s.letter, s.title]),
      [
        ['A', 'Security'],
        ['B', 'General'],
      ],
    );
    assert.equal(editor.sections[0].standards[0].number, 1); // numbering follows the new order
    await sectionService.moveSection({ sectionId: t.second.id, direction: 'down', log }); // back
  });

  test('FR-ADM-18: deleting a section hides its standards; Undo brings back only those', async () => {
    const extra = await standardService.addStandard({ sectionId: t.second.id, text: 'Deleted earlier', log });
    await standardService.deleteStandard({ standardId: extra.id, log });
    await sectionService.deleteSection({ sectionId: t.second.id, log });

    let editor = await paperTypeService.getEditor(t.id);
    assert.equal(editor.sections.length, 1);
    assert.equal(editor.totals.standards, 2);
    await assert.rejects(
      standardService.restoreStandard({ standardId: t.s3.id, log }),
      (err) => err.code === 'SECTION_DELETED',
    );

    await sectionService.restoreSection({ sectionId: t.second.id, log });
    editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections[1].standards.map((x) => x.text),
      ['Logs in SIEM'], // "Deleted earlier" stays deleted
    );
    await assert.rejects(sectionService.restoreSection({ sectionId: t.second.id, log }), /not deleted/);
  });

  test('FR-ADM-18: a deleted standard can be restored', async () => {
    await standardService.deleteStandard({ standardId: t.s3.id, log });
    assert.equal((await paperTypeService.getEditor(t.id)).totals.standards, 2);
    await standardService.restoreStandard({ standardId: t.s3.id, log });
    assert.equal((await paperTypeService.getEditor(t.id)).totals.standards, 3);
  });

  test('FR-ADM-17: referenceIds replace the link set; references of another type are refused', async () => {
    await standardService.updateStandard({ standardId: t.s1.id, referenceIds: [t.policy.id], log });
    let editor = await paperTypeService.getEditor(t.id);
    const s1 = editor.sections[0].standards.find((x) => x.id === t.s1.id);
    assert.deepEqual(
      s1.references.map((r) => r.title),
      ['Identity Standard'],
    );

    const other = await buildType('Other Type');
    await assert.rejects(
      standardService.updateStandard({ standardId: t.s1.id, referenceIds: [other.policy.id], log }),
      ValidationError,
    );
    editor = await paperTypeService.getEditor(t.id);
    assert.equal(editor.sections[0].standards.find((x) => x.id === t.s1.id).references.length, 1); // unchanged
  });

  test('FR-ADM-21: more than 4 references gives a (non-blocking) warning', async () => {
    const ids = [t.policy.id, t.sample.id];
    for (let i = 0; i < 3; i += 1) {
      const ref = await referenceService.addReference({
        typeId: t.id,
        fields: { type: 'Guide', title: `Guide ${i}` },
        file: await upload(),
        log,
      });
      ids.push(ref.id);
    }
    const { warnings } = await standardService.updateStandard({
      standardId: t.s2.id,
      referenceIds: ids,
      log,
    });
    assert.equal(warnings.length, 1);
    const ok = await standardService.updateStandard({
      standardId: t.s2.id,
      referenceIds: ids.slice(0, 4),
      log,
    });
    assert.deepEqual(ok.warnings, []);
  });

  test('FR-ADM-15: toggling mandatory keeps the text', async () => {
    const { standard } = await standardService.updateStandard({
      standardId: t.s3.id,
      isMandatory: true,
      log,
    });
    assert.deepEqual([standard.text, standard.isMandatory], ['Logs in SIEM', true]);
  });
});

describe('references (FR-ADM-11…13, FR-REF-02, FR-REF-04, NFR-SEC-06)', () => {
  let t;
  before(async () => {
    t = await buildType('Reference Type');
  });

  test('NFR-SEC-06: the S3 key is generated; the original name is display only', async () => {
    const ref = await referenceService.addReference({
      typeId: t.id,
      fields: { type: 'Template', title: 'Tricky' },
      file: await upload(undefined, '..\\..\\evil/../name.pdf'),
      log,
    });
    assert.match(ref.s3Key, new RegExp(`^references/${t.id}/[0-9a-f-]{36}\\.pdf$`));
    assert.equal(ref.fileName, 'name.pdf');
    assert.equal(ref.pageCount, 2);
  });

  test('FR-ADM-12: the file is required; bad files are refused and nothing is stored', async () => {
    const before = storage.objects.size;
    await assert.rejects(
      referenceService.addReference({ typeId: t.id, fields: { type: 'Policy', title: 'x' }, log }),
      ValidationError,
    );
    await assert.rejects(
      referenceService.addReference({
        typeId: t.id,
        fields: { type: 'Policy', title: 'x' },
        file: await upload(ENCRYPTED_PDF),
        log,
      }),
      (err) => err instanceof FileRejectedError && err.code === 'PDF_ENCRYPTED',
    );
    assert.equal(storage.objects.size, before);
  });

  test('FR-ADM-13: deleting a reference hides it and its links; Undo brings both back', async () => {
    await referenceService.deleteReference({ referenceId: t.policy.id, log });
    let editor = await paperTypeService.getEditor(t.id);
    assert.ok(!editor.references.some((r) => r.id === t.policy.id));
    assert.ok(!editor.sections[0].standards[0].references.some((r) => r.id === t.policy.id));

    await referenceService.restoreReference({ referenceId: t.policy.id, log });
    editor = await paperTypeService.getEditor(t.id);
    assert.ok(editor.sections[0].standards[0].references.some((r) => r.id === t.policy.id));
    assert.equal(editor.references.find((r) => r.id === t.policy.id).linkedCount, 1);
  });

  test('a new file replaces the old one; the old S3 object is removed', async () => {
    const before = await referenceService.getViewer(t.sample.id);
    const oldKey = (await db.query('select s3_key from reference_docs where id = $1', [t.sample.id])).rows[0]
      .s3_key;
    const updated = await referenceService.updateReference({
      referenceId: t.sample.id,
      fields: { title: 'Diagram v2', url: null },
      file: await upload(await makePdf(5), 'v2.pdf'),
      log,
    });
    assert.equal(before.mimeType, 'image/png');
    assert.deepEqual(
      [updated.title, updated.url, updated.mimeType, updated.pageCount],
      ['Diagram v2', null, 'application/pdf', 5],
    );
    assert.ok(!storage.objects.has(oldKey));
    assert.ok(storage.objects.has(updated.s3Key));
  });

  test('FR-REF-02: the viewer lists the standards the reference is used for', async () => {
    const viewer = await referenceService.getViewer(t.policy.id);
    assert.deepEqual(
      viewer.usedFor.map((s) => [s.number, s.text]),
      [[1, 'SSO defined']],
    );
    assert.equal(viewer.fileUrl, `/files/references/${t.policy.id}`);
  });

  test('FR-REF-04: the file is streamed from storage with its type', async () => {
    const file = await referenceService.openReferenceFile(t.policy.id);
    assert.equal(file.contentType, 'application/pdf');
    const chunks = [];
    for await (const c of file.stream) chunks.push(c);
    assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-');
  });
});
