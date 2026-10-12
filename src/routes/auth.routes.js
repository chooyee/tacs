'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const auth = require('../controllers/auth.controller');
const { redirectToSetupWhileNoAdmin } = require('../middleware/setupGate');
const { loginQuerySchema, localLoginSchema, changePasswordSchema } = require('../validators/auth.validators');

// Public routes (FR-ACC-01: /auth/* needs no sign-in). Mounted at /auth.
router.get('/login', validate(loginQuerySchema), asyncHandler(auth.login));
router.get('/callback', asyncHandler(auth.callback));
router.post('/logout', asyncHandler(auth.logout));
router.get('/logged-out', auth.loggedOut);

// Local administrators (D-27). Before the first one exists, these lead to /setup.
router.use('/local', redirectToSetupWhileNoAdmin);
router.get('/local', validate(loginQuerySchema), auth.localForm);
router.post('/local', validate(localLoginSchema), asyncHandler(auth.localLogin));
router.get('/local/password', auth.passwordForm);
router.post('/local/password', validate(changePasswordSchema), asyncHandler(auth.changePassword));

module.exports = router;
