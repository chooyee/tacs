'use strict';

const { ValidationError } = require('./errors');

/**
 * Express middleware that validates `req.params`, `req.query` and/or `req.body` with zod schemas
 * BEFORE the controller runs (docs/06 §1). Parsed values (with defaults and trimming applied)
 * replace the originals, so controllers can trust them.
 *
 * @param {{params?: import('zod').ZodType, query?: import('zod').ZodType, body?: import('zod').ZodType}} schemas
 * @returns {import('express').RequestHandler}
 * @example router.put('/x/:id', validate({ params: z.object({ id: z.uuid() }) }), handler)
 */
function validate(schemas) {
  return (req, _res, next) => {
    const details = [];
    const parsed = {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({ field: issue.path.join('.') || part, message: issue.message });
        }
      }
    }
    if (details.length) return next(new ValidationError('Please fix the highlighted fields.', details));
    // req.query is a getter in newer Express versions, so define the property instead of assigning.
    for (const [part, value] of Object.entries(parsed)) {
      Object.defineProperty(req, part, { value, writable: true, configurable: true, enumerable: true });
    }
    return next();
  };
}

module.exports = { validate };
