'use strict';

const db = require('../utils/db');
const { getStorage } = require('../factories/storageFactory');

const CHECK_TIMEOUT_MS = 3000; // the load balancer should get an answer quickly, even if S3 hangs

/** Resolve 'ok' or 'fail' (with the error) within the timeout. */
async function probe(fn) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'fail', err };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check the database and the file storage in parallel (NFR-OPS-01).
 * @returns {Promise<{ok: boolean, checks: {db: string, storage: string}, errors: Error[]}>}
 */
async function checkReadiness() {
  const [dbResult, storageResult] = await Promise.all([
    probe(() => db.ping()),
    probe(() => getStorage().ping()),
  ]);
  return {
    ok: dbResult.status === 'ok' && storageResult.status === 'ok',
    checks: { db: dbResult.status, storage: storageResult.status },
    errors: [dbResult.err, storageResult.err].filter(Boolean),
  };
}

module.exports = { checkReadiness };
