'use strict';

/**
 * Reference viewing for every signed-in user with a role (FR-REF-02, FR-REF-04).
 */
const { pipeline } = require('node:stream/promises');
const referenceService = require('../services/reference.service');

/** GET /api/references/:referenceId — data for the reference viewer dialog. */
async function viewer(req, res) {
  res.json({ data: await referenceService.getViewer(req.params.referenceId) });
}

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 name, so any file name is safe in the header. */
function contentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * GET /files/references/:referenceId — stream the file through the app (never a public S3 link).
 */
async function file(req, res) {
  const { stream, contentType, contentLength, fileName } = await referenceService.openReferenceFile(
    req.params.referenceId,
  );
  res.set({
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(fileName),
    'Cache-Control': 'private, max-age=300',
  });
  if (contentLength) res.set('Content-Length', String(contentLength));
  // pipeline() destroys both streams on error; a broken download is logged by the error handler.
  await pipeline(stream, res);
}

module.exports = { viewer, file, contentDisposition };
