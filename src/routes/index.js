'use strict';

const router = require('express').Router();

// Mounts every router that needs a session. /health is mounted separately in app.js (no session).
router.use('/setup', require('./setup.routes'));
router.use('/auth', require('./auth.routes'));
router.use('/api/admin', require('./admin.api.routes'));
router.use('/api/papers', require('./paper.api.routes'));
router.use('/', require('./reference.routes'));
router.use('/', require('./page.routes'));

module.exports = router;
