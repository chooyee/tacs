'use strict';

/**
 * Test database helpers. Integration tests run against the `psc_test` database from tests/test.env:
 * the schema is migrated once, and every test file starts from empty tables.
 */
const db = require('../../src/utils/db');
const { migrate } = require('../../db/migrate');

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, fatal() {} };

/**
 * Migrate the test database and delete all rows.
 * @returns {Promise<void>}
 */
async function resetDb() {
  await migrate({ log: silentLog });
  const { rows } = await db.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
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
