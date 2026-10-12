'use strict';

/**
 * Builds the Express app. Used by server.js and by the tests (supertest), so it does not listen on
 * a port or start background work itself.
 */
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { ConfigError } = require('./utils/errors');
const { requestLogger } = require('./middleware/requestLogger');
const { securityHeaders } = require('./middleware/securityHeaders');
const { createSessionStore, createSessionMiddleware } = require('./middleware/session');
const { csrf } = require('./middleware/csrf');
const { viewLocals } = require('./middleware/viewLocals');
const { notFound } = require('./middleware/notFound');
const { errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const routes = require('./routes');

/**
 * Create the Express app.
 *
 * @param {object} [opts]
 * @param {import('express-session').Store} [opts.sessionStore]  defaults to Postgres (memory in tests)
 * @param {import('express').RequestHandler} [opts.testAuth]  tests/helpers/fakeAuth.js — tests only
 * @returns {import('express').Express & {sessionStore: import('express-session').Store}}
 * @throws {ConfigError} if `testAuth` is used outside NODE_ENV=test
 */
function createApp({ sessionStore = createSessionStore(), testAuth } = {}) {
  // A fake sign-in in a real environment would let anyone in (docs/12 §2).
  if (testAuth && !config.isTest) throw new ConfigError('testAuth may only be used when NODE_ENV=test');

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Static files first: no logging, no session for CSS / JS (docs/10 §3).
  // `no-cache` = the browser keeps the file but asks every time (ETag → 304 when unchanged). Needed
  // because ES modules import each other without a version in the URL, so a long max-age would keep
  // old code after an update (D-35).
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: false,
      etag: true,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  app.use(requestLogger);
  app.use(securityHeaders);
  app.use(viewLocals);

  // Load-balancer checks: no session, no CSRF.
  app.use('/health', healthRoutes);

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(createSessionMiddleware(sessionStore));
  if (testAuth) app.use(testAuth);
  app.use(csrf);

  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);

  app.sessionStore = sessionStore; // server.js closes it on shutdown
  return app;
}

module.exports = { createApp };
