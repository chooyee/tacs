'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const viewsDir = path.join(__dirname, '..', '..', 'src', 'views');

/** All .ejs files below a folder. */
function ejsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ejsFiles(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

// ESLint cannot read EJS, so this test is the "lint rule" of NFR-SEC-05.
test('NFR-SEC-05: views use unescaped <%- only for include() and sanitizeRich() (D-37)', () => {
  for (const file of ejsFiles(viewsDir)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<%-([\s\S]*?)%>/g)) {
      assert.match(
        match[1],
        /^\s*(include\(|sanitizeRich\(html\)\s*$)/,
        `${path.relative(viewsDir, file)} uses <%- without include() or sanitizeRich()`,
      );
    }
  }
});
