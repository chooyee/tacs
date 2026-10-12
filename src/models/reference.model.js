'use strict';

const { query, toCamel } = require('../utils/db');

/**
 * The reference library (D-37): policies, samples, templates and guides shared by all paper types.
 * `paper_type_id` is a legacy column (where a reference came from) and is no longer used.
 */
const COLUMNS = `id, type, title, note, guidance_html, url, s3_key, file_name, mime_type, size_bytes,
  page_count, created_at, updated_at, updated_by, deleted_at`;

/** Count of visible standards linking to a reference, and of paper types they belong to. */
const USAGE = `
  (select count(*)::int from standard_references sr
     join standards s on s.id = sr.standard_id and s.deleted_at is null
     join sections sec on sec.id = s.section_id and sec.deleted_at is null
     join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null
    where sr.reference_id = r.id) as linked_count,
  (select count(distinct sec.paper_type_id)::int from standard_references sr
     join standards s on s.id = sr.standard_id and s.deleted_at is null
     join sections sec on sec.id = s.section_id and sec.deleted_at is null
     join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null
    where sr.reference_id = r.id) as type_count`;

/**
 * Every non-deleted reference in the library, by title, with usage counts.
 * @returns {Promise<object[]>}
 */
async function listAll() {
  const { rows } = await query(
    `select r.id, r.type, r.title, r.note, r.url, r.file_name, r.mime_type, r.size_bytes, r.page_count,
            r.updated_at, r.updated_by, ${USAGE}
       from reference_docs r
      where r.deleted_at is null
      order by lower(r.title)`,
  );
  return rows.map(toCamel);
}

/**
 * The references linked from a paper type's standards (the "used here" list in the type editor).
 * @param {string} paperTypeId
 * @returns {Promise<object[]>}
 */
async function listUsedByType(paperTypeId) {
  const { rows } = await query(
    `select r.id, r.type, r.title, r.note, r.url, r.mime_type, r.updated_at, r.updated_by,
            count(*)::int as linked_count
       from reference_docs r
       join standards s on s.deleted_at is null
       join sections sec on sec.id = s.section_id and sec.deleted_at is null
       join standard_references sr on sr.reference_id = r.id
                                  and sr.standard_id = coalesce(s.source_standard_id, s.id) -- live links (D-38)
      where sec.paper_type_id = $1 and r.deleted_at is null
      group by r.id
      order by lower(r.title)`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * Id, type and title of every reference — the options of the standard dialog's picker.
 * @returns {Promise<Array<{id: string, type: string, title: string}>>}
 */
async function listOptions() {
  const { rows } = await query(
    `select id, type, title from reference_docs where deleted_at is null order by lower(title)`,
  );
  return rows;
}

/**
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<object|null>}
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select ${COLUMNS.replace(/\n\s*/g, ' ')}, ${USAGE}
       from reference_docs r where r.id = $1 and ($2 or r.deleted_at is null)`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * How many of these IDs are non-deleted references (to validate a link set).
 * @param {string[]} ids
 * @returns {Promise<number>}
 */
async function countExisting(ids) {
  const { rows } = await query(
    `select count(*)::int as n from reference_docs where deleted_at is null and id = any($1::uuid[])`,
    [ids],
  );
  return rows[0].n;
}

/**
 * @param {object} ref  `id` is chosen by the caller because the S3 key contains it
 * @returns {Promise<object>}
 */
async function create(ref) {
  const { rows } = await query(
    `insert into reference_docs
       (id, type, title, note, guidance_html, url, s3_key, file_name, mime_type, size_bytes, page_count, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning ${COLUMNS}`,
    [
      ref.id,
      ref.type,
      ref.title,
      ref.note,
      ref.guidanceHtml,
      ref.url,
      ref.s3Key,
      ref.fileName,
      ref.mimeType,
      ref.sizeBytes,
      ref.pageCount,
      ref.updatedBy,
    ],
  );
  return toCamel(rows[0]);
}

const UPDATABLE = {
  type: 'type',
  title: 'title',
  note: 'note',
  guidanceHtml: 'guidance_html',
  url: 'url',
  s3Key: 's3_key',
  fileName: 'file_name',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes',
  pageCount: 'page_count',
  updatedBy: 'updated_by',
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
 * Soft delete. Links stay in standard_references but are hidden, so Undo brings them back (FR-ADM-13).
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>}
 */
async function softDelete(id, updatedBy) {
  const { rowCount } = await query(
    'update reference_docs set deleted_at = now(), updated_by = $2 where id = $1 and deleted_at is null',
    [id, updatedBy],
  );
  return rowCount === 1;
}

/**
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>}
 */
async function restore(id, updatedBy) {
  const { rowCount } = await query(
    `update reference_docs set deleted_at = null, updated_at = now(), updated_by = $2
      where id = $1 and deleted_at is not null`,
    [id, updatedBy],
  );
  return rowCount === 1;
}

/**
 * The (non-deleted) standards a reference applies to, grouped by paper type and numbered like on
 * the paper (FR-REF-02 "Used for").
 * @param {string} id
 * @returns {Promise<Array<{id, title, number, paperTypeId, paperTypeName}>>}
 */
async function listLinkedStandards(id) {
  const { rows } = await query(
    `with numbered as (
       select s.id, s.title, t.id as paper_type_id, t.name as paper_type_name,
              row_number() over (partition by t.id
                                  order by sec.position, sec.created_at, s.position, s.created_at)::int as number
         from standards s
         join sections sec on sec.id = s.section_id and sec.deleted_at is null
         join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null
        where s.deleted_at is null)
     select n.* from numbered n
       join standard_references sr on sr.standard_id = n.id and sr.reference_id = $1
      order by lower(n.paper_type_name), n.number`,
    [id],
  );
  return rows.map(toCamel);
}

/**
 * Every reference with the text the standard form searches in (title, type, guidance summary).
 * @returns {Promise<Array<{id, type, title, note}>>}
 */
async function listAllForPicker() {
  const { rows } = await query(
    `select id, type, title, note from reference_docs where deleted_at is null order by lower(title)`,
  );
  return rows;
}

module.exports = {
  listAllForPicker,
  listAll,
  listUsedByType,
  listOptions,
  findById,
  countExisting,
  create,
  update,
  softDelete,
  restore,
  listLinkedStandards,
};
