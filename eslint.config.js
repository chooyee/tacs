'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'public/css/', 'public/vendor/', 'public/js/shared/'] },
  js.configs.recommended,
  {
    // Server, scripts and tests: CommonJS on Node 22.
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-console': 'error', // use the pino logger (docs/09)
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      strict: ['error', 'global'],
    },
  },
  {
    // Browser code: native ES modules, no bundler.
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
    rules: { strict: 'off' },
  },
  prettier,
];
