'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = 'id, entra_oid, email, display_name, role, status, last_login_at, created_at, updated_at';

/**
 * Create the user on first sign-in, or update name / email / last_login_at on later sign-ins
 * (FR-ACC-06). The role and status are never touched here: admins manage them (D-26, D-28).
 *
 * @param {{entraOid: string, email: string|null, displayName: string|null}} claims
 * @returns {Promise<object>} the user (camelCase)
 */
async function upsertFromSignIn({ entraOid, email, displayName }) {
  const { rows } = await query(
    `insert into users (entra_oid, email, display_name, last_login_at)
     values ($1, $2, $3, now())
     on conflict (entra_oid) do update
       set email = excluded.email, display_name = excluded.display_name,
           last_login_at = now(), updated_at = now()
     returning ${COLUMNS}`,
    [entraOid, email, displayName],
  );
  return toCamel(rows[0]);
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from users where id = $1`, [id]);
  return toCamel(rows[0]);
}

/**
 * Every user, admins first, then by name.
 * @returns {Promise<object[]>}
 */
async function listAll() {
  const { rows } = await query(
    `select ${COLUMNS} from users
     order by (role = 'admin') desc, lower(coalesce(display_name, email, '')), created_at`,
  );
  return rows.map(toCamel);
}

/**
 * Change role and/or status. Undefined fields stay as they are.
 * @param {string} id
 * @param {{role?: 'architect'|'admin', status?: 'active'|'disabled'}} changes
 * @returns {Promise<object|null>} the updated user, or null if it does not exist
 */
async function updateAccess(id, { role, status }) {
  const { rows } = await query(
    `update users
        set role = coalesce($2, role), status = coalesce($3, status), updated_at = now()
      where id = $1
      returning ${COLUMNS}`,
    [id, role ?? null, status ?? null],
  );
  return toCamel(rows[0]);
}

module.exports = { upsertFromSignIn, findById, listAll, updateAccess };
