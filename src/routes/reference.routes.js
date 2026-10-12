'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const references = require('../controllers/reference.controller');
const v = require('../validators/admin.validators');

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

module.exports = router;
