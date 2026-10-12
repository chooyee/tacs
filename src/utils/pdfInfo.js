'use strict';

/**
 * Checks for uploaded files (NFR-SEC-06). The browser's MIME type and the file name can be faked, so
 * we look at the first bytes ("magic bytes") and, for PDFs, really open the file with pdf-lib.
 */
const { PDFDocument } = require('pdf-lib');
const { FileRejectedError } = require('./errors');

const SIGNATURES = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
];

/**
 * What a file really is, judged by its first bytes.
 * @param {Buffer} buffer
 * @returns {'application/pdf'|'image/png'|'image/jpeg'|null}
 */
function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const match = SIGNATURES.find(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
  return match ? match.type : null;
}

/**
 * Open a PDF to make sure it is readable and not password-protected, and count its pages.
 * @param {Buffer} buffer
 * @returns {Promise<{pageCount: number}>}
 * @throws {FileRejectedError} 422 PDF_ENCRYPTED or PDF_UNREADABLE
 */
async function inspectPdf(buffer) {
  let pageCount;
  try {
    const doc = await PDFDocument.load(buffer, { updateMetadata: false });
    // pdf-lib is lenient when loading; a damaged file often only fails when its pages are read.
    pageCount = doc.getPageCount();
  } catch (err) {
    if (err?.constructor?.name === 'EncryptedPDFError' || /encrypted/i.test(err?.message)) {
      throw new FileRejectedError(
        'This PDF is password-protected. Save an unprotected copy and upload that.',
        422,
        'PDF_ENCRYPTED',
      );
    }
    throw new FileRejectedError(
      'We could not read this PDF. It may be damaged; try exporting it again.',
      422,
      'PDF_UNREADABLE',
    );
  }
  if (pageCount < 1) throw new FileRejectedError('This PDF has no pages.', 422, 'PDF_UNREADABLE');
  return { pageCount };
}

/**
 * Check a reference file (FR-ADM-12): PDF, PNG or JPG by content, PDFs readable and unprotected.
 * @param {{buffer: Buffer, mimetype: string}} file  from multer
 * @returns {Promise<{mimeType: string, pageCount: number|null}>}
 * @throws {FileRejectedError} 415 FILE_TYPE or 422 PDF_*
 */
async function checkReferenceFile(file) {
  const realType = detectFileType(file.buffer);
  if (!realType) {
    throw new FileRejectedError('Upload a PDF, PNG or JPG file.', 415, 'FILE_TYPE');
  }
  if (realType !== 'application/pdf') return { mimeType: realType, pageCount: null };
  const { pageCount } = await inspectPdf(file.buffer);
  return { mimeType: realType, pageCount };
}

module.exports = { detectFileType, inspectPdf, checkReferenceFile };
