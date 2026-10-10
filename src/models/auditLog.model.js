'use strict';

const { query } = require('../utils/db');

/**
 * Append one entry to the admin audit log (docs/05 §3.14).
 * @param {{userId?: string|null, localAdminId?: string|null, action: string, entityType: string,
 *          entityId?: string|null, before?: object|null, after?: object|null}} entry
 * @returns {Promise<void>}
 */
async function insert({
  userId = null,
  localAdminId = null,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
}) {
  await query(
    `insert into admin_audit_log (user_id, local_admin_id, action, entity_type, entity_id, before, after)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, localAdminId, action, entityType, entityId, before, after],
  );
}

/**
 * Entries for one entity, newest first (used by tests and, later, an audit view).
 * @param {string} entityType
 * @param {string} entityId
 * @returns {Promise<object[]>}
 */
async function listForEntity(entityType, entityId) {
  const { rows } = await query(
    `select id, user_id as "userId", local_admin_id as "localAdminId", action, entity_type as "entityType",
            entity_id as "entityId", before, after, created_at as "createdAt"
       from admin_audit_log where entity_type = $1 and entity_id = $2 order by id desc`,
    [entityType, entityId],
  );
  return rows;
}

module.exports = { insert, listForEntity };
