'use strict';

const { query, toCamel } = require('../utils/db');

const COLUMNS = `id, username, password_hash, must_change_password, password_changed_at, failed_attempts,
  locked_until, created_by, last_login_at, created_at`;

/**
 * @returns {Promise<number>} how many local admin accounts exist
 */
async function count() {
  const { rows } = await query('select count(*)::int as n from local_admins');
  return rows[0].n;
}

/**
 * @param {string} username  already lower-cased
 * @returns {Promise<object|null>}
 */
async function findByUsername(username) {
  const { rows } = await query(`select ${COLUMNS} from local_admins where username = $1`, [username]);
  return toCamel(rows[0]);
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from local_admins where id = $1`, [id]);
  return toCamel(rows[0]);
}

/**
 * @returns {Promise<object[]>} every account, by username
 */
async function listAll() {
  const { rows } = await query(`select ${COLUMNS} from local_admins order by username`);
  return rows.map(toCamel);
}

/**
 * Create an account. `onlyIfNone` makes it the FIRST account only: when another instance created one
 * at the same moment, nothing is inserted (startup bootstrap).
 *
 * @param {{username: string, passwordHash: string, createdBy: string, onlyIfNone?: boolean}} account
 * @returns {Promise<object|null>} the new account, or null if skipped
 */
async function create({ username, passwordHash, createdBy, onlyIfNone = false }) {
  const { rows } = await query(
    `insert into local_admins (username, password_hash, must_change_password, created_by)
     select $1, $2, true, $3
     where not $4 or not exists (select 1 from local_admins)
     on conflict (username) do nothing
     returning ${COLUMNS}`,
    [username, passwordHash, createdBy, onlyIfNone],
  );
  return toCamel(rows[0]);
}

/**
 * Count a wrong password; lock the account once `maxAttempts` is reached (and start counting again).
 * @param {string} id
 * @param {{maxAttempts: number, lockMinutes: number}} policy
 * @returns {Promise<void>}
 */
async function recordFailedSignIn(id, { maxAttempts, lockMinutes }) {
  await query(
    `update local_admins
        set failed_attempts = case when failed_attempts + 1 >= $2 then 0 else failed_attempts + 1 end,
            locked_until    = case when failed_attempts + 1 >= $2
                                   then now() + make_interval(mins => $3) else locked_until end
      where id = $1`,
    [id, maxAttempts, lockMinutes],
  );
}

/**
 * Successful sign-in: reset the failure counter and remember the time.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function recordSignIn(id) {
  await query(
    'update local_admins set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1',
    [id],
  );
}

/**
 * Set a new password. Changing `password_changed_at` signs out existing sessions of this account.
 * @param {string} id
 * @param {{passwordHash: string, mustChangePassword: boolean}} change
 * @returns {Promise<object|null>} the updated account
 */
async function setPassword(id, { passwordHash, mustChangePassword }) {
  const { rows } = await query(
    `update local_admins
        set password_hash = $2, must_change_password = $3, password_changed_at = now(),
            failed_attempts = 0, locked_until = null
      where id = $1
      returning ${COLUMNS}`,
    [id, passwordHash, mustChangePassword],
  );
  return toCamel(rows[0]);
}

module.exports = {
  count,
  findByUsername,
  findById,
  listAll,
  create,
  recordFailedSignIn,
  recordSignIn,
  setPassword,
};
