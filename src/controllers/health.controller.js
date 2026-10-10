'use strict';

const db = require('../utils/db');
const { ExternalServiceError } = require('../utils/errors');

/** GET /health — the process is up (NFR-OPS-01). No dependencies checked. */
function live(_req, res) {
  res.json({ status: 'ok' });
}

/**
 * GET /health/ready — the load balancer sends traffic only when this is 200. Checks the database;
 * S3 is added in M2 with the storage factory (D-29).
 */
async function ready(_req, res) {
  try {
    await db.ping();
  } catch (err) {
    throw new ExternalServiceError('Not ready.', {
      status: 503,
      code: 'NOT_READY',
      details: [{ check: 'db', status: 'fail' }],
      cause: err,
    });
  }
  res.json({ status: 'ok', checks: { db: 'ok' } });
}

module.exports = { live, ready };
