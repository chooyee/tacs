'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { detectFileType, checkReferenceFile } = require('../../src/utils/pdfInfo');
const { FileRejectedError } = require('../../src/utils/errors');
const { MemoryStorage } = require('../../src/providers/storage/memoryStorage');
const { S3Storage } = require('../../src/providers/storage/s3Storage');
const { makePdf, PNG_BYTES, ENCRYPTED_PDF } = require('../helpers/files');

/** Read a stream into a string. */
async function text(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

describe('upload checks (NFR-SEC-06, FR-ADM-12)', () => {
  test('file type comes from the magic bytes, not the name', async () => {
    assert.equal(detectFileType(await makePdf()), 'application/pdf');
    assert.equal(detectFileType(PNG_BYTES), 'image/png');
    assert.equal(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(detectFileType(Buffer.from('MZ fake.exe renamed to .pdf')), null);
  });

  test('a PDF is accepted with its page count', async () => {
    const result = await checkReferenceFile({ buffer: await makePdf(3), mimetype: 'application/pdf' });
    assert.deepEqual(result, { mimeType: 'application/pdf', pageCount: 3 });
  });

  test('an image is accepted without a page count', async () => {
    const result = await checkReferenceFile({ buffer: PNG_BYTES, mimetype: 'image/png' });
    assert.deepEqual(result, { mimeType: 'image/png', pageCount: null });
  });

  test('a non-PDF/image is refused with 415 even if the browser says application/pdf', async () => {
    await assert.rejects(
      checkReferenceFile({ buffer: Buffer.from('hello'), mimetype: 'application/pdf' }),
      (err) => err instanceof FileRejectedError && err.status === 415 && err.code === 'FILE_TYPE',
    );
  });

  test('a password-protected PDF is refused with 422 PDF_ENCRYPTED', async () => {
    await assert.rejects(
      checkReferenceFile({ buffer: ENCRYPTED_PDF, mimetype: 'application/pdf' }),
      (err) => err.status === 422 && err.code === 'PDF_ENCRYPTED',
    );
  });

  test('a damaged PDF is refused with 422 PDF_UNREADABLE', async () => {
    const broken = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('garbage '.repeat(50))]);
    await assert.rejects(
      checkReferenceFile({ buffer: broken, mimetype: 'application/pdf' }),
      (err) => err.status === 422 && err.code === 'PDF_UNREADABLE',
    );
  });

  test('the test PDF helper really makes PDFs', async () => {
    const doc = await PDFDocument.load(await makePdf(2));
    assert.equal(doc.getPageCount(), 2);
  });
});

describe('storage providers (docs/04 §3.1)', () => {
  test('memory storage: put, get, copy, remove', async () => {
    const storage = new MemoryStorage();
    await storage.put('references/a/1.pdf', Buffer.from('one'), { contentType: 'application/pdf' });
    await storage.copy('references/a/1.pdf', 'references/b/2.pdf');
    const copy = await storage.get('references/b/2.pdf');
    assert.equal(copy.contentType, 'application/pdf');
    assert.equal(await text(copy.stream), 'one');
    await storage.remove('references/a/1.pdf');
    assert.equal(await storage.get('references/a/1.pdf'), null);
  });

  test('unsafe keys are refused', async () => {
    const storage = new MemoryStorage();
    for (const key of ['../etc/passwd', '/abs/key', 'a/../b', 'a//b', '']) {
      await assert.rejects(
        storage.put(key, Buffer.from('x'), { contentType: 'text/plain' }),
        /Unsafe storage key/,
      );
    }
  });

  test('D-30: S3 keys get the configured prefix', () => {
    const s3 = new S3Storage({ region: 'ap-southeast-1', bucket: 'b', keyPrefix: 'tacs/' });
    assert.equal(s3.fullKey('references/x/y.pdf'), 'tacs/references/x/y.pdf');
  });
});
