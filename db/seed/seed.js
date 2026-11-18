'use strict';

/**
 * `npm run seed` (D-31, docs/05 §6): loads the prototype's paper types, standards and references,
 * with a generated placeholder PDF for every reference, into the database and S3.
 *
 * - Idempotent: a paper type whose name already exists is skipped.
 * - Refuses to run when NODE_ENV=production (real policies are uploaded by admins).
 * - Goes through the normal services, so the same validation and S3 key rules apply.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const config = require('../../src/config');
const db = require('../../src/utils/db');
const { logger } = require('../../src/utils/logger');
const paperTypeModel = require('../../src/models/paperType.model');
const referenceModel = require('../../src/models/reference.model');
const paperTypeService = require('../../src/services/paperType.service');
const sectionService = require('../../src/services/section.service');
const standardService = require('../../src/services/standard.service');
const referenceService = require('../../src/services/reference.service');
const paperTypes = require('./paperTypes');

const log = logger.child({ module: 'seed' });

/** Split text into lines that fit `maxWidth` points. */
function wrap(text, font, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Characters the standard PDF font cannot draw (outside WinAnsi) become "-". */
function drawable(text, font) {
  return [...text]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return '-';
      }
    })
    .join('');
}

/**
 * A one-page A4 placeholder PDF showing the reference's type, title and note.
 * @returns {Promise<Buffer>}
 */
async function placeholderPdf({ type, title, note }) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 770;
  page.drawText(type.toUpperCase(), { x: 60, y, size: 11, font: bold, color: rgb(0.14, 0.33, 0.83) });
  y -= 30;
  for (const line of wrap(drawable(title, bold), bold, 22, 475)) {
    page.drawText(line, { x: 60, y, size: 22, font: bold });
    y -= 28;
  }
  y -= 10;
  for (const line of wrap(drawable(note, font), font, 12, 475)) {
    page.drawText(line, { x: 60, y, size: 12, font });
    y -= 17;
  }
  page.drawText('Placeholder document for local development. Admins upload the real policy.', {
    x: 60,
    y: 60,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.45),
  });
  return Buffer.from(await doc.save());
}

/** The seed's "who": shows as "Last edited by Seed data" (D-37). */
const SEED_ACTOR = { kind: 'entra', name: 'Seed data' };

/**
 * Add a reference to the shared library (D-37), or reuse one with the same title, so running the
 * seed for another type does not upload duplicates.
 */
async function libraryReference([, type, title, note], existingByTitle) {
  const found = existingByTitle.get(title.toLowerCase());
  if (found) return found;
  const buffer = await placeholderPdf({ type, title, note });
  const fileName = `${title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
  const escaped = note.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ref = await referenceService.addReference({
    fields: { type, title, guidance: `<p>${escaped}</p>` },
    file: { buffer, originalname: fileName, size: buffer.length, mimetype: 'application/pdf' },
    actor: SEED_ACTOR,
    log,
  });
  existingByTitle.set(title.toLowerCase(), ref.id);
  return ref.id;
}

/** Create one paper type with everything in it. */
async function seedType(data, existingByTitle) {
  const ctx = { actor: SEED_ACTOR, log };
  const { id: typeId } = await paperTypeService.createType({
    name: data.name,
    description: data.description,
    ...ctx,
  });

  const refIds = new Map();
  for (const entry of data.references) refIds.set(entry[0], await libraryReference(entry, existingByTitle));

  // A new type starts with a "General" section (FR-ADM-02): rename it to the first section.
  const editor = await paperTypeService.getEditor(typeId);
  for (const [index, [title, standards]] of data.sections.entries()) {
    const section =
      index === 0
        ? await sectionService.renameSection({ sectionId: editor.sections[0].id, title, ...ctx })
        : await sectionService.addSection({ typeId, title, ...ctx });
    for (const [standardTitle, mandatory, refKeys] of standards) {
      await standardService.addStandard({
        sectionId: section.id,
        title: standardTitle,
        isMandatory: Boolean(mandatory),
        referenceIds: refKeys.map((k) => refIds.get(k)),
        ...ctx,
      });
    }
  }
  // A new type is a draft until it is published (D-45); architects only see published versions.
  await paperTypeService.publishDraft({ typeId, ...ctx });
  return typeId;
}

async function main() {
  if (config.isProduction) throw new Error('npm run seed refuses to run in production.');
  const existing = new Set((await paperTypeModel.listWithStats()).map((t) => t.name.toLowerCase()));
  const existingByTitle = new Map((await referenceModel.listAll()).map((r) => [r.title.toLowerCase(), r.id]));
  for (const data of paperTypes) {
    if (existing.has(data.name.toLowerCase())) {
      log.info({ paperType: data.name }, 'Paper type already exists, skipped');
      continue;
    }
    const id = await seedType(data, existingByTitle);
    const count = data.sections.reduce((n, [, list]) => n + list.length, 0);
    log.info(
      { paperType: data.name, paperTypeId: id, standards: count, references: data.references.length },
      'Paper type seeded',
    );
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      log.fatal({ err }, 'Seed failed');
      process.exitCode = 1;
    })
    .finally(() => db.close());
}

module.exports = { main, placeholderPdf };
