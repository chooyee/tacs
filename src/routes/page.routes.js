'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const pages = require('../controllers/page.controller');
const adminUsers = require('../controllers/admin/user.controller');
const { redirectToSetupWhileNoAdmin } = require('../middleware/setupGate');

// HTML pages (docs/06 §2). Everything here needs sign-in (FR-ACC-01).
// On first start (no administrator yet) the start page is /setup, like Keycloak's welcome page.
router.get('/', redirectToSetupWhileNoAdmin, requireAuth, pages.home);
router.get('/papers', requireAuth, requireRole('Architect'), pages.papers);

// Admin pages (FR-ACC-04)
router.get('/admin', requireAuth, requireRole('Admin'), (_req, res) => res.redirect('/admin/users'));
router.get('/admin/users', requireAuth, requireRole('Admin'), asyncHandler(adminUsers.index));

module.exports = router;
