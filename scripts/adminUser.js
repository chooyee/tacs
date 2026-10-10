'use strict';

/**
 * Local administrator accounts from the command line (D-27, docs/08 §1.4).
 *
 *   npm run admin -- create <username>   new account with a temporary password
 *   npm run admin -- reset <username>    new temporary password; signs out the account's sessions
 *   npm run admin -- list
 *
 * In Docker: docker exec <container> npm run admin -- reset <username>
 *
 * The temporary password is printed on this terminal only (never logged). It must be changed at the
 * first sign-in on /auth/local.
 */
const localAdminModel = require('../src/models/localAdmin.model');
const db = require('../src/utils/db');
const { USERNAME_RE } = require('../src/services/auth.service');
const { hashPassword, temporaryPassword } = require('../src/utils/password');

/** CLI output for the person at the terminal (not a log line). */
const say = (line = '') => process.stdout.write(`${line}\n`);

async function create(username) {
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 3-40 lowercase letters, digits, dots, dashes or underscores.');
  }
  const password = temporaryPassword();
  const created = await localAdminModel.create({
    username,
    passwordHash: await hashPassword(password),
    createdBy: 'cli',
  });
  if (!created) throw new Error(`"${username}" already exists. Use: npm run admin -- reset ${username}`);
  say(`Created local administrator "${username}".`);
  say(`Temporary password: ${password}`);
  say('Sign in at /auth/local; the password must be changed at first sign-in.');
}

async function reset(username) {
  const admin = await localAdminModel.findByUsername(username);
  if (!admin) throw new Error(`No local administrator "${username}". Run: npm run admin -- list`);
  const password = temporaryPassword();
  await localAdminModel.setPassword(admin.id, {
    passwordHash: await hashPassword(password),
    mustChangePassword: true,
  });
  say(`Reset the password of "${username}" and signed out their sessions.`);
  say(`Temporary password: ${password}`);
  say('It must be changed at the next sign-in on /auth/local.');
}

async function list() {
  const admins = await localAdminModel.listAll();
  if (!admins.length) say('No local administrators yet. Create one: npm run admin -- create <username>');
  for (const a of admins) {
    const locked = a.lockedUntil && a.lockedUntil > new Date() ? '\tLOCKED' : '';
    const temp = a.mustChangePassword ? '\tmust change password' : '';
    say(`${a.username}\tlast sign-in: ${a.lastLoginAt?.toISOString() ?? 'never'}${locked}${temp}`);
  }
}

async function main() {
  const [command, rawUsername = ''] = process.argv.slice(2);
  const username = rawUsername.trim().toLowerCase();
  if (command === 'create' && username) return create(username);
  if (command === 'reset' && username) return reset(username);
  if (command === 'list') return list();
  say('Usage: npm run admin -- create <username> | reset <username> | list');
  process.exitCode = 1;
}

main()
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
