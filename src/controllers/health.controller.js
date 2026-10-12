'use strict';

const healthService = require('../services/health.service');
const { ExternalServiceError } = require('../utils/errors');

/** GET /health — the process is up (NFR-OPS-01). No dependencies checked. */
function live(_req, res) {
  res.json({ status: 'ok' });
}

/** GET /health/ready — the load balancer sends traffic only when the DB and S3 answer. */
async function ready(_req, res) {
  const { ok, checks, errors } = await healthService.checkReadiness();
  if (!ok) {
    throw new ExternalServiceError('Not ready.', {
      status: 503,
      code: 'NOT_READY',
      details: Object.entries(checks).map(([check, status]) => ({ check, status })),
      cause: errors[0],
    });
  }
  res.json({ status: 'ok', checks });
}

module.exports = { live, ready };
