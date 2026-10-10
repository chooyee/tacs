'use strict';

const auditLogModel = require('../models/auditLog.model');

/**
 * Record an admin change in the audit log (NFR-SEC-13). The actor is the signed-in user: an Entra
 * admin goes in `user_id`, a local admin in `local_admin_id`.
 *
 * @param {{actor: {kind: 'entra'|'local', id: string}, action: string, entityType: string,
 *          entityId?: string, before?: object, after?: object}} entry
 * @returns {Promise<void>}
 */
async function record({ actor, action, entityType, entityId, before, after }) {
  await auditLogModel.insert({
    userId: actor.kind === 'entra' ? actor.id : null,
    localAdminId: actor.kind === 'local' ? actor.id : null,
    action,
    entityType,
    entityId,
    before,
    after,
  });
}

module.exports = { record };
