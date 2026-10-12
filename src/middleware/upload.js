'use strict';

const multer = require('multer');
const config = require('../config');
const { FileRejectedError, ValidationError } = require('../utils/errors');

const MB = 1024 * 1024;

/**
 * Turn multer's errors into our error classes, so the error handler shows a friendly message.
 * @param {import('express').RequestHandler} handler  a multer middleware
 * @param {number} maxMb
 */
function friendly(handler, maxMb) {
  return (req, res, next) =>
    handler(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new FileRejectedError(`The file is larger than ${maxMb} MB.`, 413, 'FILE_TOO_LARGE'));
      }
      if (err instanceof multer.MulterError) {
        const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
        return next(new ValidationError(tooMany ? 'Attach at most 3 files.' : 'The upload could not be read.'));
      }
      return next(err);
    });
}

/**
 * One optional reference file in the field `file` (FR-ADM-12), kept in memory (≤ 15 MB by default)
 * and sent straight to S3 by the service. Other form fields arrive in req.body.
 * @type {import('express').RequestHandler}
 */
const referenceFileUpload = friendly(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxReferenceMb * MB, files: 1, fields: 10, fieldSize: 10_000 },
  }).single('file'),
  config.uploads.maxReferenceMb,
);

/**
 * 1–3 paper PDFs in the field `files` (FR-AI-02), kept in memory (≤ 20 MB each by default) and
 * checked by check.service (type by content, pages, encryption) before they go to S3.
 * @type {import('express').RequestHandler}
 */
const paperFilesUpload = friendly(
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.uploads.maxPaperMb * MB, files: 3, fields: 0 },
  }).array('files', 3),
  config.uploads.maxPaperMb,
);

module.exports = { referenceFileUpload, paperFilesUpload };
