'use strict';

/**
 * Tiny migration runner (docs/04 §1, docs/05 §3.16). Usage: `npm run db:migrate`.
 *
 * Applies every `db/migrations/NNN_name.sql` that is not yet listed in `schema_migrations`, in file
 * name order, each file in its own transaction. An advisory lock stops two app instances migrating at
 * the same time. Never edit a migration that has run somewhere: add a new file instead.
 */
const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');
const config = require('../src/config');
const { logger } = require('../src/utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 7_351_001; // any constant number, the same for every instance

/**
 * Apply all pending migrations.
 * @param {object} [opts]
 * @param {string} [opts.databaseUrl]  defaults to DATABASE_URL
 * @param {import('pino').Logger} [opts.log]
 * @returns {Promise<string[]>} the file names that were applied
 */
async function migrate({ databaseUrl = config.db.url, log = logger } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await client.query('select filename from schema_migrations');
    const done = new Set(rows.map((r) => r.filename));
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
      .sort();

    const applied = [];
    for (const file of files.filter((f) => !done.has(f))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
      }
      log.info({ file }, 'Migration applied');
      applied.push(file);
    }
    if (!applied.length) log.info('Database is up to date');
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {}); // connection closes anyway
    await client.end();
  }
}

if (require.main === module) {
  migrate().then(
    () => logger.flush?.(),
    (err) => {
      logger.fatal({ err }, 'Migration failed');
      logger.flush?.();
      process.exitCode = 1;
    },
  );
}

module.exports = { migrate };
