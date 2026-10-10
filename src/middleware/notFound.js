'use strict';

const { NotFoundError } = require('../utils/errors');

/**
 * Last route: nothing matched, so hand a 404 to the error handler (which picks HTML or JSON).
 * @type {import('express').RequestHandler}
 */
function notFound(_req, _res, next) {
  next(new NotFoundError('We could not find that page.'));
}

module.exports = { notFound };
