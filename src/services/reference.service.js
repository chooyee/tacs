'use strict';

/**
 * The reference library (D-37): policies, samples, templates and guides shared by every paper type
 * (FR-ADM-11…13, FR-REF-02, FR-REF-04). Each reference has a file (preview + AI), rich-text
 * guidance shown as its "Description" and ordered links (D-39). Files live in S3 under generated keys;
 * original names are for display only.
 */
const { randomUUID } = require('node:crypto');
const referenceModel = require('../models/reference.model');
const { withTransaction } = require('../utils/db');
const { getStorage } = require('../factories/storageFactory');
const { checkReferenceFile } = require('../utils/pdfInfo');
const { actorName } = require('../utils/actor');
const { sanitizeRichText, richTextToPlain } = require('../utils/richText');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const EXTENSIONS = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const MAX_GUIDANCE_HTML = 50_000;
const NOTE_LENGTH = 500; // plain-text summary for tooltips and the AI prompt (docs/07)

/**
 * The S3 key of a reference file. Always generated, never from the uploaded name (NFR-SEC-06).
 * @param {string} fileId  reference ID, plus a suffix when the file is replaced
 * @param {string} mimeType
 * @returns {string}
 */
function referenceKey(fileId, mimeType) {
  return `references/${fileId}.${EXTENSIONS[mimeType]}`;
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
    guidanceHtml: ref.guidanceHtml,
    links: ref.links ?? [],
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    pageCount: ref.pageCount,
    updatedAt: ref.updatedAt,
    updatedBy: ref.updatedBy,
  };
}

/** Rich guidance → { guidanceHtml, note } (note = plain text for tooltips and the AI). */
function cleanGuidance(html) {
  if (html === undefined) return {};
  const guidanceHtml = sanitizeRichText(html);
  if (guidanceHtml.length > MAX_GUIDANCE_HTML) {
    throw new ValidationError('The guidance is too long.', [{ field: 'guidance', message: 'Too long' }]);
  }
  return { guidanceHtml, note: richTextToPlain(guidanceHtml, NOTE_LENGTH) || null };
}

/**
 * Check an upload and put it in S3. Returns the columns to store.
 * @returns {Promise<{s3Key, fileName, mimeType, sizeBytes, pageCount}>}
 */
async function storeFile(fileId, file) {
  const { mimeType, pageCount } = await checkReferenceFile(file);
  const s3Key = referenceKey(fileId, mimeType);
  await getStorage().put(s3Key, file.buffer, { contentType: mimeType });
  return { s3Key, fileName: displayName(file.originalname), mimeType, sizeBytes: file.size, pageCount };
}

/** Remove a just-uploaded file after a failed save, so no orphan stays in S3. */
async function removeOrphan(key, log) {
  await getStorage()
    .remove(key)
    .catch((err) => log.warn({ err }, 'Could not remove orphan reference file'));
}

/**
 * The library page (Admin → References).
 * @returns {Promise<object[]>}
 */
function listLibrary() {
  return referenceModel.listAll();
}

/**
 * Add a reference to the library (FR-ADM-12). The file is required.
 *
 * @param {{fields: {type, title, guidance?, links?}, file?: object, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>} the new reference, with its links
 * @throws {ValidationError} no file
 * @throws {FileRejectedError} wrong type, too large, encrypted / unreadable PDF
 */
async function addReference({ fields, file, actor, log }) {
  if (!file) throw new ValidationError('Choose a file to upload.', [{ field: 'file', message: 'Required' }]);
  const guidance = cleanGuidance(fields.guidance ?? '');
  const links = fields.links ?? [];
  const id = randomUUID();
  const stored = await storeFile(id, file);
  try {
    // The reference and its links are saved together, or not at all.
    const ref = await withTransaction(async () => {
      const created = await referenceModel.create({
        id,
        type: fields.type,
        title: fields.title,
        ...guidance,
        ...stored,
        updatedBy: actorName(actor),
      });
      await referenceModel.replaceLinks(id, links);
      return { ...created, links };
    });
    log.info({ referenceId: id, sizeBytes: stored.sizeBytes, links: links.length }, 'Reference added');
    return ref;
  } catch (err) {
    await removeOrphan(stored.s3Key, log);
    throw err;
  }
}

/**
 * Change a reference; a new file replaces the old one. The old S3 object is removed only after the
 * database points to the new one (docs/06 §4), so a failure never leaves a reference without a file.
 *
 * `fields.links`, when present, replaces all links (D-39); when absent the links stay as they are.
 *
 * @param {{referenceId: string, fields: object, file?: object, actor: object, log: import('pino').Logger}} params
 * @returns {Promise<object>} the reference, with its links
 */
async function updateReference({ referenceId, fields, file, actor, log }) {
  const current = await getReferenceOrThrow(referenceId);
  const { guidance, links, ...rest } = fields;
  const changes = { ...rest, ...cleanGuidance(guidance), updatedBy: actorName(actor) };
  // A new key per upload (reference ID + time), so the old and new files can briefly coexist.
  const stored = file ? await storeFile(`${referenceId}-${Date.now()}`, file) : {};
  let updated;
  try {
    updated = await withTransaction(async () => {
      const row = await referenceModel.update(referenceId, { ...changes, ...stored });
      if (links) await referenceModel.replaceLinks(referenceId, links);
      return { ...row, links: await referenceModel.listLinks(referenceId) };
    });
  } catch (err) {
    if (stored.s3Key) await removeOrphan(stored.s3Key, log);
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
async function deleteReference({ referenceId, actor, log }) {
  await getReferenceOrThrow(referenceId);
  await referenceModel.softDelete(referenceId, actorName(actor));
  log.info({ referenceId }, 'Reference deleted');
}

/**
 * Undo a delete: the reference and its links come back.
 * @returns {Promise<void>}
 * @throws {ConflictError} NOT_DELETED
 */
async function restoreReference({ referenceId, actor, log }) {
  const ref = await getReferenceOrThrow(referenceId, { includeDeleted: true });
  if (!ref.deletedAt) throw new ConflictError('This reference is not deleted.', 'NOT_DELETED');
  await referenceModel.restore(referenceId, actorName(actor));
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
 * The full-screen reference page: the reference and the standards that use it, by paper type.
 * @param {string} referenceId
 * @returns {Promise<{reference: object, usedFor: object[]}>}
 */
async function getReferencePage(referenceId) {
  const ref = await getReferenceOrThrow(referenceId);
  const [usedFor, links] = await Promise.all([
    referenceModel.listLinkedStandards(referenceId),
    referenceModel.listLinks(referenceId),
  ]);
  return {
    reference: { ...publicReference({ ...ref, links }), linkedCount: ref.linkedCount, typeCount: ref.typeCount },
    usedFor,
  };
}

/**
 * What the reference viewer dialog shows (FR-REF-02).
 * @param {string} referenceId
 * @returns {Promise<object>}
 */
async function getViewer(referenceId) {
  const { reference, usedFor } = await getReferencePage(referenceId);
  return {
    id: reference.id,
    type: reference.type,
    title: reference.title,
    note: reference.note,
    links: reference.links,
    fileName: reference.fileName,
    mimeType: reference.mimeType,
    sizeBytes: reference.sizeBytes,
    pageCount: reference.pageCount,
    fileUrl: `/files/references/${reference.id}`,
    // "Last edited … by …" in the viewer (D-44)
    updatedAt: reference.updatedAt,
    updatedBy: reference.updatedBy,
    usedFor: usedFor.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      paperTypeName: s.paperTypeName,
    })),
  };
}

module.exports = {
  referenceKey,
  displayName,
  publicReference,
  listLibrary,
  addReference,
  updateReference,
  deleteReference,
  restoreReference,
  openReferenceFile,
  getReferencePage,
  getViewer,
};
