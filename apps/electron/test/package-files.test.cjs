const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const electronRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

// build.files mixes literal names with globs (`*.cjs`), so membership cannot be
// a plain Set lookup. Only the shapes actually used are supported, and anything
// else is rejected loudly rather than silently passing a file that would not
// ship.
function coversFile(pattern, file) {
  if (pattern.startsWith('!')) {
    return false;
  }
  if (pattern === file) {
    return true;
  }
  if (pattern === '*.cjs') {
    // Top level only: a glob without a slash does not descend into directories.
    return file.endsWith('.cjs') && !file.includes('/');
  }
  if (pattern.endsWith('/**/*')) {
    return file.startsWith(`${pattern.slice(0, -5)}`);
  }
  return false;
}

test('electron package includes every local CommonJS runtime dependency', () => {
  const patterns = packageJson.build.files.filter((entry) => typeof entry === 'string');
  const pending = ['main.cjs', 'preload.cjs', 'settings-preload.cjs'];
  const visited = new Set();

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    assert.ok(
      patterns.some((pattern) => coversFile(pattern, file)),
      `${file} is not covered by build.files`,
    );

    const source = readFileSync(path.join(electronRoot, file), 'utf8');
    const localRequire = /require\(['"]\.\/([^'"]+\.cjs)['"]\)/g;
    for (const match of source.matchAll(localRequire)) {
      pending.push(match[1]);
    }
  }

  // Guards the traversal itself: if the walk silently stopped finding requires,
  // every assertion above would vacuously pass.
  assert.ok(visited.has('link-manager.cjs'), 'expected the remote-link stack to be reached from main.cjs');
  assert.ok(visited.has('link-ws.cjs'), 'expected the transitive link modules to be reached');
});
