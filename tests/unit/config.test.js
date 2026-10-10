'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../../src/config/loadConfig');
const { ConfigError } = require('../../src/utils/errors');

/** A valid development environment; each test changes one thing. */
const validEnv = () => ({
  NODE_ENV: 'development',
  BASE_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(64),
  DATABASE_URL: 'postgres://psc:psc@localhost:5432/psc',
  ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  ENTRA_CLIENT_SECRET: 'secret',
  ENTRA_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  AI_PROVIDER: 'fake',
});

const productionEnv = () => ({
  ...validEnv(),
  NODE_ENV: 'production',
  BASE_URL: 'https://psc.example.com',
  ENTRA_REDIRECT_URI: 'https://psc.example.com/auth/callback',
  COOKIE_SECURE: 'true',
  AI_PROVIDER: 'bedrock',
  BEDROCK_REGION: 'ap-southeast-1',
  BEDROCK_MODEL_ID: 'some-model',
});

/** Assert that loading fails and the message names the variable. */
function assertRejects(env, variable) {
  assert.throws(
    () => loadConfig(env),
    (err) => err instanceof ConfigError && err.message.includes(variable),
    `expected a ConfigError naming ${variable}`,
  );
}

describe('config validation (docs/10 §2)', () => {
  test('a valid environment loads, with defaults filled in', () => {
    const config = loadConfig(validEnv());
    assert.equal(config.port, 3000);
    assert.equal(config.db.poolMax, 10);
    assert.equal(config.ai.provider, 'fake');
    assert.equal(config.retention.days, 7);
    assert.equal(config.session.cookieSecure, true);
    assert.equal(config.trustProxy, undefined);
  });

  test('the config object is frozen, including nested objects', () => {
    const config = loadConfig(validEnv());
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.entra));
  });

  test('empty strings count as "not set"', () => {
    const config = loadConfig({ ...validEnv(), TRUST_PROXY: '', PORT: '' });
    assert.equal(config.trustProxy, undefined);
    assert.equal(config.port, 3000);
  });

  test('a missing required variable is named in the error', () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    assertRejects(env, 'DATABASE_URL');
  });

  test('every problem is reported at once', () => {
    const env = validEnv();
    delete env.BASE_URL;
    env.ENTRA_TENANT_ID = 'not-a-guid';
    assert.throws(
      () => loadConfig(env),
      (err) => err.message.includes('BASE_URL') && err.message.includes('ENTRA_TENANT_ID'),
    );
  });

  test('NFR-SEC-03: SESSION_SECRET must be at least 32 characters', () => {
    assertRejects({ ...validEnv(), SESSION_SECRET: 'short' }, 'SESSION_SECRET');
  });

  test('D-13: production with AI_PROVIDER=gemini refuses to start', () => {
    assertRejects({ ...productionEnv(), AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, 'AI_PROVIDER');
  });

  test('D-13: production with AI_PROVIDER=fake refuses to start', () => {
    assertRejects({ ...productionEnv(), AI_PROVIDER: 'fake' }, 'AI_PROVIDER');
  });

  test('a valid production environment loads', () => {
    assert.equal(loadConfig(productionEnv()).ai.provider, 'bedrock');
  });

  test('bedrock needs a region and a model ID', () => {
    assertRejects({ ...productionEnv(), BEDROCK_MODEL_ID: '' }, 'BEDROCK_MODEL_ID');
  });

  test('gemini needs an API key', () => {
    assertRejects({ ...validEnv(), AI_PROVIDER: 'gemini' }, 'GEMINI_API_KEY');
  });

  test('docs/07 §9: LOG_PROMPTS is refused in production', () => {
    assertRejects({ ...productionEnv(), LOG_PROMPTS: 'true' }, 'LOG_PROMPTS');
  });

  test('NFR-SEC-03: COOKIE_SECURE=false is refused in production', () => {
    assertRejects({ ...productionEnv(), COOKIE_SECURE: 'false' }, 'COOKIE_SECURE');
  });

  test('NFR-SEC-01: production BASE_URL must be https', () => {
    assertRejects({ ...productionEnv(), BASE_URL: 'http://psc.example.com' }, 'BASE_URL');
  });

  test('Entra needs a client secret or a certificate', () => {
    const env = validEnv();
    delete env.ENTRA_CLIENT_SECRET;
    assertRejects(env, 'ENTRA_CLIENT_SECRET');
  });

  test('D-27: bootstrap username and password must be set together', () => {
    assertRejects({ ...validEnv(), ADMIN_BOOTSTRAP_USERNAME: 'admin' }, 'ADMIN_BOOTSTRAP_PASSWORD');
  });

  test('a config error is not operational (the generic message is shown to users)', () => {
    try {
      loadConfig({});
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.isOperational, false);
    }
  });
});
