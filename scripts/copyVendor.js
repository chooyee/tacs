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
  // pdf.js renders PDF previews in the browser (docs/04 §1); its worker must come from our origin (CSP).
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'public/vendor/pdfjs/pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/vendor/pdfjs/pdf.worker.min.mjs'],
  // Quill 2: the rich-text editor (same as survey-app-poc), loaded only on pages that edit rich text.
  ['node_modules/quill/dist/quill.js', 'public/vendor/quill/quill.js'],
  ['node_modules/quill/dist/quill.snow.css', 'public/vendor/quill/quill.snow.css'],
  // Our own readiness rules, the SAME file on server and browser (docs/04 §6).
  ['src/utils/readinessRules.js', 'public/js/shared/readinessRules.js'],
];

// Whole folders: fonts pdf.js uses for PDFs that do not embed their fonts.
const FOLDERS = [['node_modules/pdfjs-dist/standard_fonts', 'public/vendor/pdfjs/standard_fonts']];

for (const [from, to] of FILES) {
  fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(root, to));
}
for (const [from, to] of FOLDERS) {
  fs.cpSync(path.join(root, from), path.join(root, to), { recursive: true });
}
