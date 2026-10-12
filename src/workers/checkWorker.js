'use strict';

/**
 * The background worker (docs/04 §7): runs inside the app process, started by server.js.
 * - Polls for queued checks every CHECK_WORKER_INTERVAL_MS and runs up to CHECK_WORKER_CONCURRENCY at
 *   once. Claims use SKIP LOCKED, so several instances never run the same check.
 * - Every minute, checks stuck in "running" (a crashed instance) are marked failed.
 * - Once a day at RETENTION_RUN_AT (server time) it runs the retention job, holding a Postgres
 *   advisory lock so only one instance does it.
 * No Redis or queue product: Postgres is the queue.
 */
const config = require('../config');
const { pool } = require('../utils/db');
const checkModel = require('../models/check.model');
const checkService = require('../services/check.service');
const retentionService = require('../services/retention.service');

const SWEEP_EVERY_MS = 60_000;
const RETENTION_LOCK_ID = 7_351_002; // any constant number, the same for every instance
const STOP_WAIT_MS = 30_000;

/**
 * Create a worker. Call start() once; stop() on shutdown.
 * @param {{log: import('pino').Logger}} opts
 * @returns {{start: () => void, stop: () => Promise<void>, tick: () => Promise<void>}}
 */
function createWorker({ log }) {
  const wlog = log.child({ component: 'checkWorker' });
  const running = new Set();
  let timers = [];
  let stopping = false;
  let lastRetentionDay = null;

  let ticking = false; // a slow claim must not overlap the next timer tick

  /** Claim and start checks until the concurrency is used up. */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      while (!stopping && running.size < config.checks.workerConcurrency) {
        const claimed = await checkModel.claimNext();
        if (!claimed) return;
        wlog.info({ checkId: claimed.id, paperId: claimed.paperId }, 'Check started');
        const job = checkService.runCheck(claimed, wlog).finally(() => running.delete(job));
        running.add(job);
      }
    } catch (err) {
      wlog.error({ err }, 'Could not claim a check');
    } finally {
      ticking = false;
    }
  }

  async function sweep() {
    try {
      await checkService.failStuckChecks(wlog);
    } catch (err) {
      wlog.error({ err }, 'Stuck-check sweep failed');
    }
  }

  /** Run retention when the clock passes RETENTION_RUN_AT, once per day per instance. */
  async function maybeRunRetention() {
    const now = new Date();
    const today = now.toDateString();
    const [hh, mm] = config.retention.runAt.split(':').map(Number);
    if (lastRetentionDay === today || now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;
    lastRetentionDay = today;
    const client = await pool.connect();
    try {
      const { rows } = await client.query('select pg_try_advisory_lock($1) as locked', [RETENTION_LOCK_ID]);
      if (!rows[0].locked) {
        wlog.info('Retention job skipped: another instance is running it');
        return;
      }
      try {
        await retentionService.run(wlog);
      } finally {
        await client.query('select pg_advisory_unlock($1)', [RETENTION_LOCK_ID]);
      }
    } catch (err) {
      wlog.error({ err }, 'Retention job failed');
    } finally {
      client.release();
    }
  }

  return {
    tick,
    start() {
      wlog.info(
        { intervalMs: config.checks.workerIntervalMs, concurrency: config.checks.workerConcurrency },
        'Check worker started',
      );
      sweep(); // checks left "running" by a crash before this start
      timers = [
        setInterval(tick, config.checks.workerIntervalMs),
        setInterval(sweep, SWEEP_EVERY_MS),
        setInterval(maybeRunRetention, SWEEP_EVERY_MS),
      ];
      for (const t of timers) t.unref();
    },
    /** Stop claiming, wait up to 30 s for running checks (the sweep retries unfinished ones). */
    async stop() {
      stopping = true;
      for (const t of timers) clearInterval(t);
      if (!running.size) return;
      wlog.info({ running: running.size }, 'Waiting for running checks');
      await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    },
  };
}

module.exports = { createWorker };
