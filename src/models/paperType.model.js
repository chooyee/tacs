'use strict';

const { query, toCamel } = require('../utils/db');
const { ConflictError } = require('../utils/errors');

const COLUMNS = 'id, name, description, created_at, updated_at, deleted_at';

/** Postgres "unique violation" on the active-name index → a friendly 409. */
function nameTaken(err) {
  if (err.code === '23505' && err.constraint === 'paper_types_name_active_uq') {
    return new ConflictError('A paper type with this name already exists.', 'NAME_TAKEN');
  }
  return err;
}

/**
 * All non-deleted paper types with the numbers shown on their cards (FR-ADM-01), by name.
 * @returns {Promise<Array<{id, name, description, papersCount, standardsCount, mandatoryCount, referencesCount}>>}
 */
async function listWithStats() {
  const { rows } = await query(
    `select t.id, t.name, t.description,
            (select count(*)::int from papers p where p.paper_type_id = t.id and p.deleted_at is null) as papers_count,
            (select count(*)::int from standards s join sections sec on sec.id = s.section_id
              where sec.paper_type_id = t.id and sec.deleted_at is null and s.deleted_at is null) as standards_count,
            (select count(*)::int from standards s join sections sec on sec.id = s.section_id
              where sec.paper_type_id = t.id and sec.deleted_at is null and s.deleted_at is null
                and s.is_mandatory) as mandatory_count,
            (select count(*)::int from reference_docs r
              where r.paper_type_id = t.id and r.deleted_at is null) as references_count
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
 * @param {{name: string, description: string|null}} type
 * @returns {Promise<object>}
 * @throws {ConflictError} NAME_TAKEN
 */
async function create({ name, description }) {
  try {
    const { rows } = await query(
      `insert into paper_types (name, description) values ($1, $2) returning ${COLUMNS}`,
      [name, description],
    );
    return toCamel(rows[0]);
  } catch (err) {
    throw nameTaken(err);
  }
}

/**
 * Change name and/or description; undefined fields stay as they are.
 * @param {string} id
 * @param {{name?: string, description?: string|null}} changes
 * @returns {Promise<object|null>}
 * @throws {ConflictError} NAME_TAKEN
 */
async function update(id, { name, description }) {
  try {
    const { rows } = await query(
      `update paper_types
          set name = coalesce($2, name),
              description = case when $4 then $3 else description end,
              updated_at = now()
        where id = $1 and deleted_at is null
        returning ${COLUMNS}`,
      [id, name ?? null, description ?? null, description !== undefined],
    );
    return toCamel(rows[0]);
  } catch (err) {
    throw nameTaken(err);
  }
}

/**
 * Soft delete (purged by the retention job after 7 days, FR-RET-01).
 * @param {string} id
 * @returns {Promise<boolean>} false if it did not exist
 */
async function softDelete(id) {
  const { rowCount } = await query(
    'update paper_types set deleted_at = now() where id = $1 and deleted_at is null',
    [id],
  );
  return rowCount === 1;
}

module.exports = { listWithStats, findById, create, update, softDelete };
