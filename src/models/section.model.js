'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = 'id, paper_type_id, title, position, created_at, updated_at, deleted_at';

/**
 * Non-deleted sections of a paper type, in order.
 * @param {string} paperTypeId
 * @returns {Promise<object[]>}
 */
async function listForType(paperTypeId) {
  const { rows } = await query(
    `select ${COLUMNS} from sections where paper_type_id = $1 and deleted_at is null order by position, created_at`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * A section whose paper type is not deleted.
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]  true for restore (Undo)
 * @returns {Promise<object|null>}
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select s.id, s.paper_type_id, s.title, s.position, s.deleted_at
       from sections s join paper_types t on t.id = s.paper_type_id and t.deleted_at is null
      where s.id = $1 and ($2 or s.deleted_at is null)`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * Add a section at the end. Positions only grow (deleted rows keep theirs), so a restored section
 * never collides with another.
 * @param {string} paperTypeId
 * @param {string} title
 * @returns {Promise<object>}
 */
async function create(paperTypeId, title) {
  const { rows } = await query(
    `insert into sections (paper_type_id, title, position)
     values ($1, $2, (select coalesce(max(position) + 1, 0) from sections where paper_type_id = $1))
     returning ${COLUMNS}`,
    [paperTypeId, title],
  );
  return toCamel(rows[0]);
}

/**
 * @param {string} id
 * @param {string} title
 * @returns {Promise<object|null>}
 */
async function updateTitle(id, title) {
  const { rows } = await query(
    `update sections set title = $2, updated_at = now() where id = $1 and deleted_at is null returning ${COLUMNS}`,
    [id, title],
  );
  return toCamel(rows[0]);
}

/**
 * The next non-deleted section above or below, for "move" (FR-ADM-19).
 * @param {{id: string, paperTypeId: string, position: number}} section
 * @param {'up'|'down'} direction
 * @returns {Promise<object|null>} null at the top / bottom
 */
async function findNeighbour(section, direction) {
  const up = direction === 'up';
  const { rows } = await query(
    `select ${COLUMNS} from sections
      where paper_type_id = $1 and deleted_at is null and position ${up ? '<' : '>'} $2
      order by position ${up ? 'desc' : 'asc'} limit 1`,
    [section.paperTypeId, section.position],
  );
  return toCamel(rows[0]);
}

/**
 * Swap the positions of two sections. Call inside withTransaction().
 * @param {{id: string, position: number}} a
 * @param {{id: string, position: number}} b
 * @returns {Promise<void>}
 */
async function swapPositions(a, b) {
  await query(
    `update sections set position = case id when $1 then $4::int else $3::int end, updated_at = now()
      where id in ($1, $2)`,
    [a.id, b.id, a.position, b.position],
  );
}

/**
 * Soft delete a section and its non-deleted standards with ONE timestamp, so Undo restores exactly
 * those standards and not ones deleted earlier (FR-ADM-18). Call inside withTransaction().
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function softDeleteWithStandards(id) {
  const { rows } = await query(
    `update sections set deleted_at = now() where id = $1 and deleted_at is null returning deleted_at`,
    [id],
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
 * @returns {Promise<boolean>} false if the section was not deleted
 */
async function restoreWithStandards(id) {
  const { rows } = await query(
    `select deleted_at from sections where id = $1 and deleted_at is not null for update`,
    [id],
  );
  if (!rows[0]) return false;
  await query(`update standards set deleted_at = null where section_id = $1 and deleted_at = $2`, [
    id,
    rows[0].deleted_at,
  ]);
  await query(`update sections set deleted_at = null, updated_at = now() where id = $1`, [id]);
  return true;
}

module.exports = {
  listForType,
  findById,
  create,
  updateTitle,
  findNeighbour,
  swapPositions,
  softDeleteWithStandards,
  restoreWithStandards,
};
