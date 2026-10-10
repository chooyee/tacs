'use strict';

/**
 * Simple pages that need no service yet. In M3 the papers page moves to paper.controller with a
 * real view model.
 */

/** GET / — the start page depends on who you are (docs/06 §2). */
function home(req, res) {
  res.redirect(req.user.roles.includes('Architect') ? '/papers' : '/admin/users');
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
