'use strict';

/**
 * Paper PDFs for the compare dialog (docs/06 §3 Files): any signed-in user may read them until the
 * retention job removes them 7 days after upload (FR-AI-17).
 */
const checkModel = require('../models/check.model');
const { getStorage } = require('../factories/storageFactory');
const { NotFoundError } = require('../utils/errors');

/**
 * @param {string} documentId
 * @returns {Promise<{stream, contentLength, fileName}>}
 * @throws {NotFoundError} DOCUMENT_EXPIRED when the PDF was removed
 */
async function openDocument(documentId) {
  const doc = await checkModel.findDocument(documentId);
  const file = doc && (await getStorage().get(doc.s3Key));
  if (!file) throw new NotFoundError('The PDF was removed after 7 days. Upload it again to see pages.', 'DOCUMENT_EXPIRED');
  return { stream: file.stream, contentLength: file.contentLength, fileName: doc.fileName };
}

module.exports = { openDocument };
