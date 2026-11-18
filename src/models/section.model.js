'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS =
  'id, paper_type_id, version_id, title, position, created_at, updated_at, updated_by, deleted_at';

/**
 * Non-deleted sections of one paper type version (D-45), in order.
 * @param {string} versionId
 * @returns {Promise<object[]>}
 */
async function listForVersion(versionId) {
  const { rows } = await query(
    `select ${COLUMNS} from sections where version_id = $1 and deleted_at is null order by position, created_at`,
    [versionId],
  );
  return rows.map(toCamel);
}

/**
 * A section whose paper type is not deleted, with its version's status (only a draft can change).
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]  true for restore (Undo)
 * @returns {Promise<object|null>}
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select s.id, s.paper_type_id, s.version_id, v.status as version_status, s.title, s.position, s.deleted_at
       from sections s
       join paper_type_versions v on v.id = s.version_id
       join paper_types t on t.id = s.paper_type_id and t.deleted_at is null
      where s.id = $1 and ($2 or s.deleted_at is null)`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * Add a section at the end of a version.
 * @param {string} versionId
 * @param {string} title
 * @param {string|null} updatedBy
 * @returns {Promise<object>}
 */
async function create(versionId, title, updatedBy = null) {
  const { rows } = await query(
    `insert into sections (paper_type_id, version_id, title, updated_by, position)
     select v.paper_type_id, v.id, $2, $3, (select coalesce(max(position) + 1, 0) from sections where version_id = v.id)
       from paper_type_versions v where v.id = $1
     returning ${COLUMNS}`,
    [versionId, title, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} updatedBy
 * @returns {Promise<object|null>}
 */
async function updateTitle(id, title, updatedBy) {
  const { rows } = await query(
    `update sections set title = $2, updated_by = $3, updated_at = now()
      where id = $1 and deleted_at is null returning ${COLUMNS}`,
    [id, title, updatedBy],
  );
  return toCamel(rows[0]);
}

/**
 * IDs of the visible sections of a version, in order.
 * @param {string} versionId
 * @returns {Promise<string[]>}
 */
async function listIds(versionId) {
  const { rows } = await query(
    `select id from sections where version_id = $1 and deleted_at is null order by position, created_at`,
    [versionId],
  );
  return rows.map((r) => r.id);
}

/**
 * Store a new order for the sections of a version (positions 0…n-1). Call inside withTransaction().
 * @param {string[]} orderedIds  every visible section of the type, in the new order
 * @returns {Promise<void>}
 */
async function reorder(orderedIds) {
  await query(
    `update sections s set position = o.pos - 1
       from unnest($1::uuid[]) with ordinality as o(id, pos)
      where s.id = o.id`,
    [orderedIds],
  );
}

/**
 * Soft delete a section and its non-deleted standards with ONE timestamp, so Undo restores exactly
 * those standards and not ones deleted earlier (FR-ADM-18). Call inside withTransaction().
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>}
 */
async function softDeleteWithStandards(id, updatedBy) {
  const { rows } = await query(
    `update sections set deleted_at = now(), updated_by = $2 where id = $1 and deleted_at is null returning deleted_at`,
    [id, updatedBy],
  );
  if (!rows[0]) return false;
  await query(`update standards set deleted_at = $2 where section_id = $1 and deleted_at is null`, [
    id,
    rows[0].deleted_at,
  ]);
  return true;
}

/**
 * Undo softDeleteWithStandards. Call inside withTransaction().
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>} false if the section was not deleted
 */
async function restoreWithStandards(id, updatedBy) {
  const { rows } = await query(
    `select deleted_at from sections where id = $1 and deleted_at is not null for update`,
    [id],
  );
  if (!rows[0]) return false;
  await query(`update standards set deleted_at = null where section_id = $1 and deleted_at = $2`, [
    id,
    rows[0].deleted_at,
  ]);
  await query(`update sections set deleted_at = null, updated_at = now(), updated_by = $2 where id = $1`, [
    id,
    updatedBy,
  ]);
  return true;
}

module.exports = {
  listForVersion,
  findById,
  create,
  updateTitle,
  listIds,
  reorder,
  softDeleteWithStandards,
  restoreWithStandards,
};
