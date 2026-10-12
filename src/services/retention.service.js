'use strict';

/**
 * The retention job (FR-RET-01…03): permanently deletes what is older than RETENTION_DAYS (7):
 * paper PDFs (from upload), chat messages (from creation) and soft-deleted papers and admin items
 * (from deletion). Safe to run more often. One item that cannot be deleted is logged and retried
 * the next day; it never stops the rest (FR-RET-02).
 */
const config = require('../config');
const retentionModel = require('../models/retention.model');
const { getStorage } = require('../factories/storageFactory');

/**
 * Run the job once.
 * @param {import('pino').Logger} log
 * @param {{days?: number}} [opts]
 * @returns {Promise<object>} counts per category
 */
async function run(log, { days = config.retention.days } = {}) {
  const storage = getStorage();
  const counts = { documents: 0, chatMessages: 0, papers: 0, references: 0, standards: 0, sections: 0, paperTypes: 0, errors: 0 };

  // Delete the S3 object first: if that fails, the row stays and tomorrow's run tries again.
  const attempt = async (what, id, fn) => {
    try {
      await fn();
      return true;
    } catch (err) {
      counts.errors += 1;
      log.error({ err, what, id }, 'Retention: could not delete an item');
      return false;
    }
  };

  for (const doc of await retentionModel.listExpiredDocuments(days)) {
    if (await attempt('document', doc.id, async () => {
      await storage.remove(doc.s3Key);
      await retentionModel.deleteDocument(doc.id);
    })) counts.documents += 1;
  }

  counts.chatMessages = await retentionModel.deleteOldChat(days);

  for (const paper of await retentionModel.listPurgeablePapers(days)) {
    if (await attempt('paper', paper.id, async () => {
      for (const key of paper.keys) await storage.remove(key);
      await retentionModel.deletePaper(paper.id);
    })) counts.papers += 1;
  }

  for (const ref of await retentionModel.listPurgeableReferences(days)) {
    if (await attempt('reference', ref.id, async () => {
      await storage.remove(ref.s3Key);
      await retentionModel.deleteReference(ref.id);
    })) counts.references += 1;
  }

  await attempt('admin items', null, async () => Object.assign(counts, await retentionModel.deleteOldAdminItems(days)));

  log.info({ days, ...counts }, 'Retention job finished');
  return counts;
}

module.exports = { run };
