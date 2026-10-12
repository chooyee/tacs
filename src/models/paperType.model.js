'use strict';

const { query, toCamel } = require('../utils/db');
const { ConflictError } = require('../utils/errors');

const COLUMNS = 'id, name, description, created_at, updated_at, updated_by, deleted_at';

/** Postgres "unique violation" on the active-name index → a friendly 409. */
function nameTaken(err) {
  if (err.code === '23505' && err.constraint === 'paper_types_name_active_uq') {
    return new ConflictError('A paper type with this name already exists.', 'NAME_TAKEN');
  }
  return err;
}

/**
 * All non-deleted paper types with the numbers shown on their cards (FR-ADM-01), by name.
 * References are a shared library (D-37): a type "uses" the references its standards link to.
 * @returns {Promise<object[]>}
 */
async function listWithStats() {
  const { rows } = await query(
    `select t.id, t.name, t.description, t.updated_at, t.updated_by,
            (select count(*)::int from papers p where p.paper_type_id = t.id and p.deleted_at is null) as papers_count,
            (select count(*)::int from standards s join sections sec on sec.id = s.section_id
              where sec.paper_type_id = t.id and sec.deleted_at is null and s.deleted_at is null) as standards_count,
            -- A live link (D-38) takes the mandatory flag of its source.
            (select count(*)::int from standards s join sections sec on sec.id = s.section_id
               left join standards src on src.id = s.source_standard_id
              where sec.paper_type_id = t.id and sec.deleted_at is null and s.deleted_at is null
                and coalesce(src.is_mandatory, s.is_mandatory)) as mandatory_count,
            (select count(distinct sr.reference_id)::int
               from standards s
               join sections sec on sec.id = s.section_id and sec.deleted_at is null
               join standard_references sr on sr.standard_id = coalesce(s.source_standard_id, s.id)
               join reference_docs r on r.id = sr.reference_id and r.deleted_at is null
              where sec.paper_type_id = t.id and s.deleted_at is null) as references_count
       from paper_types t
      where t.deleted_at is null
      order by lower(t.name)`,
  );
  return rows.map(toCamel);
}

/**
 * @param {string} id
 * @returns {Promise<object|null>} the non-deleted paper type
 */
async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from paper_types where id = $1 and deleted_at is null`, [
    id,
  ]);
  return toCamel(rows[0]);
}

/**
 * @param {{name: string, description: string|null, updatedBy: string|null}} type
 * @returns {Promise<object>}
 * @throws {ConflictError} NAME_TAKEN
 */
async function create({ name, description, updatedBy = null }) {
  try {
    const { rows } = await query(
      `insert into paper_types (name, description, updated_by) values ($1, $2, $3) returning ${COLUMNS}`,
      [name, description, updatedBy],
    );
    return toCamel(rows[0]);
  } catch (err) {
    throw nameTaken(err);
  }
}

/**
 * Change name and/or description; undefined fields stay as they are.
 * @param {string} id
 * @param {{name?: string, description?: string|null, updatedBy: string}} changes
 * @returns {Promise<object|null>}
 * @throws {ConflictError} NAME_TAKEN
 */
async function update(id, { name, description, updatedBy }) {
  try {
    const { rows } = await query(
      `update paper_types
          set name = coalesce($2, name),
              description = case when $4 then $3 else description end,
              updated_by = $5, updated_at = now()
        where id = $1 and deleted_at is null
        returning ${COLUMNS}`,
      [id, name ?? null, description ?? null, description !== undefined, updatedBy],
    );
    return toCamel(rows[0]);
  } catch (err) {
    throw nameTaken(err);
  }
}

/**
 * Record that something inside the type changed (a section, standard or link), so the type shows
 * who edited it last and when.
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<void>}
 */
async function touch(id, updatedBy) {
  await query('update paper_types set updated_at = now(), updated_by = $2 where id = $1', [id, updatedBy]);
}

/**
 * Soft delete (purged by the retention job after 7 days, FR-RET-01).
 * @param {string} id
 * @param {string} updatedBy
 * @returns {Promise<boolean>} false if it did not exist
 */
async function softDelete(id, updatedBy) {
  const { rowCount } = await query(
    'update paper_types set deleted_at = now(), updated_by = $2 where id = $1 and deleted_at is null',
    [id, updatedBy],
  );
  return rowCount === 1;
}

module.exports = { listWithStats, findById, create, update, touch, softDelete };
