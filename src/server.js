'use strict';

/**
 * Entry point: starts the HTTP server and shuts down cleanly (docs/09 §4).
 * The background check worker (docs/04 §7) is started and stopped here too.
 */
let config;
let logger;
try {
  config = require('./config');
  ({ logger } = require('./utils/logger'));
} catch (err) {
  // The config is broken, so the app logger cannot be built: log with a bare pino and stop.
  require('pino')().fatal({ msg: err.message }, 'Cannot start: invalid configuration');
  process.exit(1);
}

const db = require('./utils/db');
const { createApp } = require('./app');
const setupService = require('./services/setup.service');
const { createWorker } = require('./workers/checkWorker');

const SHUTDOWN_TIMEOUT_MS = 30_000;
let server;
let app;
let worker;
let shuttingDown = false;

/**
 * Stop accepting connections, let running requests finish, close the session store and the DB pool,
 * flush the logs, exit. Forced exit after 30 s so a stuck request cannot block a deploy.
 * @param {number} code  process exit code
 */
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ code }, 'Shutting down');
  setTimeout(() => {
    logger.error('Shutdown took too long, forcing exit');
    logger.flush();
    process.exit(code || 1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await worker?.stop(); // stop claiming checks; running ones get up to 30 s
    app?.sessionStore?.close?.(); // stops connect-pg-simple's prune timer
    await db.close();
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    code = code || 1;
  }
  logger.flush();
  process.exit(code);
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection, shutting down');
  shutdown(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception, shutting down');
  shutdown(1);
});
process.on('SIGTERM', () => shutdown(0)); // deploys / scaling
process.on('SIGINT', () => shutdown(0)); // Ctrl+C locally

async function start() {
  try {
    await db.ping();
  } catch (err) {
    logger.fatal({ err }, 'Database unreachable at startup. Is PostgreSQL running and DATABASE_URL right?');
    return shutdown(1);
  }
  if (!(await db.tableExists('local_admins'))) {
    logger.fatal('The database has no tables yet. Run: npm run db:migrate');
    return shutdown(1);
  }

  app = createApp();
  try {
    await new Promise((resolve, reject) => {
      server = app.listen(config.port, resolve).once('error', reject);
    });
  } catch (err) {
    const hint =
      err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use (set PORT to another one)` : '';
    logger.fatal({ err }, hint || 'Could not start the HTTP server');
    server = undefined; // never started, nothing to close
    return shutdown(1);
  }
  // Slightly longer than the load balancer's idle timeout (60 s), so it never reuses a closed socket.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  logger.info({ port: config.port, baseUrl: config.baseUrl }, 'Paper Standards Check is running');

  worker = createWorker({ log: logger });
  worker.start();

  // First start: create the admin from ADMIN_BOOTSTRAP_* or print the /setup token (D-27). Last, so
  // the token is the newest line in the console.
  await setupService.onStartup(logger);
}

start().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  shutdown(1);
});
