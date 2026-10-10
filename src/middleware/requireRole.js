'use strict';

const { ForbiddenError } = require('../utils/errors');

/**
 * Allow the request only if the signed-in user has at least one of the roles (FR-ACC-04).
 * Use after requireAuth. Roles are `'Architect'` and `'Admin'` (see docs/08 §1.4 for who has which).
 *
 * @param {...('Architect'|'Admin')} roles
 * @returns {import('express').RequestHandler}
 * @example router.use(requireRole('Admin'))
 */
const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (roles.some((role) => req.user?.roles?.includes(role))) return next();
    req.log?.warn({ userId: req.user?.id, required: roles }, 'Access denied: missing role');
    return next(new ForbiddenError('You do not have access to this area.'));
  };

module.exports = { requireRole };
