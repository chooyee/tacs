'use strict';

/**
 * Copies third-party browser files from node_modules into public/vendor/ (git-ignored), because we
 * have no bundler (docs/10 §3). Runs as part of `npm run build` and `npm run dev`.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const FILES = [
  // Basecoat's small scripts for interactive components (dropdown menu = the user menu).
  ['node_modules/basecoat-css/dist/js/basecoat.min.js', 'public/vendor/basecoat/basecoat.min.js'],
  ['node_modules/basecoat-css/dist/js/dropdown-menu.min.js', 'public/vendor/basecoat/dropdown-menu.min.js'],
];

for (const [from, to] of FILES) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
}
