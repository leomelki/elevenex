const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveRuntimeReleaseTag } = require('../runtime-release.cjs');

const sha = 'a'.repeat(40);

function resources(context, tag) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-release-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  if (tag !== undefined) writeFileSync(path.join(directory, 'release-tag'), tag);
  return directory;
}

test('old installations resolve their original runtime release', (context) => {
  assert.equal(resolveRuntimeReleaseTag(sha, resources(context)), `runtime-${sha}`);
});

test('preview local and SSH runtimes resolve the same exact PR release', (context) => {
  const tag = `runtime-pr-123-${sha}`;
  const directory = resources(context, `${tag}\n`);
  assert.equal(resolveRuntimeReleaseTag(sha, directory), tag);
});

test('main builds resolve their normal release', (context) => {
  assert.equal(resolveRuntimeReleaseTag(sha, resources(context, `runtime-${sha}`)), `runtime-${sha}`);
});

test('mismatched, empty, and unsafe release markers fail closed', (context) => {
  for (const tag of ['', `runtime-pr-123-${'b'.repeat(40)}`, `runtime-pr-0-${sha}`, `../../${sha}`]) {
    assert.throws(() => resolveRuntimeReleaseTag(sha, resources(context, tag)), /does not match/);
  }
});

test('unsafe versions cannot become release download URLs', (context) => {
  const directory = resources(context);
  for (const version of [null, '', '../main', 'a/b', 'v1.2.3/../../main']) {
    assert.equal(resolveRuntimeReleaseTag(version, directory), null);
  }
});
