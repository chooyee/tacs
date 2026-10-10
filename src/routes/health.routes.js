'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const health = require('../controllers/health.controller');

// Public, no session (NFR-OPS-01). Mounted at /health before the session middleware.
router.get('/', health.live);
router.get('/ready', asyncHandler(health.ready));

module.exports = router;
