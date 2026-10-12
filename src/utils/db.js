'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const pg = require('pg');
const config = require('../config');
const { logger } = require('./logger');

/**
 * PostgreSQL access (docs/05). Models are the only callers of `query()`; always pass values as
 * parameters ($1, $2 …) and never build SQL strings with values (NFR-SEC-10).
 */
const pool = new pg.Pool({ connectionString: config.db.url, max: config.db.poolMax });

// An idle client can fail (e.g. the DB restarted). Log it; pg removes the client from the pool.
pool.on('error', (err) => logger.error({ err }, 'PostgreSQL pool error'));

// Inside withTransaction() every query() runs on the transaction's client automatically.
const txStore = new AsyncLocalStorage();

/**
 * Run one parameterised SQL statement.
 * @param {string} text  SQL with $1, $2 … placeholders
 * @param {Array} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params = []) {
  const client = txStore.getStore() ?? pool;
  return client.query(text, params);
}

/**
 * Run `fn` inside a transaction. Commits when it resolves, rolls back when it throws. Calls to
 * `query()` inside `fn` use the same connection; nested calls join the outer transaction.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  if (txStore.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A failed rollback must not hide the original error.
    await client
      .query('ROLLBACK')
      .catch((rollbackErr) => logger.warn({ err: rollbackErr }, 'Rollback failed'));
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Convert a row's snake_case keys to camelCase (`paper_type_id` → `paperTypeId`).
 * @param {object|undefined} row
 * @returns {object|null}
 */
function toCamel(row) {
  if (!row) return null;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase())] = value;
  }
  return out;
}

/**
 * Cheap connectivity check for /health/ready.
 * @returns {Promise<void>} rejects when the DB is unreachable
 */
async function ping() {
  await pool.query('select 1');
}

/**
 * Does a table exist in the current search_path? Used at startup to say "run the migrations" instead
 * of failing on the first query.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function tableExists(name) {
  const { rows } = await pool.query('select to_regclass($1) is not null as exists', [name]);
  return rows[0].exists;
}

/**
 * Close all connections (graceful shutdown, scripts, tests).
 * @returns {Promise<void>}
 */
function close() {
  return pool.end();
}

module.exports = { pool, query, withTransaction, toCamel, ping, tableExists, close };
