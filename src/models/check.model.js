'use strict';

const { query, toCamel } = require('../utils/db');
const { ConflictError } = require('../utils/errors');

/**
 * Paper PDFs, AI checks (the background job queue) and their results (docs/05 §3.9–3.12).
 * A check reads the paper's current documents; only the LATEST COMPLETED check drives the UI and
 * readiness (FR-AI-13). PDFs are deleted 7 days after upload, results stay (FR-RET-03).
 */

const CHECK_COLUMNS = `c.id, c.paper_id, c.requested_by, c.status, c.step, c.provider, c.model, c.prompt_version,
  c.standards_snapshot, c.error_code, c.error_message, c.input_tokens, c.output_tokens, c.started_at,
  c.finished_at, c.created_at`;

/* ---------- Documents ---------- */

/**
 * Add uploaded PDFs as the paper's current documents; earlier ones stop being current (a new upload
 * replaces them, FR-AI-13). Call inside a transaction.
 * @param {string} paperId
 * @param {Array<{id, s3Key, fileName, sizeBytes, pageCount}>} docs
 * @returns {Promise<void>}
 */
async function replaceCurrentDocuments(paperId, docs) {
  await query('update paper_documents set is_current = false where paper_id = $1 and is_current', [paperId]);
  for (const d of docs) {
    await query(
      `insert into paper_documents (id, paper_id, s3_key, file_name, size_bytes, page_count)
       values ($1, $2, $3, $4, $5, $6)`,
      [d.id, paperId, d.s3Key, d.fileName, d.sizeBytes, d.pageCount],
    );
  }
}

/**
 * The paper's current documents that still exist (not yet removed by retention).
 * @param {string} paperId
 * @returns {Promise<Array<{id, s3Key, fileName, sizeBytes, pageCount, createdAt}>>}
 */
async function listCurrentDocuments(paperId) {
  const { rows } = await query(
    `select id, s3_key, file_name, size_bytes, page_count, created_at
       from paper_documents where paper_id = $1 and is_current order by created_at, file_name`,
    [paperId],
  );
  return rows.map(toCamel);
}

/**
 * One document with its paper (for streaming it to the browser).
 * @param {string} documentId
 * @returns {Promise<object|null>}
 */
async function findDocument(documentId) {
  const { rows } = await query(
    `select d.id, d.paper_id, d.s3_key, d.file_name, d.page_count
       from paper_documents d join papers p on p.id = d.paper_id and p.deleted_at is null
      where d.id = $1`,
    [documentId],
  );
  return toCamel(rows[0]);
}

/* ---------- Checks ---------- */

/**
 * Queue a check over the given documents.
 * @param {{paperId: string, requestedBy: string, documentIds: string[]}} check
 * @returns {Promise<{id: string, status: string}>}
 * @throws {ConflictError} CHECK_RUNNING — only one active check per paper (FR-AI-05)
 */
async function createCheck({ paperId, requestedBy, documentIds }) {
  let check;
  try {
    const { rows } = await query(
      `insert into checks (paper_id, requested_by, status) values ($1, $2, 'queued') returning id, status`,
      [paperId, requestedBy],
    );
    check = rows[0];
  } catch (err) {
    if (err.code === '23505') throw new ConflictError('A check is already running for this paper.', 'CHECK_RUNNING');
    throw err;
  }
  await query(
    `insert into check_documents (check_id, document_id) select $1, unnest($2::uuid[])`,
    [check.id, documentIds],
  );
  return check;
}

/**
 * @param {string} checkId
 * @returns {Promise<object|null>}
 */
async function findCheck(checkId) {
  const { rows } = await query(`select ${CHECK_COLUMNS} from checks c where c.id = $1`, [checkId]);
  return toCamel(rows[0]);
}

/**
 * The paper's active (queued or running) check, if any.
 * @param {string} paperId
 * @returns {Promise<object|null>}
 */
async function findActiveCheck(paperId) {
  const { rows } = await query(
    `select ${CHECK_COLUMNS} from checks c where c.paper_id = $1 and c.status in ('queued', 'running')`,
    [paperId],
  );
  return toCamel(rows[0]);
}

/**
 * The newest check of a paper, whatever its status (the chat shows its progress or failure).
 * @param {string} paperId
 * @returns {Promise<object|null>}
 */
async function findLatestCheck(paperId) {
  const { rows } = await query(
    `select ${CHECK_COLUMNS} from checks c where c.paper_id = $1 order by c.created_at desc limit 1`,
    [paperId],
  );
  return toCamel(rows[0]);
}

/**
 * The latest COMPLETED check of a paper (FR-AI-13), with the documents it read that still exist.
 * @param {string} paperId
 * @returns {Promise<object|null>}  includes `documents`
 */
async function findLatestDone(paperId) {
  const { rows } = await query(
    `select ${CHECK_COLUMNS},
            coalesce((select json_agg(json_build_object('id', d.id, 'fileName', d.file_name, 'pageCount', d.page_count,
                                                         'createdAt', d.created_at) order by d.created_at, d.file_name)
                        from check_documents cd join paper_documents d on d.id = cd.document_id
                       where cd.check_id = c.id), '[]') as documents
       from checks c
      where c.paper_id = $1 and c.status = 'done'
      order by c.finished_at desc limit 1`,
    [paperId],
  );
  return toCamel(rows[0]);
}

/**
 * Documents a check reads, with their S3 keys (the worker).
 * @param {string} checkId
 * @returns {Promise<Array<{id, s3Key, fileName, pageCount}>>}
 */
async function listCheckDocuments(checkId) {
  const { rows } = await query(
    `select d.id, d.s3_key, d.file_name, d.page_count
       from check_documents cd join paper_documents d on d.id = cd.document_id
      where cd.check_id = $1 order by d.created_at, d.file_name`,
    [checkId],
  );
  return rows.map(toCamel);
}

/**
 * How many checks a user started since `since` (rate limit, docs/07 §9).
 * @param {string} userId
 * @param {Date} since
 * @returns {Promise<number>}
 */
async function countByUserSince(userId, since) {
  const { rows } = await query(
    'select count(*)::int as n from checks where requested_by = $1 and created_at > $2',
    [userId, since],
  );
  return rows[0].n;
}

/**
 * Take the oldest queued check and mark it running. SKIP LOCKED: several app instances never take
 * the same check (docs/04 §7 rule 2).
 * @returns {Promise<object|null>}
 */
async function claimNext() {
  const { rows } = await query(
    `update checks set status = 'running', step = 1, started_at = now()
      where id = (select id from checks where status = 'queued' order by created_at
                   for update skip locked limit 1)
      returning id, paper_id, requested_by`,
  );
  return toCamel(rows[0]);
}

/**
 * @param {string} checkId
 * @param {number} step  1–4 (docs/04 §7 rule 6)
 */
async function setStep(checkId, step) {
  await query(`update checks set step = $2 where id = $1 and status = 'running'`, [checkId, step]);
}

/**
 * Save the results and mark the check done, in the caller's transaction.
 * @param {string} checkId
 * @param {{provider, model, promptVersion, snapshot, inputTokens, outputTokens}} meta
 * @param {Array<object>} results  rows for check_results (IDs already mapped from the AI's keys)
 */
async function complete(checkId, meta, results) {
  for (const r of results) {
    await query(
      `insert into check_results (check_id, standard_id, verdict, page, document_id, area, bbox, finding,
                                  reference_id, reference_page, confidence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        checkId,
        r.standardId,
        r.verdict,
        r.page,
        r.documentId,
        r.area,
        r.bbox ? JSON.stringify(r.bbox) : null,
        r.finding,
        r.referenceId,
        r.referencePage,
        r.confidence,
      ],
    );
  }
  await query(
    `update checks set status = 'done', step = 4, finished_at = now(), provider = $2, model = $3,
            prompt_version = $4, standards_snapshot = $5, input_tokens = $6, output_tokens = $7
      where id = $1`,
    [
      checkId,
      meta.provider,
      meta.model,
      meta.promptVersion,
      JSON.stringify(meta.snapshot),
      meta.inputTokens,
      meta.outputTokens,
    ],
  );
}

/**
 * Mark a check failed with a stable code and a user-safe message.
 * @param {string} checkId
 * @param {{code: string, message: string, provider?: string, model?: string}} failure
 */
async function fail(checkId, { code, message, provider = null, model = null }) {
  await query(
    `update checks set status = 'failed', finished_at = now(), error_code = $2, error_message = $3,
            provider = coalesce($4, provider), model = coalesce($5, model)
      where id = $1 and status in ('queued', 'running')`,
    [checkId, code, message, provider, model],
  );
}

/**
 * Checks stuck in "running" longer than `timeoutMs` (a crashed instance) → failed (docs/04 §7 rule 4).
 * @param {number} timeoutMs
 * @returns {Promise<Array<{id, paperId}>>}
 */
async function failStuck(timeoutMs) {
  const { rows } = await query(
    `update checks set status = 'failed', finished_at = now(), error_code = 'CHECK_TIMEOUT',
            error_message = 'The check took too long.'
      where status = 'running' and started_at < now() - ($1::int * interval '1 millisecond')
      returning id, paper_id`,
    [timeoutMs],
  );
  return rows.map(toCamel);
}

/* ---------- Results ---------- */

/**
 * The results of a check.
 * @param {string} checkId
 * @returns {Promise<object[]>}
 */
async function listResults(checkId) {
  const { rows } = await query(
    `select standard_id, verdict, page, document_id, area, bbox, finding, reference_id, reference_page,
            confidence, kept_by_user_at
       from check_results where check_id = $1`,
    [checkId],
  );
  return rows.map(toCamel);
}

/**
 * The latest completed check's results of many papers (the cards on the home page).
 * @param {string[]} paperIds
 * @returns {Promise<Array<{paperId, standardId, verdict, kept}>>}
 */
async function listLatestResultsForPapers(paperIds) {
  if (!paperIds.length) return [];
  const { rows } = await query(
    `with latest as (
       select distinct on (paper_id) id, paper_id from checks
        where status = 'done' and paper_id = any($1::uuid[])
        order by paper_id, finished_at desc)
     select l.paper_id as "paperId", r.standard_id as "standardId", r.verdict,
            r.kept_by_user_at is not null as kept
       from latest l join check_results r on r.check_id = l.id`,
    [paperIds],
  );
  return rows;
}

/**
 * "Keep mine" (FR-AI-10): resolve the issue of one standard for this check.
 * @param {string} checkId
 * @param {string} standardId
 * @returns {Promise<boolean>}
 */
async function keep(checkId, standardId) {
  const { rowCount } = await query(
    'update check_results set kept_by_user_at = now() where check_id = $1 and standard_id = $2',
    [checkId, standardId],
  );
  return rowCount === 1;
}

module.exports = {
  replaceCurrentDocuments,
  listCurrentDocuments,
  findDocument,
  createCheck,
  findCheck,
  findActiveCheck,
  findLatestCheck,
  findLatestDone,
  listCheckDocuments,
  countByUserSince,
  claimNext,
  setStep,
  complete,
  fail,
  failStuck,
  listResults,
  listLatestResultsForPapers,
  keep,
};
