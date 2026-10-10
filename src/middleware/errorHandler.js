'use strict';

const { AppError } = require('../utils/errors');
const { logger } = require('../utils/logger');

const GENERIC_MESSAGE = 'Something went wrong on our side. Please try again.';

/**
 * Express errors that are not AppErrors but are safe to report as a 4xx — e.g. invalid JSON in the
 * body or a body that is too large (they carry `expose: true` and a 4xx status).
 */
function clientErrorFrom(err) {
  const status = err?.status ?? err?.statusCode;
  if (err?.expose && status >= 400 && status < 500) {
    const message = status === 413 ? 'The request is too large.' : 'The request could not be read.';
    return { status, code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message };
  }
  return null;
}

/**
 * Work out what the user may see. Rules (docs/09 §3, NFR-SEC-12):
 * - AppErrors show their own message (written to be user-safe), except non-operational ones (bugs,
 *   config mistakes) which get the generic message.
 * - Anything else is a bug: generic message, status 500. The real error is only logged.
 */
function describe(err) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code,
      message: err.isOperational ? err.message : GENERIC_MESSAGE,
      details: err.isOperational ? err.details : undefined,
    };
  }
  return clientErrorFrom(err) ?? { status: 500, code: 'INTERNAL_ERROR', message: GENERIC_MESSAGE };
}

/** Which error page to show for an HTML request. */
function viewFor(status) {
  if (status === 404) return 'pages/notFound';
  if (status === 403) return 'pages/forbidden';
  return 'pages/error';
}

/**
 * The ONE place where errors become responses (docs/09 §3).
 * API calls (`/api/...` or clients that prefer JSON) get `{ error: {code, message, details, requestId} }`;
 * browsers get an error page. Every error is logged once, here, with its stack and `cause`.
 *
 * @type {import('express').ErrorRequestHandler}
 */
// Express recognises error handlers by their 4 arguments, so all four must be declared.
function errorHandler(err, req, res, next) {
  const { status, code, message, details } = describe(err);

  const log = req.log ?? logger;
  const level = status >= 500 ? 'error' : status === 404 || status === 401 ? 'info' : 'warn';
  log[level]({ err, code, status, userId: req.user?.id }, 'Request failed');

  // Too late to send a clean response (e.g. a stream broke halfway): let Express close the connection.
  if (res.headersSent) return next(err);

  const body = { error: { code, message, details, requestId: req.id } };
  const isApi = req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/health');
  const wantsJson = isApi || req.accepts(['html', 'json']) === 'json';
  if (wantsJson) return res.status(status).json(body);

  return res.status(status).render('layouts/main', {
    page: viewFor(status),
    title: status === 404 ? 'Page not found' : status === 403 ? 'No access' : 'Error',
    ...body.error,
  });
}

module.exports = { errorHandler };
