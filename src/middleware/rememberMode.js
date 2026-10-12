'use strict';

/**
 * Remember whether the user last worked in Architect or Admin mode, so `/` can take them back there
 * (docs/06 §2, D-32). Only an Entra admin has both modes, so only their choice matters.
 *
 * @param {'architect'|'admin'} mode
 * @returns {import('express').RequestHandler}
 */
const rememberMode = (mode) => (req, _res, next) => {
  if (req.session && req.session.lastMode !== mode) req.session.lastMode = mode;
  next();
};

module.exports = { rememberMode };
