'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * App-wide logger (docs/09 §1). Prefer `req.log` in request code so every line carries the request
 * ID; elsewhere create a child logger with context:
 *   const log = logger.child({ module: 'checkWorker' });
 *   log.info({ checkId }, 'Check started');
 *
 * Never log tokens, cookies, passwords, file contents, prompts, remarks or chat text.
 */
const logger = pino({
  level: config.log.level,
  base: { app: 'paper-standards-check', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // A safety net only: do not pass secrets to the logger in the first place.
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.apiKey',
      '*.clientSecret',
      '*.token',
      '*.idToken',
      '*.secretAccessKey',
    ],
    censor: '[REDACTED]',
  },
  // Readable logs on a laptop, JSON lines everywhere else (CloudWatch).
  transport:
    config.env === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

module.exports = { logger };
