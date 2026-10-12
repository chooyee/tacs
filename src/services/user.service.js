'use strict';

/**
 * Managing who is an Architect or an Admin, and who is disabled (FR-ACC-09, D-26, D-28).
 */
const userModel = require('../models/user.model');
const { ConflictError, NotFoundError } = require('../utils/errors');

/** Only the fields the Users page shows (no Entra object ID). */
function toListItem(user, currentUser) {
  return {
    id: user.id,
    name: user.displayName || user.email || '—',
    email: user.email,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    isSelf: currentUser.kind === 'entra' && currentUser.id === user.id,
  };
}

/**
 * The Users page view model.
 * @param {{currentUser: object}} params
 * @returns {Promise<{users: object[]}>}
 */
async function getUsersPage({ currentUser }) {
  const users = await userModel.listAll();
  return { users: users.map((u) => toListItem(u, currentUser)) };
}

/**
 * Change another user's role and/or status. Logged as an `info` line (NFR-SEC-13); there is no
 * audit table (D-33).
 *
 * @param {{currentUser: object, userId: string, role?: string, status?: string, log: import('pino').Logger}} params
 * @returns {Promise<object>} the updated user (list item shape)
 * @throws {ConflictError} CANNOT_CHANGE_SELF — admins cannot lock themselves out
 * @throws {NotFoundError}
 */
async function updateUserAccess({ currentUser, userId, role, status, log }) {
  if (currentUser.kind === 'entra' && currentUser.id === userId) {
    throw new ConflictError(
      'You cannot change your own role or status. Ask another admin.',
      'CANNOT_CHANGE_SELF',
    );
  }
  const updated = await userModel.updateAccess(userId, { role, status });
  if (!updated) throw new NotFoundError('User not found.');
  log.info(
    { targetUserId: userId, role: updated.role, status: updated.status, byKind: currentUser.kind },
    'User access changed',
  );
  return toListItem(updated, currentUser);
}

module.exports = { getUsersPage, updateUserAccess };
