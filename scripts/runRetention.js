'use strict';

/**
 * Run the retention job once, now (FR-RET-01): `npm run retention:run`. The worker runs it daily at
 * RETENTION_RUN_AT anyway; this is for operators (e.g. after a long outage). Safe to run any time:
 * it only deletes what is older than RETENTION_DAYS, and it takes the same advisory lock as the
 * worker, so two runs never overlap.
 */
const db = require('../src/utils/db');
const { logger } = require('../src/utils/logger');
const retentionService = require('../src/services/retention.service');

const RETENTION_LOCK_ID = 7_351_002; // the same lock as src/workers/checkWorker.js

async function main() {
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query('select pg_try_advisory_lock($1) as locked', [RETENTION_LOCK_ID]);
    if (!rows[0].locked) {
      logger.warn('Retention job is already running on another instance; nothing done');
      return;
    }
    try {
      await retentionService.run(logger);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [RETENTION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Retention run failed');
    process.exitCode = 1;
  })
  .finally(() => db.close());
