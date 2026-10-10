'use strict';

const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const config = require('../config');
const { pool } = require('../utils/db');

const PgStore = connectPgSimple(session);

/**
 * Build the session store. Sessions live in Postgres (table `session`, created by migration 001), so
 * several app instances share them (NFR-REL-02). Tests use an in-memory store.
 *
 * @returns {import('express-session').Store}
 */
function createSessionStore() {
  if (config.isTest) return new session.MemoryStore();
  return new PgStore({
    pool,
    tableName: 'session',
    createTableIfMissing: false, // the table comes from a migration (docs/05 §3.15)
    pruneSessionInterval: 15 * 60, // seconds; removes expired rows
  });
}

/**
 * The session middleware (NFR-SEC-03): cookie `psc.sid`, HttpOnly, SameSite=Lax, Secure from config.
 * `rolling` + `maxAge` = the 60-minute idle timeout; the 8-hour absolute limit is checked in requireAuth.
 *
 * @param {import('express-session').Store} store
 * @returns {import('express').RequestHandler}
 */
function createSessionMiddleware(store) {
  return session({
    name: 'psc.sid',
    secret: config.session.secret,
    store,
    resave: false,
    saveUninitialized: false, // no session row until we store something (e.g. sign-in state)
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.session.cookieSecure,
      sameSite: 'lax', // must be lax (not strict): Entra redirects back to /auth/callback cross-site
      maxAge: config.session.idleMinutes * 60 * 1000,
    },
  });
}

/**
 * Give the session a new ID, keeping nothing from the old one (prevents session fixation).
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
function regenerateSession(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

/**
 * Delete the session from the store.
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
function destroySession(req) {
  if (!req.session) return Promise.resolve();
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}

/**
 * Write the session to the store now (before a redirect, so the next request sees it).
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

module.exports = {
  createSessionStore,
  createSessionMiddleware,
  regenerateSession,
  destroySession,
  saveSession,
};
