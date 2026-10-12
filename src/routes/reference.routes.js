'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const references = require('../controllers/reference.controller');
const checks = require('../controllers/check.controller');
const v = require('../validators/admin.validators');
const pv = require('../validators/paper.validators');

// Every signed-in user with a role may view references (FR-REF-02, FR-REF-04). Mounted at /.
const anyRole = [requireAuth, requireRole('Architect', 'Admin')];
router.get(
  '/api/references/:referenceId',
  ...anyRole,
  validate(v.referenceId),
  asyncHandler(references.viewer),
);
router.get(
  '/files/references/:referenceId',
  ...anyRole,
  validate(v.referenceId),
  asyncHandler(references.file),
);

// Check status (polled by the chat) and paper PDFs for the compare dialog: any architect (docs/06 §3).
const architect = [requireAuth, requireRole('Architect')];
router.get('/api/checks/:checkId', ...architect, validate(pv.checkId), asyncHandler(checks.status));
router.get('/files/documents/:documentId', ...architect, validate(pv.documentId), asyncHandler(checks.document));

module.exports = router;
