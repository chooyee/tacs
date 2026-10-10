'use strict';

/**
 * Wraps an async Express handler so a rejected promise goes to `next(err)` and reaches the error
 * handler (Express 4 does not do this by itself).
 *
 * @param {(req, res, next) => Promise<unknown>} fn
 * @returns {import('express').RequestHandler}
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { asyncHandler };
