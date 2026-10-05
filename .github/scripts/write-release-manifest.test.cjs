const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const sha = 'b'.repeat(40);
const tag = `runtime-pr-123-${sha}`;
const assets = [
  'elevenex-remote-runtime-linux-x64.tar.gz',
  'elevenex-remote-runtime-linux-arm64.tar.gz',
  'elevenex-remote-runtime-darwin-arm64.tar.gz',
  'elevenex-remote-runtime-win32-x64.zip',
  'elevenex-runtime-macos-arm64.tar.gz',
  'elevenex-runtime-linux-x64.tar.gz',
  'elevenex-runtime-windows-x64.tar.gz',
  'elevenex-desktop-macos-arm64.dmg',
  'elevenex-desktop-linux-x64.AppImage',
  'elevenex-desktop-linux-x64.deb',
  'elevenex-desktop-windows-x64.exe',
];

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-manifest-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const asset of assets) {
    writeFileSync(path.join(directory, asset), asset);
    const checksum = createHash('sha256').update(asset).digest('hex');
    writeFileSync(path.join(directory, `${asset}.sha256`), `${checksum}  ${asset}\n`);
  }
  writeFileSync(path.join(directory, 'source-maps-manifest.json'), JSON.stringify({ version: sha, releaseTag: tag }));
  return directory;
}

function publish(directory) {
  return spawnSync(process.execPath, [path.join(__dirname, 'write-release-manifest.cjs'), directory], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: sha, RELEASE_TAG: tag, RELEASE_PR: '123' },
  });
}

test('complete preview assets produce a manifest with the matching runtime identity', (context) => {
  const directory = fixture(context);
  const result = publish(directory);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, sha);
  assert.equal(manifest.releaseTag, tag);
  assert.equal(manifest.pullRequest, 123);
  assert.equal(manifest.targets.length, 4);
  assert.equal(manifest.desktopRuntime.length, 3);
  assert.equal(manifest.desktop.length, 4);
  assert.ok(manifest.targets.every((target) => target.sha256.length === 64));
});

test('partial and corrupt runtime uploads cannot be published', (context) => {
  const missing = fixture(context);
  rmSync(path.join(missing, assets[0]));
  assert.notEqual(publish(missing).status, 0);
  const corrupt = fixture(context);
  writeFileSync(path.join(corrupt, assets[0]), 'corrupt runtime');
  const result = publish(corrupt);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid checksum/);
});

test('source maps from the workflow branch cannot be published in a PR release', (context) => {
  const directory = fixture(context);
  writeFileSync(path.join(directory, 'source-maps-manifest.json'), JSON.stringify({ version: 'a'.repeat(40), releaseTag: tag }));
  const result = publish(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source maps refer to another release/);
});
