'use strict';

const setupService = require('../services/setup.service');

/**
 * While no administrator exists, send people who are not signed in to /setup (like Keycloak's
 * welcome page). Used on `/` and on the local sign-in pages. Entra sign-in itself keeps working, so
 * architects are never blocked by a missing admin.
 *
 * @type {import('express').RequestHandler}
 */
async function redirectToSetupWhileNoAdmin(req, res, next) {
  try {
    if (!req.session?.user && (await setupService.isSetupRequired())) return res.redirect('/setup');
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { redirectToSetupWhileNoAdmin };
