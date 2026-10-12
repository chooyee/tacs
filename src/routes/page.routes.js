'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const { rememberMode } = require('../middleware/rememberMode');
const pages = require('../controllers/page.controller');
const paperPages = require('../controllers/paper.controller');
const adminUsers = require('../controllers/admin/user.controller');
const paperTypes = require('../controllers/admin/paperType.controller');
const libraryPages = require('../controllers/admin/reference.controller');
const standardPages = require('../controllers/admin/structure.controller');
const { redirectToSetupWhileNoAdmin } = require('../middleware/setupGate');
const v = require('../validators/admin.validators');
const pv = require('../validators/paper.validators');

// HTML pages (docs/06 §2). Everything here needs sign-in (FR-ACC-01).
// On first start (no administrator yet) the start page is /setup, like Keycloak's welcome page.
router.get('/', redirectToSetupWhileNoAdmin, requireAuth, pages.home);
// Papers (FR-PAP, FR-ANS): every architect may open any paper; only the owner can change it.
const architect = [requireAuth, requireRole('Architect'), rememberMode('architect')];
router.get('/papers', ...architect, validate(pv.listPapers), asyncHandler(paperPages.index));
router.get('/papers/:paperId', ...architect, validate(pv.paperId), asyncHandler(paperPages.show));

// Admin pages (FR-ACC-04, D-32)
const admin = [requireAuth, requireRole('Admin'), rememberMode('admin')];
router.get('/admin', ...admin, (_req, res) => res.redirect('/admin/types'));
router.get('/admin/users', ...admin, asyncHandler(adminUsers.index));
router.get('/admin/types', ...admin, asyncHandler(paperTypes.index));
router.get('/admin/types/:typeId', ...admin, validate(v.typeId), asyncHandler(paperTypes.show));
router.get('/admin/types/:typeId/cards/:card', ...admin, validate(v.card), asyncHandler(paperTypes.card));
// Standards: full-screen add / edit form (D-38)
router.get(
  '/admin/types/:typeId/standards/new',
  ...admin,
  validate(v.standardForm),
  asyncHandler(standardPages.form),
);
router.get(
  '/admin/standards/:standardId',
  ...admin,
  validate(v.standardForm),
  asyncHandler(standardPages.form),
);
// Reference library (D-37): list and full-screen add / edit
router.get('/admin/references', ...admin, asyncHandler(libraryPages.index));
router.get('/admin/references/new', ...admin, asyncHandler(libraryPages.edit));
router.get(
  '/admin/references/:referenceId',
  ...admin,
  validate(v.referenceId),
  asyncHandler(libraryPages.edit),
);

module.exports = router;
