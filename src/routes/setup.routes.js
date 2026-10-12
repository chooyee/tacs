'use strict';

const router = require('express').Router();
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../utils/validate');
const setup = require('../controllers/setup.controller');
const { setupSchema } = require('../validators/setup.validators');

// First-start setup (D-27). Public, but useless without the token from the server log.
router.get('/', asyncHandler(setup.form));
router.post('/', validate(setupSchema), asyncHandler(setup.create));

module.exports = router;
