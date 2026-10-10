'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { requireRole } = require('../../src/middleware/requireRole');
const { ForbiddenError } = require('../../src/utils/errors');

/** Run the middleware with a user and return what it passed to next(). */
function run(middleware, user) {
  let result = 'not called';
  middleware({ user }, {}, (err) => {
    result = err;
  });
  return result;
}

const architect = { id: 'a', kind: 'entra', roles: ['Architect'] };
const entraAdmin = { id: 'b', kind: 'entra', roles: ['Architect', 'Admin'] };
const localAdmin = { id: 'c', kind: 'local', roles: ['Admin'] };

describe('requireRole (FR-ACC-04, D-26)', () => {
  test('an architect may open architect pages', () => {
    assert.equal(run(requireRole('Architect'), architect), undefined);
  });

  test('FR-ACC-04: an architect may not open admin areas', () => {
    const err = run(requireRole('Admin'), architect);
    assert.ok(err instanceof ForbiddenError);
    assert.equal(err.status, 403);
  });

  test('D-26: an Entra admin may open admin areas and architect pages', () => {
    assert.equal(run(requireRole('Admin'), entraAdmin), undefined);
    assert.equal(run(requireRole('Architect'), entraAdmin), undefined);
  });

  test('D-27: a local admin may open admin areas but not architect pages', () => {
    assert.equal(run(requireRole('Admin'), localAdmin), undefined);
    assert.ok(run(requireRole('Architect'), localAdmin) instanceof ForbiddenError);
  });

  test('any one of several roles is enough', () => {
    assert.equal(run(requireRole('Admin', 'Architect'), architect), undefined);
  });

  test('no user → 403', () => {
    assert.ok(run(requireRole('Architect'), undefined) instanceof ForbiddenError);
  });
});
