'use strict';

/**
 * Managing who is an Architect or an Admin, and who is disabled (FR-ACC-09, D-26, D-28).
 */
const userModel = require('../models/user.model');
const auditService = require('./audit.service');
const { withTransaction } = require('../utils/db');
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
 * Change another user's role and/or status, and write it to the audit log.
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
  const updated = await withTransaction(async () => {
    const before = await userModel.findById(userId);
    if (!before) throw new NotFoundError('User not found.');
    const after = await userModel.updateAccess(userId, { role, status });
    await auditService.record({
      actor: currentUser,
      action: 'user.update',
      entityType: 'user',
      entityId: userId,
      before: { role: before.role, status: before.status },
      after: { role: after.role, status: after.status },
    });
    return after;
  });
  log.info({ targetUserId: userId, role: updated.role, status: updated.status }, 'User access changed');
  return toListItem(updated, currentUser);
}

module.exports = { getUsersPage, updateUserAccess };
