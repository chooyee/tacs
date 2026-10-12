'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = 'id, section_id, text, is_mandatory, position, created_at, updated_at, deleted_at';

/**
 * Every visible standard of a paper type in display order, numbered 1…N across the whole type
 * (FR-ANS-02), with the IDs of its non-deleted references. One query (docs/05 §4).
 * @param {string} paperTypeId
 * @returns {Promise<Array<{id, sectionId, text, isMandatory, position, number, referenceIds: string[]}>>}
 */
async function listForType(paperTypeId) {
  const { rows } = await query(
    `select s.id, s.section_id, s.text, s.is_mandatory, s.position,
            row_number() over (order by sec.position, sec.created_at, s.position, s.created_at)::int as number,
            coalesce(array_agg(r.id order by r.created_at) filter (where r.id is not null), '{}') as reference_ids
       from standards s
       join sections sec on sec.id = s.section_id and sec.deleted_at is null
       left join standard_references sr on sr.standard_id = s.id
       left join reference_docs r on r.id = sr.reference_id and r.deleted_at is null
      where sec.paper_type_id = $1 and s.deleted_at is null
      group by s.id, sec.position, sec.created_at
      order by sec.position, sec.created_at, s.position, s.created_at`,
    [paperTypeId],
  );
  return rows.map(toCamel);
}

/**
 * A standard with its section's paper type (whose type is not deleted).
 * @param {string} id
 * @param {{includeDeleted?: boolean}} [opts]  true for restore (Undo)
 * @returns {Promise<object|null>}  includes paperTypeId and sectionDeleted
 */
async function findById(id, { includeDeleted = false } = {}) {
  const { rows } = await query(
    `select s.id, s.section_id, s.text, s.is_mandatory, s.position, s.deleted_at,
            sec.paper_type_id, sec.deleted_at is not null as section_deleted
       from standards s
       join sections sec on sec.id = s.section_id
       join paper_types t on t.id = sec.paper_type_id and t.deleted_at is null
      where s.id = $1 and ($2 or (s.deleted_at is null and sec.deleted_at is null))`,
    [id, includeDeleted],
  );
  return toCamel(rows[0]);
}

/**
 * Add an optional standard without references at the end of a section (FR-ADM-16).
 * @param {string} sectionId
 * @param {string} text
 * @returns {Promise<object>}
 */
async function create(sectionId, text, { isMandatory = false } = {}) {
  const { rows } = await query(
    `insert into standards (section_id, text, is_mandatory, position)
     values ($1, $2, $3, (select coalesce(max(position) + 1, 0) from standards where section_id = $1))
     returning ${COLUMNS}`,
    [sectionId, text, isMandatory],
  );
  return toCamel(rows[0]);
}

/**
 * Change text and/or the mandatory flag; undefined fields stay as they are.
 * @param {string} id
 * @param {{text?: string, isMandatory?: boolean}} changes
 * @returns {Promise<object|null>}
 */
async function update(id, { text, isMandatory }) {
  const { rows } = await query(
    `update standards
        set text = coalesce($2, text), is_mandatory = coalesce($3, is_mandatory), updated_at = now()
      where id = $1 and deleted_at is null
      returning ${COLUMNS}`,
    [id, text ?? null, isMandatory ?? null],
  );
  return toCamel(rows[0]);
}

/**
 * Replace the whole set of linked references. Call inside withTransaction().
 * @param {string} id
 * @param {string[]} referenceIds  already checked to belong to the same paper type
 * @returns {Promise<void>}
 */
async function setReferences(id, referenceIds) {
  await query('delete from standard_references where standard_id = $1', [id]);
  if (referenceIds.length) {
    await query(
      `insert into standard_references (standard_id, reference_id)
       select $1, unnest($2::uuid[]) on conflict do nothing`,
      [id, referenceIds],
    );
  }
}

/**
 * The next non-deleted standard above or below in the same section (FR-ADM-19).
 * @param {{id: string, sectionId: string, position: number}} standard
 * @param {'up'|'down'} direction
 * @returns {Promise<object|null>}
 */
async function findNeighbour(standard, direction) {
  const up = direction === 'up';
  const { rows } = await query(
    `select ${COLUMNS} from standards
      where section_id = $1 and deleted_at is null and position ${up ? '<' : '>'} $2
      order by position ${up ? 'desc' : 'asc'} limit 1`,
    [standard.sectionId, standard.position],
  );
  return toCamel(rows[0]);
}

/**
 * Swap the positions of two standards. Call inside withTransaction().
 * @returns {Promise<void>}
 */
async function swapPositions(a, b) {
  await query(
    `update standards set position = case id when $1 then $4::int else $3::int end, updated_at = now()
      where id in ($1, $2)`,
    [a.id, b.id, a.position, b.position],
  );
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function softDelete(id) {
  const { rowCount } = await query(
    'update standards set deleted_at = now() where id = $1 and deleted_at is null',
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
    'update standards set deleted_at = null, updated_at = now() where id = $1 and deleted_at is not null',
    [id],
  );
  return rowCount === 1;
}

module.exports = {
  listForType,
  findById,
  create,
  update,
  setReferences,
  findNeighbour,
  swapPositions,
  softDelete,
  restore,
};
