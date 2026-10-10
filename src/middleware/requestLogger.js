'use strict';

const { randomUUID } = require('node:crypto');
const pinoHttp = require('pino-http');
const { logger } = require('../utils/logger');

// Only accept a request ID from the load balancer if it looks like one (stops log injection).
const SAFE_REQUEST_ID = /^[\w-]{1,100}$/;

/**
 * One log line per request + `req.log` / `req.id` for everything after it (docs/09 §1.2).
 *
 * - Reuses `X-Request-Id` from the load balancer, otherwise creates a UUID, and echoes it back.
 * - Logs method, path (no query string: it could contain data), status and duration.
 * - Never logs headers or bodies (cookies and CSRF tokens stay out of the logs).
 * - `/health` requests are logged at `debug` only, so the load balancer does not flood the logs.
 */
const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customAttributeKeys: { reqId: 'requestId' },
  customLogLevel(req, res, err) {
    if (req.url.startsWith('/health')) return 'debug';
    // The error handler already logged the error with its stack; this line is just the summary.
    return err || res.statusCode >= 500 ? 'warn' : 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url.split('?')[0]} ${res.statusCode}`,
  // userId is known only after requireAuth ran, which is before the response finishes.
  customProps: (req) => (req.user ? { userId: req.user.id } : {}),
  serializers: {
    req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});

module.exports = { requestLogger };
