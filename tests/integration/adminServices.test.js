'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/utils/db');
const paperTypeService = require('../../src/services/paperType.service');
const sectionService = require('../../src/services/section.service');
const standardService = require('../../src/services/standard.service');
const referenceService = require('../../src/services/reference.service');
const { getStorage } = require('../../src/factories/storageFactory');
const { ConflictError, ValidationError, FileRejectedError, NotFoundError } = require('../../src/utils/errors');
const { resetDb, createUser, silentLog: log, closeDb } = require('../helpers/db');
const { makePdf, PNG_BYTES, ENCRYPTED_PDF } = require('../helpers/files');

const storage = getStorage(); // MemoryStorage in tests
const actor = { kind: 'entra', name: 'Tess Tester' };

/** A multer-like file object. */
const upload = async (buffer, name = 'policy.pdf') => {
  const bytes = buffer ?? (await makePdf(2));
  return { buffer: bytes, originalname: name, size: bytes.length, mimetype: 'application/pdf' };
};

/** Add a library reference (D-37). */
const addRef = async (title, type = 'Policy', extra = {}) =>
  referenceService.addReference({ fields: { type, title, ...extra }, file: await upload(), actor, log });

/** A new type with sections General (2 standards) and Security (1 standard), linked to two references. */
async function buildType(name) {
  const { id } = await paperTypeService.createType({ name, actor, log });
  const [general] = (await paperTypeService.getEditor(id)).sections;
  const second = await sectionService.addSection({ typeId: id, title: 'Security', actor, log });
  const policy = await addRef(`${name} Identity Standard`, 'Policy', { guidance: '<p>Look for SSO</p>' });
  const sample = await referenceService.addReference({
    fields: { type: 'Sample', title: `${name} Diagram` },
    file: await upload(PNG_BYTES, 'diagram.png'),
    actor,
    log,
  });
  const s1 = await standardService.addStandard({
    sectionId: general.id,
    title: 'SSO defined',
    isMandatory: true,
    referenceIds: [policy.id, sample.id],
    actor,
    log,
  });
  const s2 = await standardService.addStandard({ sectionId: general.id, title: 'MFA enforced', actor, log });
  const s3 = await standardService.addStandard({ sectionId: second.id, title: 'Logs in SIEM', actor, log });
  return { id, general, second, s1, s2, s3, policy, sample };
}

const titles = (editor) => editor.sections.map((s) => s.standards.map((x) => [x.number, x.title]));

before(async () => {
  await resetDb();
  storage.clear();
});
after(closeDb);

describe('paper types (FR-ADM-01…03, FR-ADM-10)', () => {
  test('FR-ADM-02: a blank type starts with one "General" section', async () => {
    const { id, url } = await paperTypeService.createType({ name: 'Blank One', description: 'When X', actor, log });
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
      paperTypeService.createType({ name: 'blank one', actor, log }),
      (err) => err instanceof ConflictError && err.code === 'NAME_TAKEN',
    );
  });

  test('FR-ADM-01: the list shows standards, mandatory, references used and papers', async () => {
    const built = await buildType('Stats Type');
    const card = (await paperTypeService.listTypes()).find((t) => t.id === built.id);
    assert.deepEqual(
      { s: card.standardsCount, m: card.mandatoryCount, r: card.referencesCount, p: card.papersCount },
      { s: 3, m: 1, r: 2, p: 0 },
    );
  });

  test('FR-ADM-10 / D-37: name and description autosave with "last edited by"; a taken name is refused', async () => {
    const { id } = await paperTypeService.createType({ name: 'Rename Me', actor, log });
    const updated = await paperTypeService.updateType({ typeId: id, name: 'Renamed', description: null, actor, log });
    assert.deepEqual([updated.name, updated.description, updated.updatedBy], ['Renamed', null, 'Tess Tester']);
    await assert.rejects(paperTypeService.updateType({ typeId: id, name: 'Stats Type', actor, log }), /already exists/);
  });

  test('FR-ADM-02 / D-37: a copy has the same sections, standards, flags and links to the SAME library references', async () => {
    const source = await buildType('Copy Source');
    const before = storage.objects.size;
    const { id } = await paperTypeService.createType({ name: 'Copy Target', copyFromTypeId: source.id, actor, log });
    const [from, to] = await Promise.all([paperTypeService.getEditor(source.id), paperTypeService.getEditor(id)]);
    const shape = (e) =>
      e.sections.map((s) => [s.title, s.standards.map((x) => [x.number, x.title, x.isMandatory, x.references.map((r) => r.id)])]);
    assert.deepEqual(shape(to), shape(from));
    assert.equal(storage.objects.size, before, 'references are shared: no files are copied');
  });

  test('FR-ADM-03: a type used by a paper cannot be deleted; an unused one can', async () => {
    const used = await buildType('Used Type');
    const owner = await createUser();
    await db.query(`insert into papers (owner_id, paper_type_id, title) values ($1, $2, 'A paper')`, [owner.id, used.id]);
    await assert.rejects(
      paperTypeService.deleteType({ typeId: used.id, actor, log }),
      (err) => err.code === 'TYPE_IN_USE' && /1 paper/.test(err.message),
    );
    assert.equal((await paperTypeService.getEditor(used.id)).papersInProgress, 1);

    const { id } = await paperTypeService.createType({ name: 'Unused Type', actor, log });
    await paperTypeService.deleteType({ typeId: id, actor, log });
    assert.ok(!(await paperTypeService.listTypes()).some((t) => t.id === id));
    await assert.rejects(paperTypeService.getEditor(id), NotFoundError);
    await paperTypeService.createType({ name: 'Unused Type', actor, log }); // the name is free again
  });
});

describe('sections and standards (FR-ADM-14…21, FR-ANS-02, D-37, D-38)', () => {
  let t;
  before(async () => {
    t = await buildType('Editor Type');
  });

  test('FR-ANS-02: standards are numbered 1…N across sections', async () => {
    assert.deepEqual(titles(await paperTypeService.getEditor(t.id)), [
      [
        [1, 'SSO defined'],
        [2, 'MFA enforced'],
      ],
      [[3, 'Logs in SIEM']],
    ]);
  });

  test('FR-ADM-19: move swaps with the neighbour; the first cannot move up; sections move too', async () => {
    await standardService.moveStandard({ standardId: t.s2.id, direction: 'up', actor, log });
    let editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections[0].standards.map((x) => x.title),
      ['MFA enforced', 'SSO defined'],
    );
    await assert.rejects(
      standardService.moveStandard({ standardId: t.s2.id, direction: 'up', actor, log }),
      (err) => err.code === 'CANNOT_MOVE',
    );
    await sectionService.moveSection({ sectionId: t.second.id, direction: 'up', actor, log });
    editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections.map((s) => [s.letter, s.title]),
      [
        ['A', 'Security'],
        ['B', 'General'],
      ],
    );
    assert.equal(editor.sections[0].standards[0].number, 1); // numbering follows the new order
    await sectionService.moveSection({ sectionId: t.second.id, direction: 'down', actor, log });
    await standardService.moveStandard({ standardId: t.s2.id, direction: 'down', actor, log });
  });

  test('D-37: drag and drop moves a standard into another section at an index, and reorders sections', async () => {
    await standardService.moveStandard({ standardId: t.s2.id, sectionId: t.second.id, index: 0, actor, log });
    assert.deepEqual(titles(await paperTypeService.getEditor(t.id)), [
      [[1, 'SSO defined']],
      [
        [2, 'MFA enforced'],
        [3, 'Logs in SIEM'],
      ],
    ]);
    const other = await buildType('Drag Other');
    await assert.rejects(
      standardService.moveStandard({ standardId: t.s2.id, sectionId: other.general.id, index: 0, actor, log }),
      ValidationError,
    );
    await sectionService.reorderSections({ typeId: t.id, orderedIds: [t.second.id, t.general.id], actor, log });
    assert.deepEqual(
      (await paperTypeService.getEditor(t.id)).sections.map((s) => s.title),
      ['Security', 'General'],
    );
    // back to the starting layout
    await sectionService.reorderSections({ typeId: t.id, orderedIds: [t.general.id, t.second.id], actor, log });
    await standardService.moveStandard({ standardId: t.s2.id, sectionId: t.general.id, index: 1, actor, log });
  });

  test('FR-ADM-18: deleting a section hides its standards; Undo brings back only those', async () => {
    const extra = await standardService.addStandard({ sectionId: t.second.id, title: 'Deleted earlier', actor, log });
    await standardService.deleteStandard({ standardId: extra.id, actor, log });
    await sectionService.deleteSection({ sectionId: t.second.id, actor, log });

    let editor = await paperTypeService.getEditor(t.id);
    assert.equal(editor.sections.length, 1);
    assert.equal(editor.totals.standards, 2);
    await assert.rejects(
      standardService.restoreStandard({ standardId: t.s3.id, actor, log }),
      (err) => err.code === 'SECTION_DELETED',
    );
    await sectionService.restoreSection({ sectionId: t.second.id, actor, log });
    editor = await paperTypeService.getEditor(t.id);
    assert.deepEqual(
      editor.sections[1].standards.map((x) => x.title),
      ['Logs in SIEM'],
    );
    await assert.rejects(sectionService.restoreSection({ sectionId: t.second.id, actor, log }), /not deleted/);
  });

  test('FR-ADM-18: a deleted standard can be restored', async () => {
    await standardService.deleteStandard({ standardId: t.s3.id, actor, log });
    assert.equal((await paperTypeService.getEditor(t.id)).totals.standards, 2);
    await standardService.restoreStandard({ standardId: t.s3.id, actor, log });
    assert.equal((await paperTypeService.getEditor(t.id)).totals.standards, 3);
  });

  test('FR-ADM-17: referenceIds replace the link set; an unknown reference is refused', async () => {
    await standardService.updateStandard({ standardId: t.s1.id, referenceIds: [t.policy.id], actor, log });
    let s1 = (await paperTypeService.getEditor(t.id)).sections[0].standards.find((x) => x.id === t.s1.id);
    assert.deepEqual(
      s1.references.map((r) => r.title),
      ['Editor Type Identity Standard'],
    );
    await assert.rejects(
      standardService.updateStandard({ standardId: t.s1.id, referenceIds: ['00000000-0000-4000-8000-000000000000'], actor, log }),
      ValidationError,
    );
    s1 = (await paperTypeService.getEditor(t.id)).sections[0].standards.find((x) => x.id === t.s1.id);
    assert.equal(s1.references.length, 1); // unchanged
  });

  test('FR-ADM-21: more than 4 references gives a (non-blocking) warning', async () => {
    const ids = [t.policy.id, t.sample.id];
    for (let i = 0; i < 3; i += 1) ids.push((await addRef(`Guide ${i}`, 'Guide')).id);
    const { warnings } = await standardService.updateStandard({ standardId: t.s2.id, referenceIds: ids, actor, log });
    assert.equal(warnings.length, 1);
    const ok = await standardService.updateStandard({ standardId: t.s2.id, referenceIds: ids.slice(0, 4), actor, log });
    assert.deepEqual(ok.warnings, []);
  });

  test('FR-ADM-15 / D-37: toggling mandatory keeps the title; the description is cleaned rich text', async () => {
    const { standard } = await standardService.updateStandard({
      standardId: t.s3.id,
      isMandatory: true,
      description: '<p onclick="x()">Logs <b>must</b> reach the SIEM<script>alert(1)</script></p>',
      actor,
      log,
    });
    assert.deepEqual([standard.title, standard.isMandatory], ['Logs in SIEM', true]);
    assert.equal(standard.descriptionHtml, '<p>Logs <b>must</b> reach the SIEM</p>');
    assert.equal(standard.updatedBy, 'Tess Tester');
  });

  test('D-38: import links standards of another type live; links are read-only; re-import is skipped', async () => {
    const target = await buildType('Import Target');
    const result = await standardService.importStandards({
      typeId: target.id,
      standardIds: [t.s1.id, t.s3.id],
      mode: 'into',
      targetSectionId: target.general.id,
      actor,
      log,
    });
    assert.deepEqual(result, { imported: 2, skipped: [] });
    let editor = await paperTypeService.getEditor(target.id);
    const linked = editor.sections[0].standards.filter((x) => x.link);
    assert.deepEqual(
      linked.map((x) => [x.title, x.isMandatory, x.link.typeName]),
      [
        ['SSO defined', true, 'Editor Type'],
        ['Logs in SIEM', true, 'Editor Type'],
      ],
    );
    assert.equal((await paperTypeService.listTypes()).find((x) => x.id === target.id).mandatoryCount, 3);
    await assert.rejects(
      standardService.updateStandard({ standardId: linked[0].id, title: 'Changed here', actor, log }),
      (err) => err.code === 'LINKED_STANDARD',
    );

    // A change at the source shows in the link.
    await standardService.updateStandard({ standardId: t.s1.id, title: 'SSO with Entra defined', actor, log });
    editor = await paperTypeService.getEditor(target.id);
    assert.equal(editor.sections[0].standards.find((x) => x.id === linked[0].id).title, 'SSO with Entra defined');

    const again = await standardService.importStandards({
      typeId: target.id,
      standardIds: [t.s1.id],
      mode: 'sections',
      actor,
      log,
    });
    assert.deepEqual(again, { imported: 0, skipped: ['SSO with Entra defined'] });
  });

  test('D-38: "Duplicate here" turns a link into an own, editable copy', async () => {
    const target = await buildType('Duplicate Target');
    await standardService.importStandards({ typeId: target.id, standardIds: [t.s2.id], mode: 'sections', actor, log });
    let editor = await paperTypeService.getEditor(target.id);
    const link = editor.sections.flatMap((s) => s.standards).find((x) => x.link);
    assert.equal(editor.sections.at(-1).title, 'General'); // "sections" mode recreates the source section

    await standardService.detachStandard({ standardId: link.id, actor, log });
    await standardService.updateStandard({ standardId: link.id, title: 'MFA enforced (our wording)', actor, log });
    editor = await paperTypeService.getEditor(target.id);
    const own = editor.sections.flatMap((s) => s.standards).find((x) => x.id === link.id);
    assert.deepEqual([own.title, own.link], ['MFA enforced (our wording)', null]);
    await assert.rejects(standardService.detachStandard({ standardId: link.id, actor, log }), (err) => err.code === 'NOT_LINKED');
  });
});

describe('references (FR-ADM-11…13, FR-REF-02, FR-REF-04, NFR-SEC-06, D-37, D-39)', () => {
  let t;
  before(async () => {
    t = await buildType('Reference Type');
  });

  test('NFR-SEC-06: the S3 key is generated; the original name is display only', async () => {
    const ref = await referenceService.addReference({
      fields: { type: 'Template', title: 'Tricky' },
      file: await upload(undefined, '..\\..\\evil/../name.pdf'),
      actor,
      log,
    });
    assert.match(ref.s3Key, /^references\/[0-9a-f-]{36}\.pdf$/);
    assert.equal(ref.fileName, 'name.pdf');
    assert.equal(ref.pageCount, 2);
    assert.equal(referenceService.publicReference(ref).s3Key, undefined);
  });

  test('FR-ADM-12: the file is required; bad files are refused and nothing is stored', async () => {
    const before = storage.objects.size;
    await assert.rejects(referenceService.addReference({ fields: { type: 'Policy', title: 'x' }, actor, log }), ValidationError);
    await assert.rejects(
      referenceService.addReference({ fields: { type: 'Policy', title: 'x' }, file: await upload(ENCRYPTED_PDF), actor, log }),
      (err) => err instanceof FileRejectedError && err.code === 'PDF_ENCRYPTED',
    );
    assert.equal(storage.objects.size, before);
  });

  test('D-37: the description (guidance) is cleaned and its plain text kept as the note', async () => {
    const ref = await addRef('Guided', 'Guide', { guidance: '<p>Check <b>CASB</b> for admins<script>x()</script></p>' });
    assert.equal(ref.guidanceHtml, '<p>Check <b>CASB</b> for admins</p>');
    assert.equal(ref.note, 'Check CASB for admins');
  });

  test('D-39: links are saved in order, replaced when sent, kept when not sent, and shown in the viewer', async () => {
    const links = [
      { label: 'Policy Hub', url: 'https://intranet.example.com/policies/14' },
      { label: 'Confluence', url: 'https://confluence.example.com/SEC' },
    ];
    const ref = await addRef('Linked Policy', 'Policy', { links });
    assert.deepEqual(ref.links, links);
    assert.deepEqual((await referenceService.getViewer(ref.id)).links, links);

    await referenceService.updateReference({ referenceId: ref.id, fields: { title: 'Linked Policy v2' }, actor, log });
    assert.deepEqual((await referenceService.getReferencePage(ref.id)).reference.links, links); // untouched

    const reordered = await referenceService.updateReference({
      referenceId: ref.id,
      fields: { links: [links[1]] },
      actor,
      log,
    });
    assert.deepEqual(reordered.links, [links[1]]);
    const { rows } = await db.query('select position, label from reference_links where reference_id = $1', [ref.id]);
    assert.deepEqual(rows, [{ position: 0, label: 'Confluence' }]);
  });

  test('FR-ADM-13: deleting a reference hides it and its links; Undo brings both back', async () => {
    await referenceService.deleteReference({ referenceId: t.policy.id, actor, log });
    let editor = await paperTypeService.getEditor(t.id);
    assert.ok(!editor.usedReferences.some((r) => r.id === t.policy.id));
    assert.ok(!editor.sections[0].standards[0].references.some((r) => r.id === t.policy.id));
    assert.ok(!(await referenceService.listLibrary()).some((r) => r.id === t.policy.id));

    await referenceService.restoreReference({ referenceId: t.policy.id, actor, log });
    editor = await paperTypeService.getEditor(t.id);
    assert.ok(editor.sections[0].standards[0].references.some((r) => r.id === t.policy.id));
    await assert.rejects(referenceService.restoreReference({ referenceId: t.policy.id, actor, log }), (err) => err.code === 'NOT_DELETED');
  });

  test('a new file replaces the old one; the old S3 object is removed', async () => {
    const oldKey = (await db.query('select s3_key from reference_docs where id = $1', [t.sample.id])).rows[0].s3_key;
    assert.equal((await referenceService.getViewer(t.sample.id)).mimeType, 'image/png');
    const updated = await referenceService.updateReference({
      referenceId: t.sample.id,
      fields: { title: 'Diagram v2' },
      file: await upload(await makePdf(5), 'v2.pdf'),
      actor,
      log,
    });
    assert.deepEqual([updated.title, updated.mimeType, updated.pageCount], ['Diagram v2', 'application/pdf', 5]);
    assert.ok(!storage.objects.has(oldKey));
    assert.ok(storage.objects.has(updated.s3Key));
  });

  test('FR-REF-02: the viewer lists the standards it is used for, per paper type', async () => {
    const viewer = await referenceService.getViewer(t.policy.id);
    assert.deepEqual(
      viewer.usedFor.map((s) => [s.paperTypeName, s.number, s.title]),
      [['Reference Type', 1, 'SSO defined']],
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
