'use strict';

/**
 * Test database helpers. Integration tests use DATABASE_URL from tests/test.env, overridden by the
 * git-ignored tests/test.local.env if present. That URL points either at a separate `*_test` database
 * or at a separate schema of the dev database (`?options=-c search_path=test`). The schema is
 * migrated once and every test file starts from empty tables.
 */
const db = require('../../src/utils/db');
const { migrate } = require('../../db/migrate');

/** A logger that prints nothing; child() returns itself, like pino's. */
const silentLog = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child: () => silentLog };

/**
 * Make sure the schema named first in search_path exists (a fresh test schema has to be created
 * before the migration can put tables in it).
 */
async function ensureSchema() {
  const { rows } = await db.query(`select current_setting('search_path') as path`);
  const first = rows[0].path.split(',')[0].trim().replace(/^"|"$/g, '');
  if (first === '$user' || first === 'public') return;
  if (!/^[a-z_][a-z0-9_]*$/.test(first)) throw new Error(`Unexpected test schema name "${first}"`);
  await db.query(`create schema if not exists ${first}`);
}

/**
 * Refuse to empty a database that may hold real data: only a `*_test` database or a schema other
 * than `public` may be reset.
 */
async function assertSafeToReset() {
  const { rows } = await db.query('select current_database() as database, current_schema() as schema');
  const { database, schema } = rows[0];
  if (!database.endsWith('_test') && schema === 'public') {
    throw new Error(
      `Refusing to reset "${database}".${schema}: tests need a *_test database or a separate schema ` +
        '(see tests/test.env).',
    );
  }
  return schema;
}

/**
 * Migrate the test database / schema and delete all rows.
 * @returns {Promise<void>}
 */
async function resetDb() {
  await ensureSchema();
  const schema = await assertSafeToReset();
  await migrate({ log: silentLog });
  const { rows } = await db.query(
    `select tablename from pg_tables where schemaname = $1 and tablename <> 'schema_migrations'`,
    [schema],
  );
  const tables = rows.map((r) => `${schema}."${r.tablename}"`).join(', ');
  await db.query(`truncate ${tables} restart identity cascade`);
}

/**
 * Insert an Entra user directly.
 * @param {{role?: string, status?: string, name?: string}} [opts]
 * @returns {Promise<{id: string}>}
 */
async function createUser({ role = 'architect', status = 'active', name = 'Test User' } = {}) {
  const oid = `oid-${Math.random().toString(36).slice(2)}`;
  const { rows } = await db.query(
    `insert into users (entra_oid, email, display_name, role, status) values ($1, $2, $3, $4, $5) returning id`,
    [oid, `${oid}@example.com`, name, role, status],
  );
  return rows[0];
}

module.exports = { resetDb, createUser, silentLog, closeDb: db.close };
