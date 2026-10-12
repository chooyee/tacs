'use strict';

const { query } = require('../utils/db');

/**
 * SQL for the retention job (FR-RET-01): what is older than N days, and deleting it for good.
 * Answers, remarks and check results are never removed here while their paper exists (FR-RET-03).
 */

const OLDER = '< now() - make_interval(days => $1::int)';

/**
 * Paper PDFs uploaded more than `days` ago (FR-RET-01 a).
 * @param {number} days
 * @returns {Promise<Array<{id: string, s3Key: string}>>}
 */
async function listExpiredDocuments(days) {
  const { rows } = await query(`select id, s3_key as "s3Key" from paper_documents where created_at ${OLDER}`, [days]);
  return rows;
}

/** @param {string} id */
async function deleteDocument(id) {
  await query('delete from paper_documents where id = $1', [id]);
}

/**
 * Chat messages older than `days` (FR-RET-01 b).
 * @param {number} days
 * @returns {Promise<number>} how many were deleted
 */
async function deleteOldChat(days) {
  const { rowCount } = await query(`delete from chat_messages where created_at ${OLDER}`, [days]);
  return rowCount;
}

/**
 * Papers soft-deleted more than `days` ago, with the S3 keys of their documents (FR-RET-01 c).
 * @param {number} days
 * @returns {Promise<Array<{id: string, keys: string[]}>>}
 */
async function listPurgeablePapers(days) {
  const { rows } = await query(
    `select p.id, coalesce(array_agg(d.s3_key) filter (where d.id is not null), '{}') as keys
       from papers p left join paper_documents d on d.paper_id = p.id
      where p.deleted_at ${OLDER}
      group by p.id`,
    [days],
  );
  return rows;
}

/** Delete a paper; answers, documents, checks, results and chat go with it (on delete cascade). */
async function deletePaper(id) {
  await query('delete from papers where id = $1', [id]);
}

/**
 * Library references soft-deleted more than `days` ago (FR-RET-01 c).
 * @param {number} days
 * @returns {Promise<Array<{id: string, s3Key: string}>>}
 */
async function listPurgeableReferences(days) {
  const { rows } = await query(`select id, s3_key as "s3Key" from reference_docs where deleted_at ${OLDER}`, [days]);
  return rows;
}

/** Delete a reference; its links to standards and its link rows go with it. */
async function deleteReference(id) {
  await query('delete from reference_docs where id = $1', [id]);
}

/**
 * Admin items soft-deleted more than `days` ago: standards, then sections, then paper types (FR-RET-01 c).
 * A paper type that still has papers is skipped (it cannot be deleted while in use).
 * @param {number} days
 * @returns {Promise<{standards: number, sections: number, paperTypes: number}>}
 */
async function deleteOldAdminItems(days) {
  const standards = await query(`delete from standards where deleted_at ${OLDER}`, [days]);
  const sections = await query(`delete from sections where deleted_at ${OLDER}`, [days]);
  const types = await query(
    `delete from paper_types t where t.deleted_at ${OLDER}
        and not exists (select 1 from papers p where p.paper_type_id = t.id)`,
    [days],
  );
  return { standards: standards.rowCount, sections: sections.rowCount, paperTypes: types.rowCount };
}

module.exports = {
  listExpiredDocuments,
  deleteDocument,
  deleteOldChat,
  listPurgeablePapers,
  deletePaper,
  listPurgeableReferences,
  deleteReference,
  deleteOldAdminItems,
};
