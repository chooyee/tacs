'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const { referenceFileUpload } = require('../middleware/upload');
const adminUsers = require('../controllers/admin/user.controller');
const paperTypes = require('../controllers/admin/paperType.controller');
const structure = require('../controllers/admin/structure.controller');
const references = require('../controllers/admin/reference.controller');
const { updateUserSchema } = require('../validators/user.validators');
const v = require('../validators/admin.validators');

// /api/admin/** — Admin role only (FR-ACC-04). Mounted at /api/admin. Routes follow docs/06 §4.
router.use(requireAuth, requireRole('Admin'));

router.patch('/users/:userId', validate(updateUserSchema), asyncHandler(adminUsers.update));

// Paper types
router.post('/types', validate(v.createType), asyncHandler(paperTypes.create));
router.patch('/types/:typeId', validate(v.updateType), asyncHandler(paperTypes.update));
router.delete('/types/:typeId', validate(v.typeId), asyncHandler(paperTypes.remove));

// Sections
router.post('/types/:typeId/sections', validate(v.addSection), asyncHandler(structure.addSection));
router.patch('/sections/:sectionId', validate(v.renameSection), asyncHandler(structure.renameSection));
router.post('/sections/:sectionId/move', validate(v.moveSection), asyncHandler(structure.moveSection));
router.delete('/sections/:sectionId', validate(v.sectionId), asyncHandler(structure.deleteSection));
router.post('/sections/:sectionId/restore', validate(v.sectionId), asyncHandler(structure.restoreSection));

// Standards
router.post('/sections/:sectionId/standards', validate(v.addStandard), asyncHandler(structure.addStandard));
router.patch('/standards/:standardId', validate(v.updateStandard), asyncHandler(structure.updateStandard));
router.post('/standards/:standardId/move', validate(v.moveStandard), asyncHandler(structure.moveStandard));
router.delete('/standards/:standardId', validate(v.standardId), asyncHandler(structure.deleteStandard));
router.post(
  '/standards/:standardId/restore',
  validate(v.standardId),
  asyncHandler(structure.restoreStandard),
);

// Reference documents (multipart: the upload middleware runs before validation of the text fields)
router.post(
  '/types/:typeId/references',
  referenceFileUpload,
  validate(v.addReference),
  asyncHandler(references.add),
);
router.patch(
  '/references/:referenceId',
  referenceFileUpload,
  validate(v.updateReference),
  asyncHandler(references.update),
);
router.delete('/references/:referenceId', validate(v.referenceId), asyncHandler(references.remove));
router.post('/references/:referenceId/restore', validate(v.referenceId), asyncHandler(references.restore));

module.exports = router;
