'use strict';

const { query, toCamel } = require('../utils/db');

/**
 * Papers (docs/05 §3.7): one Solution Lab paper of one paper type, owned by one architect (A-03).
 * Soft delete: `deleted_at` hides the paper; the retention job purges it 7 days later (FR-RET-01).
 */

/** The columns every list and page needs: the paper, its type name and its owner's name. */
const SELECT = `
  select p.id, p.owner_id, p.paper_type_id, p.title, p.vendor, p.created_at, p.updated_at,
         t.name as paper_type_name, coalesce(u.display_name, u.email) as owner_name,
         exists (select 1 from checks c where c.paper_id = p.id and c.status = 'done') as ai_checked
    from papers p
    join paper_types t on t.id = p.paper_type_id
    join users u on u.id = p.owner_id`;

/**
 * Number of non-deleted papers of a paper type (FR-ADM-03: a type in use cannot be deleted;
 * FR-ADM-10: "N in progress").
 * @param {string} paperTypeId
 * @returns {Promise<number>}
 */
async function countActiveByType(paperTypeId) {
  const { rows } = await query(
    'select count(*)::int as n from papers where paper_type_id = $1 and deleted_at is null',
    [paperTypeId],
  );
  return rows[0].n;
}

/**
 * @param {{ownerId: string, paperTypeId: string, title: string, vendor: string|null}} paper
 * @returns {Promise<{id: string}>}
 */
async function create({ ownerId, paperTypeId, title, vendor }) {
  const { rows } = await query(
    `insert into papers (owner_id, paper_type_id, title, vendor) values ($1, $2, $3, $4) returning id`,
    [ownerId, paperTypeId, title, vendor],
  );
  return rows[0];
}

/**
 * A non-deleted paper with its type and owner names.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await query(`${SELECT} where p.id = $1 and p.deleted_at is null`, [id]);
  return toCamel(rows[0]);
}

/**
 * The signed-in user's papers, newest change first (FR-PAP-01).
 * @param {string} ownerId
 * @returns {Promise<object[]>}
 */
async function listByOwner(ownerId) {
  const { rows } = await query(
    `${SELECT} where p.owner_id = $1 and p.deleted_at is null order by p.updated_at desc`,
    [ownerId],
  );
  return rows.map(toCamel);
}

/**
 * One page of every non-deleted paper (FR-PAP-07), newest change first, with the total count.
 * `search` matches title, vendor or owner name (case-insensitive, as plain text, not a pattern).
 *
 * @param {{search?: string, paperTypeId?: string, limit: number, offset: number}} opts
 * @returns {Promise<{papers: object[], total: number}>}
 */
async function listAll({ search = '', paperTypeId = null, limit, offset }) {
  // strpos instead of LIKE, so % and _ typed by the user are just characters.
  const where = `p.deleted_at is null
     and ($1 = '' or strpos(lower(p.title || ' ' || coalesce(p.vendor, '') || ' ' || coalesce(u.display_name, u.email, '')), lower($1)) > 0)
     and ($2::uuid is null or p.paper_type_id = $2)`;
  const [list, count] = await Promise.all([
    query(`${SELECT} where ${where} order by p.updated_at desc limit $3 offset $4`, [
      search,
      paperTypeId,
      limit,
      offset,
    ]),
    query(
      `select count(*)::int as n from papers p join users u on u.id = p.owner_id where ${where}`,
      [search, paperTypeId],
    ),
  ]);
  return { papers: list.rows.map(toCamel), total: count.rows[0].n };
}

/**
 * Change title and / or vendor (FR-PAP-03). Undefined fields are left as they are.
 * @param {string} id
 * @param {{title?: string, vendor?: string|null}} changes
 * @returns {Promise<{id, title, vendor}|null>}
 */
async function update(id, { title, vendor }) {
  const { rows } = await query(
    `update papers
        set title = case when $2 then $3 else title end,
            vendor = case when $4 then $5 else vendor end,
            updated_at = now()
      where id = $1 and deleted_at is null
      returning id, title, vendor`,
    [id, title !== undefined, title ?? null, vendor !== undefined, vendor ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Mark the paper as changed (an answer was saved), so "newest change first" is right.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function touch(id) {
  await query('update papers set updated_at = now() where id = $1', [id]);
}

/**
 * Soft delete (FR-PAP-04).
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function softDelete(id) {
  const { rowCount } = await query(
    'update papers set deleted_at = now() where id = $1 and deleted_at is null',
    [id],
  );
  return rowCount === 1;
}

module.exports = { countActiveByType, create, findById, listByOwner, listAll, update, touch, softDelete };
