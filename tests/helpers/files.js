'use strict';

/**
 * Small files for upload tests, built in code so no binary fixtures live in git.
 */
const { PDFDocument } = require('pdf-lib');

/**
 * A valid PDF with `pages` blank pages.
 * @param {number} [pages=1]
 * @returns {Promise<Buffer>}
 */
async function makePdf(pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

/** The PNG signature followed by a tiny header — enough for the magic-bytes check. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);

/** A minimal PDF whose trailer declares encryption (/Encrypt), like a password-protected file. */
const ENCRYPTED_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >> endobj',
    '4 0 obj << /Filter /Standard /V 1 /R 2 /O (owner) /U (user) /P -4 >> endobj',
    'trailer << /Root 1 0 R /Size 5 /Encrypt 4 0 R >>',
    '%%EOF',
  ].join('\n'),
);

module.exports = { makePdf, PNG_BYTES, ENCRYPTED_PDF };
