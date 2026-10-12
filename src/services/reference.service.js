'use strict';

/**
 * Reference documents of a paper type: policies, samples, templates and guides (FR-ADM-11…13,
 * FR-REF-02, FR-REF-04). Files live in S3 under generated keys; original names are display only.
 */
const { randomUUID } = require('node:crypto');
const referenceModel = require('../models/reference.model');
const paperTypeModel = require('../models/paperType.model');
const { getStorage } = require('../factories/storageFactory');
const { checkReferenceFile } = require('../utils/pdfInfo');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const EXTENSIONS = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * The S3 key of a reference file. Always generated, never from the uploaded name (NFR-SEC-06).
 * @param {string} paperTypeId
 * @param {string} referenceId
 * @param {string} mimeType
 * @returns {string}
 */
function referenceKey(paperTypeId, referenceId, mimeType) {
  return `references/${paperTypeId}/${referenceId}.${EXTENSIONS[mimeType]}`;
}

/** Keep only the base name, without path parts or control characters, for display. */
function displayName(originalName) {
  const base = String(originalName || 'file')
    .split(/[\\/]/)
    .pop();
  return (
    [...base]
      .filter((ch) => ch.charCodeAt(0) >= 32)
      .join('')
      .slice(0, 200) || 'file'
  );
}

/**
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object>}
 * @throws {NotFoundError}
 */
async function getReferenceOrThrow(id, opts) {
  const ref = await referenceModel.findById(id, opts);
  if (!ref) throw new NotFoundError('Reference not found.');
  return ref;
}

/**
 * The fields a browser may see. Never the S3 key: files are only reachable through the app
 * (FR-REF-04).
 * @param {object} ref  a reference_docs row
 * @returns {object}
 */
function publicReference(ref) {
  return {
    id: ref.id,
    type: ref.type,
    title: ref.title,
    note: ref.note,
    url: ref.url,
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    pageCount: ref.pageCount,
  };
}

/**
 * Check an upload and put it in S3. Returns the columns to store.
 * @returns {Promise<{s3Key, fileName, mimeType, sizeBytes, pageCount}>}
 */
async function storeFile(paperTypeId, referenceId, file) {
  const { mimeType, pageCount } = await checkReferenceFile(file);
  const s3Key = referenceKey(paperTypeId, referenceId, mimeType);
  await getStorage().put(s3Key, file.buffer, { contentType: mimeType });
  return { s3Key, fileName: displayName(file.originalname), mimeType, sizeBytes: file.size, pageCount };
}

/**
 * Add a reference with its file (FR-ADM-12). The file is required.
 *
 * @param {{typeId: string, fields: {type, title, url?, note?}, file?: object, log: import('pino').Logger}} params
 * @returns {Promise<object>} the new reference
 * @throws {ValidationError} no file
 * @throws {FileRejectedError} wrong type, too large, encrypted / unreadable PDF
 */
async function addReference({ typeId, fields, file, log }) {
  if (!(await paperTypeModel.findById(typeId))) throw new NotFoundError('Paper type not found.');
  if (!file) throw new ValidationError('Choose a file to upload.', [{ field: 'file', message: 'Required' }]);
  const id = randomUUID();
  const stored = await storeFile(typeId, id, file);
  try {
    const ref = await referenceModel.create({
      id,
      paperTypeId: typeId,
      type: fields.type,
      title: fields.title,
      note: fields.note ?? null,
      url: fields.url ?? null,
      ...stored,
    });
    log.info({ paperTypeId: typeId, referenceId: id, sizeBytes: stored.sizeBytes }, 'Reference added');
    return ref;
  } catch (err) {
    // The row was not saved: do not leave the uploaded file behind.
    await getStorage()
      .remove(stored.s3Key)
      .catch((cleanupErr) => log.warn({ err: cleanupErr }, 'Could not remove orphan reference file'));
    throw err;
  }
}

/**
 * Change a reference; a new file replaces the old one. The old S3 object is removed only after the
 * database points to the new one (docs/06 §4), so a failure never leaves a reference without a file.
 *
 * @param {{referenceId: string, fields: object, file?: object, log: import('pino').Logger}} params
 * @returns {Promise<object>}
 */
async function updateReference({ referenceId, fields, file, log }) {
  const current = await getReferenceOrThrow(referenceId);
  // A new key per upload (reference ID + time), so the old and new files can briefly coexist.
  const stored = file ? await storeFile(current.paperTypeId, `${referenceId}-${Date.now()}`, file) : {};
  let updated;
  try {
    updated = await referenceModel.update(referenceId, { ...fields, ...stored });
  } catch (err) {
    if (stored.s3Key) {
      await getStorage()
        .remove(stored.s3Key)
        .catch((cleanupErr) => log.warn({ err: cleanupErr }, 'Could not remove orphan reference file'));
    }
    throw err;
  }
  if (file && current.s3Key !== stored.s3Key) {
    await getStorage()
      .remove(current.s3Key)
      .catch((err) => log.warn({ err, referenceId }, 'Old reference file not removed'));
  }
  log.info({ referenceId, newFile: Boolean(file) }, 'Reference updated');
  return updated;
}

/**
 * Soft delete (FR-ADM-13); links are hidden until restore. The file stays for Undo and is purged by
 * the retention job after 7 days.
 * @returns {Promise<void>}
 */
async function deleteReference({ referenceId, log }) {
  await getReferenceOrThrow(referenceId);
  await referenceModel.softDelete(referenceId);
  log.info({ referenceId }, 'Reference deleted');
}

/**
 * Undo a delete: the reference and its links come back.
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED
 */
async function restoreReference({ referenceId, log }) {
  const ref = await getReferenceOrThrow(referenceId, { includeDeleted: true });
  if (!ref.deletedAt) throw new ConflictError('This reference is not deleted.', 'NOT_DELETED');
  await referenceModel.restore(referenceId);
  log.info({ referenceId }, 'Reference restored');
}

/**
 * The file of a reference, for streaming to any signed-in user (FR-REF-04).
 * @param {string} referenceId
 * @returns {Promise<{stream, contentType, contentLength, fileName}>}
 * @throws {NotFoundError}
 */
async function openReferenceFile(referenceId) {
  const ref = await getReferenceOrThrow(referenceId);
  const file = await getStorage().get(ref.s3Key);
  if (!file) throw new NotFoundError('The file of this reference is missing.', 'FILE_MISSING');
  return { ...file, contentType: ref.mimeType, fileName: ref.fileName };
}

/**
 * What the reference viewer dialog shows (FR-REF-02).
 * @param {string} referenceId
 * @returns {Promise<object>}
 */
async function getViewer(referenceId) {
  const ref = await getReferenceOrThrow(referenceId);
  const usedFor = await referenceModel.listLinkedStandards(referenceId);
  return {
    id: ref.id,
    type: ref.type,
    title: ref.title,
    note: ref.note,
    url: ref.url,
    mimeType: ref.mimeType,
    pageCount: ref.pageCount,
    fileUrl: `/files/references/${ref.id}`,
    usedFor,
  };
}

module.exports = {
  referenceKey,
  publicReference,
  displayName,
  addReference,
  updateReference,
  deleteReference,
  restoreReference,
  openReferenceFile,
  getViewer,
};
