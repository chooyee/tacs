'use strict';

/**
 * Turns environment variables into the validated, frozen config object (docs/10 §2).
 * Pure: it never reads `process.env` itself — `index.js` passes it in — so tests can try any input.
 */
const fs = require('node:fs');
const { z } = require('zod');
const { ConfigError } = require('../utils/errors');

// Empty strings in .env files ("TRUST_PROXY=") mean "not set".
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const withDefault = (schema, value) => z.preprocess((v) => (v === '' ? undefined : v), schema.default(value));
const bool = (value) => withDefault(z.enum(['true', 'false']), value).transform((v) => v === 'true');
const int = (value) => withDefault(z.coerce.number().int().positive(), value);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: int(3000),
    BASE_URL: z.url(),
    LOG_LEVEL: withDefault(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']), 'info'),
    SESSION_SECRET: z.string().min(32, 'must be at least 32 characters (use 64 random hex chars)'),
    COOKIE_SECURE: bool('true'),
    TRUST_PROXY: optional(z.coerce.number().int().min(0)),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must start with postgres://'),
    DB_POOL_MAX: int(10),

    ENTRA_TENANT_ID: z.guid(),
    ENTRA_CLIENT_ID: z.guid(),
    ENTRA_CLIENT_SECRET: optional(z.string().min(1)),
    ENTRA_CERT_THUMBPRINT: optional(z.string().min(1)),
    ENTRA_CERT_PRIVATE_KEY_PATH: optional(z.string().min(1)),
    ENTRA_REDIRECT_URI: z.url(),
    ACCESS_REQUEST_TEXT: withDefault(
      z.string(),
      'Ask the Architecture Office to give you access to Paper Standards Check.',
    ),

    ADMIN_BOOTSTRAP_USERNAME: optional(z.string()),
    ADMIN_BOOTSTRAP_PASSWORD: optional(z.string()),

    AI_PROVIDER: z.enum(['gemini', 'bedrock', 'fake']),
    GEMINI_API_KEY: optional(z.string().min(1)),
    GEMINI_MODEL: withDefault(z.string(), 'gemini-2.5-pro'),
    BEDROCK_REGION: optional(z.string().min(1)),
    BEDROCK_MODEL_ID: optional(z.string().min(1)),
    AI_TIMEOUT_MS: int(120000),
    AI_MAX_DOCS_PER_REQUEST: int(5),
    AI_MAX_RETRIES: withDefault(z.coerce.number().int().min(0), 1),
    LOG_PROMPTS: bool('false'),

    AWS_REGION: optional(z.string().min(1)),
    S3_BUCKET: optional(z.string().min(1)),
    S3_ENDPOINT: optional(z.url()),
    S3_FORCE_PATH_STYLE: bool('false'),

    UPLOAD_MAX_PAPER_MB: int(20),
    UPLOAD_MAX_REFERENCE_MB: int(15),
    UPLOAD_MAX_PAGES: int(100),
    CHECK_WORKER_INTERVAL_MS: int(2000),
    CHECK_WORKER_CONCURRENCY: int(2),
    CHECK_TIMEOUT_MS: int(600000),
    RATE_LIMIT_CHECKS_PER_HOUR: int(10),
    RETENTION_DAYS: int(7),
    RETENTION_RUN_AT: withDefault(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'), '02:00'),
  })
  // Rules that involve more than one variable.
  .superRefine((env, ctx) => {
    const problem = (pathName, message) => ctx.addIssue({ code: 'custom', path: [pathName], message });
    const isProd = env.NODE_ENV === 'production';

    // D-13: production must use Bedrock; the fake provider is for local development and tests only.
    if (isProd && env.AI_PROVIDER !== 'bedrock')
      problem('AI_PROVIDER', 'must be "bedrock" in production (D-13)');
    if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY)
      problem('GEMINI_API_KEY', 'is required for gemini');
    if (env.AI_PROVIDER === 'bedrock') {
      if (!env.BEDROCK_REGION) problem('BEDROCK_REGION', 'is required for bedrock');
      if (!env.BEDROCK_MODEL_ID) problem('BEDROCK_MODEL_ID', 'is required for bedrock');
    }
    // docs/07 §9: prompt text may only be logged in local development.
    if (isProd && env.LOG_PROMPTS) problem('LOG_PROMPTS', 'is not allowed in production');

    const hasCert = env.ENTRA_CERT_THUMBPRINT && env.ENTRA_CERT_PRIVATE_KEY_PATH;
    if (!env.ENTRA_CLIENT_SECRET && !hasCert) {
      problem('ENTRA_CLIENT_SECRET', 'is required (or ENTRA_CERT_THUMBPRINT + ENTRA_CERT_PRIVATE_KEY_PATH)');
    }
    if (env.ENTRA_CERT_PRIVATE_KEY_PATH && !fs.existsSync(env.ENTRA_CERT_PRIVATE_KEY_PATH)) {
      problem('ENTRA_CERT_PRIVATE_KEY_PATH', 'file does not exist');
    }
    if (isProd && !env.BASE_URL.startsWith('https://')) problem('BASE_URL', 'must use https in production');
    if (isProd && !env.COOKIE_SECURE) problem('COOKIE_SECURE', 'must be true in production (NFR-SEC-03)');
    if (Boolean(env.ADMIN_BOOTSTRAP_USERNAME) !== Boolean(env.ADMIN_BOOTSTRAP_PASSWORD)) {
      problem(
        'ADMIN_BOOTSTRAP_PASSWORD',
        'set both ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD, or neither',
      );
    }
  });

/**
 * Validate a set of environment variables and build the config object.
 * Pure function (no global state), so tests can call it with any input.
 *
 * @param {Record<string, string|undefined>} env  usually `process.env`
 * @returns {Readonly<object>} the frozen config
 * @throws {ConfigError} listing every invalid variable
 */
function loadConfig(env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(env)'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = result.data;
  return deepFreeze({
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    baseUrl: e.BASE_URL.replace(/\/$/, ''),
    trustProxy: e.TRUST_PROXY,
    log: { level: e.LOG_LEVEL, prompts: e.LOG_PROMPTS },
    session: {
      secret: e.SESSION_SECRET,
      cookieSecure: e.COOKIE_SECURE,
      idleMinutes: 60, // docs/08 §1.2 rule 3
      absoluteHours: 8,
    },
    db: { url: e.DATABASE_URL, poolMax: e.DB_POOL_MAX },
    entra: {
      tenantId: e.ENTRA_TENANT_ID,
      clientId: e.ENTRA_CLIENT_ID,
      clientSecret: e.ENTRA_CLIENT_SECRET,
      certThumbprint: e.ENTRA_CERT_THUMBPRINT,
      certPrivateKeyPath: e.ENTRA_CERT_PRIVATE_KEY_PATH,
      redirectUri: e.ENTRA_REDIRECT_URI,
      authority: `https://login.microsoftonline.com/${e.ENTRA_TENANT_ID}`,
    },
    access: { requestText: e.ACCESS_REQUEST_TEXT },
    adminBootstrap: { username: e.ADMIN_BOOTSTRAP_USERNAME, password: e.ADMIN_BOOTSTRAP_PASSWORD },
    ai: {
      provider: e.AI_PROVIDER,
      timeoutMs: e.AI_TIMEOUT_MS,
      maxDocsPerRequest: e.AI_MAX_DOCS_PER_REQUEST,
      maxRetries: e.AI_MAX_RETRIES,
      gemini: { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL },
      bedrock: { region: e.BEDROCK_REGION, modelId: e.BEDROCK_MODEL_ID },
    },
    s3: {
      region: e.AWS_REGION,
      bucket: e.S3_BUCKET,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    },
    uploads: {
      maxPaperMb: e.UPLOAD_MAX_PAPER_MB,
      maxReferenceMb: e.UPLOAD_MAX_REFERENCE_MB,
      maxPages: e.UPLOAD_MAX_PAGES,
    },
    checks: {
      workerIntervalMs: e.CHECK_WORKER_INTERVAL_MS,
      workerConcurrency: e.CHECK_WORKER_CONCURRENCY,
      timeoutMs: e.CHECK_TIMEOUT_MS,
      rateLimitPerHour: e.RATE_LIMIT_CHECKS_PER_HOUR,
    },
    retention: { days: e.RETENTION_DAYS, runAt: e.RETENTION_RUN_AT },
  });
}

/** Freeze an object and every nested object, so nobody changes config at runtime. */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

module.exports = { loadConfig };
