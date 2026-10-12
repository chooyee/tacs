'use strict';

/**
 * Simple pages that need no service. The papers pages live in paper.controller.
 */

/**
 * GET / — the start page depends on who you are (docs/06 §2, D-32): architects go to their papers;
 * admins go back to the mode they used last; local admins (no papers) go to the paper types.
 */
function home(req, res) {
  const isArchitect = req.user.roles.includes('Architect');
  const isAdmin = req.user.roles.includes('Admin');
  const adminMode = isAdmin && (!isArchitect || req.session.lastMode === 'admin');
  res.redirect(adminMode ? '/admin/types' : '/papers');
}

module.exports = { home };
