'use strict';

/**
 * The name stored in `updated_by` and shown as "Last edited by …" (D-37). A snapshot, so it still
 * reads correctly after the account is gone.
 * @param {{kind: 'entra'|'local', name: string}|undefined} user  req.user
 * @returns {string|null}
 */
function actorName(user) {
  if (!user) return null;
  return user.kind === 'local' ? `${user.name} (local admin)` : user.name;
}

module.exports = { actorName };
