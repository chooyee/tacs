'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const { requireAuth } = require('../middleware/requireAuth');
const { requireRole } = require('../middleware/requireRole');
const papers = require('../controllers/paper.controller');
const checks = require('../controllers/check.controller');
const { paperFilesUpload } = require('../middleware/upload');
const v = require('../validators/paper.validators');

// /api/papers/** — Architect role (Entra admins have it too, D-26). Reads are open to every
// architect; writes check ownership in the service (403 NOT_OWNER). Mounted at /api/papers.
router.use(requireAuth, requireRole('Architect'));

router.post('/', validate(v.createPaper), asyncHandler(papers.create));
router.patch('/:paperId', validate(v.updatePaper), asyncHandler(papers.update));
router.delete('/:paperId', validate(v.paperId), asyncHandler(papers.remove));
// D-45: move the paper to its type's newest published version (owner only).
router.post('/:paperId/upgrade', validate(v.paperId), asyncHandler(papers.upgrade));
router.get('/:paperId/readiness', validate(v.paperId), asyncHandler(papers.readiness));
router.put('/:paperId/answers/:standardId', validate(v.saveAnswer), asyncHandler(papers.saveAnswer));

// AI checks and results (FR-AI). Multipart: the upload middleware runs before validation.
// The pre-check runs before multer, so a refused upload is never read into memory.
router.post(
  '/:paperId/checks',
  validate(v.paperId),
  asyncHandler(checks.precheckUpload),
  paperFilesUpload,
  validate(v.upload),
  asyncHandler(checks.upload),
);
router.post('/:paperId/checks/rerun', validate(v.paperId), asyncHandler(checks.rerun));
router.get('/:paperId/checks/latest', validate(v.paperId), asyncHandler(checks.latest));
router.post('/:paperId/results/apply-unanswered', validate(v.paperId), asyncHandler(checks.applyUnanswered));
router.post('/:paperId/results/:standardId/apply', validate(v.result), asyncHandler(checks.apply));
router.post('/:paperId/results/:standardId/keep', validate(v.result), asyncHandler(checks.keep));

// Chat (FR-CHAT)
router.get('/:paperId/chat', validate(v.paperId), asyncHandler(checks.chat));
router.post('/:paperId/chat', validate(v.chatMessage), asyncHandler(checks.chatPost));
router.post('/:paperId/chat/quick', validate(v.chatQuick), asyncHandler(checks.chatQuick));

module.exports = router;
