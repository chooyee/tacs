'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = `id, paper_type_id, type, title, note, url, s3_key, file_name, mime_type, size_bytes,
  page_count, created_at, updated_at, deleted_at`;

/**
 * Non-deleted references of a paper type with "linked to N standards" (FR-ADM-11), oldest first.
 * Includes s3Key for copying a type; views must not show it.
 * @param {string} paperTypeId
 * @returns {Promise<object[]>}
 */
async function listForType(paperTypeId) {
  const { rows } = await query(
    `select r.id, r.paper_type_id, r.type, r.title, r.note, r.url, r.s3_key, r.file_name, r.mime_type,
            r.size_bytes, r.page_count, r.created_at,
            (select count(*)::int from standard_references sr
               join standards s on s.id = sr.standard_id and s.deleted_at is null
               join sections sec on sec.id = s.section_id and sec.deleted_at is null
              where sr.reference_id = r.id) as linked_count
       from reference_docs r
      where r.paper_type_id = $1 and r.deleted_at is null
      order by r.created_at`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * A reference whose paper type is not deleted.
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object|null>}
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select r.id, r.paper_type_id, r.type, r.title, r.note, r.url, r.s3_key, r.file_name, r.mime_type,
            r.size_bytes, r.page_count, r.created_at, r.updated_at, r.deleted_at
       from reference_docs r join paper_types t on t.id = r.paper_type_id and t.deleted_at is null
      where r.id = $1 and ($2 or r.deleted_at is null)`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * How many of these IDs are non-deleted references of the paper type (to validate a link set).
 * @param {string} paperTypeId
 * @param {string[]} ids
 * @returns {Promise<number>}
 */
async function countInType(paperTypeId, ids) {
  const { rows } = await query(
    `select count(*)::int as n from reference_docs
      where paper_type_id = $1 and deleted_at is null and id = any($2::uuid[])`,
    [paperTypeId, ids],
  );
  return rows[0].n;
}

/**
 * @param {{id: string, paperTypeId: string, type: string, title: string, note: string|null, url: string|null,
 *          s3Key: string, fileName: string, mimeType: string, sizeBytes: number, pageCount: number|null}} ref
 *        `id` is chosen by the caller because the S3 key contains it
 * @returns {Promise<object>}
 */
async function create(ref) {
  const { rows } = await query(
    `insert into reference_docs
       (id, paper_type_id, type, title, note, url, s3_key, file_name, mime_type, size_bytes, page_count)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning ${COLUMNS}`,
    [
      ref.id,
      ref.paperTypeId,
      ref.type,
      ref.title,
      ref.note,
      ref.url,
      ref.s3Key,
      ref.fileName,
      ref.mimeType,
      ref.sizeBytes,
      ref.pageCount,
    ],
  );
  return toCamel(rows[0]);
}

const UPDATABLE = {
  type: 'type',
  title: 'title',
  note: 'note',
  url: 'url',
  s3Key: 's3_key',
  fileName: 'file_name',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes',
  pageCount: 'page_count',
};

/**
 * Update the given fields only (a key present with value null clears it, e.g. `url: null`).
 * @param {string} id
 * @param {object} changes  keys from UPDATABLE
 * @returns {Promise<object|null>}
 */
async function update(id, changes) {
  const entries = Object.entries(changes).filter(([key, value]) => key in UPDATABLE && value !== undefined);
  // Column names come from the fixed UPDATABLE map, never from input; values are parameters.
  const sets = entries.map(([key], i) => `${UPDATABLE[key]} = $${i + 2}`);
  const { rows } = await query(
    `update reference_docs set ${[...sets, 'updated_at = now()'].join(', ')}
      where id = $1 and deleted_at is null
      returning ${COLUMNS}`,
    [id, ...entries.map(([, value]) => value)],
  );
  return toCamel(rows[0]);
}

/**
 * Soft delete. Links stay in standard_references but are hidden (queries skip deleted references),
 * so Undo brings them back (FR-ADM-13).
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function softDelete(id) {
  const { rowCount } = await query(
    'update reference_docs set deleted_at = now() where id = $1 and deleted_at is null',
    [id],
  );
  return rowCount === 1;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function restore(id) {
  const { rowCount } = await query(
    'update reference_docs set deleted_at = null, updated_at = now() where id = $1 and deleted_at is not null',
    [id],
  );
  return rowCount === 1;
}

/**
 * The (non-deleted) standards a reference applies to, numbered like on the paper (FR-REF-02 "Used for").
 * @param {string} id
 * @returns {Promise<Array<{id: string, text: string, number: number}>>}
 */
async function listLinkedStandards(id) {
  const { rows } = await query(
    `with numbered as (
       select s.id, s.text,
              row_number() over (order by sec.position, sec.created_at, s.position, s.created_at)::int as number
         from standards s
         join sections sec on sec.id = s.section_id and sec.deleted_at is null
        where sec.paper_type_id = (select paper_type_id from reference_docs where id = $1)
          and s.deleted_at is null)
     select n.id, n.text, n.number from numbered n
       join standard_references sr on sr.standard_id = n.id and sr.reference_id = $1
      order by n.number`,
    [id],
  );
  return rows;
}

module.exports = {
  listForType,
  findById,
  countInType,
  create,
  update,
  softDelete,
  restore,
  listLinkedStandards,
};
