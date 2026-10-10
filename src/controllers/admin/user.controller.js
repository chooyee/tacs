'use strict';

const userService = require('../../services/user.service');

/** GET /admin/users — the Users page (FR-ACC-09). */
async function index(req, res) {
  const vm = await userService.getUsersPage({ currentUser: req.user });
  res.render('layouts/main', {
    page: 'pages/admin/users',
    title: res.locals.t.adminUsers.heading,
    pageScript: 'adminUsers',
    ...vm,
  });
}

/** PATCH /api/admin/users/:userId — change role and/or status. */
async function update(req, res) {
  const user = await userService.updateUserAccess({
    currentUser: req.user,
    userId: req.params.userId,
    role: req.body.role,
    status: req.body.status,
    log: req.log,
  });
  res.json({ data: user });
}

module.exports = { index, update };
