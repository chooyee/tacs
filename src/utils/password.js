'use strict';

/**
 * Password hashing for local administrator accounts (D-27): scrypt with a random salt per password.
 * Stored as `scrypt$N$r$p$salt$hash`, so the cost can be raised later without breaking old hashes.
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MIN_LENGTH = 12;
const MAX_LENGTH = 256; // stops someone sending a 10 MB "password" to burn CPU

const derive = (password, salt, length, { N, r, p }) =>
  scrypt(password.normalize('NFKC'), salt, length, { N, r, p, maxmem: 256 * N * r });

/**
 * Hash a password for storage.
 * @param {string} password
 * @returns {Promise<string>} `scrypt$N$r$p$salt$hash`
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, KEY_LENGTH, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Check a password against a stored hash, in constant time.
 * @param {string} password
 * @param {string} stored  value from `hashPassword()`
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !hash || typeof password !== 'string' || password.length > MAX_LENGTH) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash;
/**
 * A hash of a random password. Checked when a username does not exist, so the response time does not
 * reveal which usernames exist.
 * @returns {Promise<string>}
 */
async function getDummyHash() {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

/**
 * Why a new password is not acceptable, or null when it is (FR-ACC-10).
 * @param {string} password
 * @param {string} [username]
 * @returns {string|null} a user-facing message
 */
function passwordProblem(password, username) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH)
    return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters.`;
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain the username.';
  }
  return null;
}

/**
 * A random temporary password for accounts created or reset from the command line.
 * @returns {string} 20 URL-safe characters
 */
const temporaryPassword = () => crypto.randomBytes(15).toString('base64url');

module.exports = { hashPassword, verifyPassword, getDummyHash, passwordProblem, temporaryPassword };
