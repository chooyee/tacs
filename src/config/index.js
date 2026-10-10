'use strict';

/**
 * App configuration. This is the ONLY place that reads `process.env` (docs/10 §2).
 *
 * Usage: `const config = require('../config'); config.ai.provider`.
 * Variables are read once and validated; if something is wrong the app refuses to start and the
 * error names the variable. The object is frozen, so nothing can change it at runtime.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./loadConfig');

// Local development: read .env if present (Node 22 built-in, no dotenv package). Variables that are
// already set in the real environment win. Tests get their values from tests/test.env instead.
const envFile = path.join(__dirname, '..', '..', '.env');
if (process.env.NODE_ENV !== 'test' && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env);

module.exports = config;
