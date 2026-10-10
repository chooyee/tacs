'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const { errorHandler } = require('../../src/middleware/errorHandler');
const { notFound } = require('../../src/middleware/notFound');
const { viewLocals } = require('../../src/middleware/viewLocals');
const { requestLogger } = require('../../src/middleware/requestLogger');
const { validate } = require('../../src/utils/validate');
const { asyncHandler } = require('../../src/utils/asyncHandler');
const {
  NotFoundError,
  ExternalServiceError,
  ConfigError,
  AccessNotGrantedError,
} = require('../../src/utils/errors');

/** A small app with routes that fail in different ways, using the real middleware. */
function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'src', 'views'));
  app.use(requestLogger, viewLocals, express.json());

  const boom = () => {
    throw new Error('SELECT * FROM secret_table failed at line 3');
  };
  app.get('/bug', boom);
  app.get('/api/bug', boom);
  app.get(
    '/api/async-bug',
    asyncHandler(async () => {
      throw new Error('async internal detail');
    }),
  );
  app.get('/api/missing', () => {
    throw new NotFoundError('Paper not found.');
  });
  app.get('/api/s3', () => {
    throw new ExternalServiceError('We could not save your file. Please try again.', {
      cause: new Error('AccessDenied: arn:aws:s3:::bucket'),
    });
  });
  app.get('/api/config', () => {
    throw new ConfigError('Unknown AI_PROVIDER "x"');
  });
  app.get('/disabled', () => {
    throw new AccessNotGrantedError();
  });
  app.post('/api/things', validate({ body: z.object({ title: z.string().min(3) }) }), (_req, res) =>
    res.json({ data: 'ok' }),
  );
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('error handler (docs/09 §3)', () => {
  const app = buildApp();

  test('API error has the JSON shape {error: {code, message, requestId}}', async () => {
    const res = await request(app).get('/api/missing').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.equal(res.body.error.message, 'Paper not found.');
    assert.match(res.body.error.requestId, /^[\w-]+$/);
    assert.equal(res.headers['x-request-id'], res.body.error.requestId);
  });

  test('the incoming X-Request-Id is reused', async () => {
    const res = await request(app).get('/api/missing').set('X-Request-Id', 'lb-req-123').expect(404);
    assert.equal(res.body.error.requestId, 'lb-req-123');
  });

  test('a suspicious X-Request-Id is replaced', async () => {
    const res = await request(app)
      .get('/api/missing')
      .set('X-Request-Id', '<script>bad id</script>')
      .expect(404);
    assert.notEqual(res.body.error.requestId, '<script>bad id</script>');
  });

  test('NFR-SEC-12: an unexpected error returns 500 with a generic message, no internals', async () => {
    const res = await request(app).get('/api/bug').expect(500);
    assert.equal(res.body.error.code, 'INTERNAL_ERROR');
    assert.equal(res.body.error.message, 'Something went wrong on our side. Please try again.');
    assert.doesNotMatch(JSON.stringify(res.body), /secret_table|stack/);
  });

  test('a rejected promise in an asyncHandler reaches the error handler', async () => {
    const res = await request(app).get('/api/async-bug').expect(500);
    assert.doesNotMatch(JSON.stringify(res.body), /async internal detail/);
  });

  test('a 5xx AppError shows its user-safe message but never the cause', async () => {
    const res = await request(app).get('/api/s3').expect(502);
    assert.equal(res.body.error.code, 'EXTERNAL_SERVICE_ERROR');
    assert.equal(res.body.error.message, 'We could not save your file. Please try again.');
    assert.doesNotMatch(JSON.stringify(res.body), /arn:aws/);
  });

  test('a non-operational error (ConfigError) hides its message', async () => {
    const res = await request(app).get('/api/config').expect(500);
    assert.equal(res.body.error.message, 'Something went wrong on our side. Please try again.');
  });

  test('validation errors list the fields', async () => {
    const res = await request(app).post('/api/things').send({ title: 'x' }).expect(400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(res.body.error.details[0].field, 'title');
  });

  test('invalid JSON is a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/things')
      .set('Content-Type', 'application/json')
      .send('{"title":')
      .expect(400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  test('unknown API route → JSON 404', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  test('unknown page → HTML 404 page', async () => {
    const res = await request(app).get('/nope').set('Accept', 'text/html').expect(404);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Page not found/);
  });

  test('HTML error page shows the friendly message and a short reference, not the error', async () => {
    const res = await request(app).get('/bug').set('Accept', 'text/html').expect(500);
    assert.match(res.text, /Something went wrong/);
    assert.match(res.text, /Reference/);
    assert.doesNotMatch(res.text, /secret_table/);
  });

  test('FR-ACC-03: a disabled account gets the "Access not granted" page with the request text', async () => {
    const res = await request(app).get('/disabled').set('Accept', 'text/html').expect(403);
    assert.match(res.text, /Access not granted/);
    assert.match(res.text, /Ask the Architecture Office/);
  });
});
