const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const electronRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

test('electron package includes every local CommonJS runtime dependency', () => {
  const packagedFiles = new Set(
    packageJson.build.files.filter((entry) => typeof entry === 'string'),
  );
  const pending = ['main.cjs', 'preload.cjs', 'settings-preload.cjs'];
  const visited = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    assert.ok(packagedFiles.has(file), `${file} is missing from build.files`);

    const source = readFileSync(path.join(electronRoot, file), 'utf8');
    const localRequire = /require\(['"]\.\/([^'"]+\.cjs)['"]\)/g;
    for (const match of source.matchAll(localRequire)) {
      pending.push(match[1]);
    }
  }
});
