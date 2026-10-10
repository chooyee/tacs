'use strict';

/**
 * `npm run dev`: runs the app with `node --watch` (restarts on changes) and the Tailwind CLI in watch
 * mode side by side. A tiny script instead of an extra package (concurrently / nodemon).
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tailwindCli = path.join(root, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');

// Vendor files (Basecoat JS) must exist before the first page loads.
require('./copyVendor');

const children = [
  spawn(process.execPath, ['--watch', 'src/server.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [tailwindCli, '-i', 'src/styles/app.css', '-o', 'public/css/app.css', '--watch'], {
    cwd: root,
    stdio: 'inherit',
  }),
];

// Stop both when one stops or when Ctrl+C is pressed, so nothing keeps running in the background.
function stopAll(code) {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}
for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
