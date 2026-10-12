'use strict';

/**
 * Simple pages that need no service yet. In M3 the papers page moves to paper.controller with a
 * real view model.
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

/** GET /papers — "My papers" (empty until M3). `?tab=all` selects the All papers tab. */
function papers(req, res) {
  const tab = req.query.tab === 'all' ? 'all' : 'mine';
  res.render('layouts/main', {
    page: 'pages/papers/index',
    title: res.locals.t.papers.heading,
    tab,
    papers: [],
  });
}

module.exports = { home, papers };
