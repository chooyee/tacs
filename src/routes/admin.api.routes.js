'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const adminUsers = require('../controllers/admin/user.controller');
const { updateUserSchema } = require('../validators/user.validators');

// /api/admin/** — Admin role only (FR-ACC-04). Mounted at /api/admin.
router.use(requireAuth, requireRole('Admin'));

router.patch('/users/:userId', validate(updateUserSchema), asyncHandler(adminUsers.update));

module.exports = router;
