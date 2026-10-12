'use strict';

/**
 * First-start setup of the first local administrator, the Keycloak / CloakTail way (D-27):
 *
 * 1. `ADMIN_BOOTSTRAP_USERNAME` + `_PASSWORD` set → the account is created at startup (unattended
 *    deploys). The password is temporary: it must be changed at first sign-in.
 * 2. Otherwise, while no local admin exists, the server prints a one-time **setup token** in its log
 *    and `/setup` lets whoever has that token create the first administrator. The token proves the
 *    person can read the server's log, so a stranger who reaches the URL first cannot take over.
 *
 * The token lives in memory only: a restart issues a new one, and it is forgotten once an admin
 * exists. With several app instances each prints its own token, so use the bootstrap variables there.
 */
const crypto = require('node:crypto');
const config = require('../config');
const localAdminModel = require('../models/localAdmin.model');
const { withTransaction } = require('../utils/db');
const { hashPassword, passwordProblem } = require('../utils/password');
const { USERNAME_RE } = require('./auth.service');

const USERNAME_HINT = 'Username: 3-40 lowercase letters, digits, dots, dashes or underscores.';

let setupToken = null;
let setupDone = false; // once an admin exists it never goes back, so stop asking the database

/**
 * True while no local administrator exists yet.
 * @returns {Promise<boolean>}
 */
async function isSetupRequired() {
  if (setupDone) return false;
  if ((await localAdminModel.count()) > 0) {
    setupDone = true;
    setupToken = null;
  }
  return !setupDone;
}

/** Hash both sides first, so the comparison takes the same time whatever the input length. */
function tokenMatches(value) {
  if (!setupToken || typeof value !== 'string') return false;
  const digest = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(digest(value.trim()), digest(setupToken));
}

/**
 * Create a setup token (if setup is needed and none exists yet) and print it in the server log.
 * This is the one place a secret is deliberately written to the log: it is single-use, only valid
 * until the first admin exists, and reading the log is exactly the proof we want (D-27).
 *
 * @param {import('pino').Logger} log
 * @returns {Promise<string|null>} the token, or null when setup is not needed
 */
async function ensureSetupToken(log) {
  if (!(await isSetupRequired())) return null;
  if (!setupToken) {
    setupToken = crypto.randomBytes(18).toString('base64url');
    log.warn(
      { setupUrl: `${config.baseUrl}/setup` },
      `No administrator exists yet. Open ${config.baseUrl}/setup and enter this setup token: ${setupToken}`,
    );
  }
  return setupToken;
}

/**
 * Create the first administrator from the ADMIN_BOOTSTRAP_* variables.
 * @param {import('pino').Logger} log
 * @returns {Promise<boolean>} true if an account was created
 */
async function bootstrapFromConfig(log) {
  const { username, password } = config.adminBootstrap;
  const name = username.trim().toLowerCase();
  const problem = USERNAME_RE.test(name) ? passwordProblem(password, name) : USERNAME_HINT;
  if (problem) {
    log.error({ problem }, 'ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD ignored');
    return false;
  }
  const created = await createFirst({
    username: name,
    password,
    createdBy: 'bootstrap',
    mustChangePassword: true,
  });
  if (created)
    log.info(
      { localAdminId: created.id },
      'Created the first local administrator from ADMIN_BOOTSTRAP_USERNAME',
    );
  return Boolean(created);
}

/** Insert the first admin under a lock; null if someone else was first. */
async function createFirst({ username, password, createdBy, mustChangePassword }) {
  const passwordHash = await hashPassword(password); // slow: do it before taking the lock
  const created = await withTransaction(async () => {
    await localAdminModel.lockFirstAdminCreation();
    return localAdminModel.create({
      username,
      passwordHash,
      createdBy,
      onlyIfNone: true,
      mustChangePassword,
    });
  });
  if (created) {
    setupDone = true;
    setupToken = null;
  }
  return created;
}

/**
 * Called once by server.js at startup: bootstrap from config, or print a setup token.
 * @param {import('pino').Logger} log
 * @returns {Promise<void>}
 */
async function onStartup(log) {
  if (!(await isSetupRequired())) return;
  if (config.adminBootstrap.username && (await bootstrapFromConfig(log))) return;
  await ensureSetupToken(log);
}

/**
 * The `/setup` form: check the token and the new account, then create the first administrator.
 * They chose their own password here, so they are not asked to change it again.
 *
 * @param {{token: string, username: string, password: string, confirm: string, log: import('pino').Logger}} params
 * @returns {Promise<{ok: true, admin: object} | {ok: false, message: string, alreadyDone?: boolean}>}
 */
async function createFirstAdmin({ token, username, password, confirm, log }) {
  if (!(await isSetupRequired())) return { ok: false, alreadyDone: true, message: 'Setup is already done.' };
  if (!tokenMatches(token)) {
    log.warn('Setup refused: wrong setup token');
    return { ok: false, message: 'That setup token is not right. Copy it from the server log.' };
  }
  const name = String(username ?? '')
    .trim()
    .toLowerCase();
  if (!USERNAME_RE.test(name)) return { ok: false, message: USERNAME_HINT };
  if (password !== confirm) return { ok: false, message: 'The two passwords are not the same.' };
  const problem = passwordProblem(password, name);
  if (problem) return { ok: false, message: problem };

  const admin = await createFirst({
    username: name,
    password,
    createdBy: 'setup',
    mustChangePassword: false,
  });
  if (!admin) return { ok: false, alreadyDone: true, message: 'Another administrator was created first.' };
  log.info({ localAdminId: admin.id }, 'First local administrator created on /setup');
  return { ok: true, admin };
}

/**
 * Tests only: forget the cached state, so a test can start from "no admin yet".
 * @returns {void}
 */
function resetForTests() {
  setupToken = null;
  setupDone = false;
}

module.exports = { isSetupRequired, ensureSetupToken, onStartup, createFirstAdmin, resetForTests };
