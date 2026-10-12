'use strict';

const { query } = require('../utils/db');

/**
 * Answers (docs/05 §3.8): one row per paper + standard, written with an upsert. Rows of standards an
 * admin deleted stay in the table (FR-ANS-15) — callers only show answers of visible standards.
 */

/**
 * Every answer of the given papers.
 * @param {string[]} paperIds
 * @returns {Promise<Array<{paperId: string, standardId: string, value: string|null, remark: string}>>}
 */
async function listForPapers(paperIds) {
  if (!paperIds.length) return [];
  const { rows } = await query(
    `select paper_id as "paperId", standard_id as "standardId", value, remark
       from answers where paper_id = any($1::uuid[])`,
    [paperIds],
  );
  return rows;
}

/**
 * Save the whole answer (value + remark). Idempotent: the same body twice gives the same row.
 * @param {{paperId: string, standardId: string, value: 'yes'|'no'|'na'|null, remark: string}} answer
 * @returns {Promise<{standardId: string, value: string|null, remark: string}>}
 */
async function upsert({ paperId, standardId, value, remark }) {
  const { rows } = await query(
    `insert into answers (paper_id, standard_id, value, remark) values ($1, $2, $3, $4)
     on conflict (paper_id, standard_id)
       do update set value = excluded.value, remark = excluded.remark, updated_at = now()
     returning standard_id as "standardId", value, remark`,
    [paperId, standardId, value, remark],
  );
  return rows[0];
}

module.exports = { listForPapers, upsert };
