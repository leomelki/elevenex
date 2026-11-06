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
  'elevenex-backend-macos-arm64.tar.gz',
  'elevenex-backend-linux-x64.tar.gz',
  'elevenex-backend-linux-arm64.tar.gz',
  'elevenex-backend-windows-x64.tar.gz',
];

const newDesktopAssets = [
  ...assets.filter(asset => asset.startsWith('elevenex-remote-runtime-') || asset.startsWith('elevenex-backend-')),
  'elevenex-new-desktop-macos-arm64.dmg',
];

function fixture(context, includedAssets = assets) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-manifest-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const asset of includedAssets) {
    writeFileSync(path.join(directory, asset), asset);
    const checksum = createHash('sha256').update(asset).digest('hex');
    writeFileSync(path.join(directory, `${asset}.sha256`), `${checksum}  ${asset}\n`);
  }
  writeFileSync(path.join(directory, 'source-maps-manifest.json'), JSON.stringify({ version: sha, releaseTag: tag }));
  return directory;
}

function publish(directory, env = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, 'write-release-manifest.cjs'), directory], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: sha, RELEASE_TAG: tag, RELEASE_PR: '123', RELEASE_PROFILE: 'legacy', ...env },
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
  assert.equal(manifest.backend.length, 4);
  assert.ok(manifest.backend.every(target => target.sha256.length === 64));
  assert.ok(manifest.targets.every((target) => target.sha256.length === 64));
});

test('a missing or corrupt standalone backend prevents publication', (context) => {
  const missing = fixture(context);
  rmSync(path.join(missing, 'elevenex-backend-macos-arm64.tar.gz'));
  assert.notEqual(publish(missing).status, 0);
  const corrupt = fixture(context);
  writeFileSync(path.join(corrupt, 'elevenex-backend-linux-x64.tar.gz'), 'corrupt');
  assert.match(publish(corrupt).stderr, /Invalid checksum/);
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

const newDesktopEnv = {
  RELEASE_PROFILE: 'new-desktop', RELEASE_TAG: `runtime-${sha}`, RELEASE_PR: '', GITHUB_REF: 'refs/heads/feat/new-ui',
};

test('new desktop releases require only their DMG, standalone backends and remote runtimes', (context) => {
  const directory = fixture(context, newDesktopAssets);
  rmSync(path.join(directory, 'source-maps-manifest.json'));
  // A new desktop release must not overwrite the legacy manifest at the same tag.
  writeFileSync(path.join(directory, 'manifest.json'), 'legacy manifest');
  const result = publish(directory, newDesktopEnv);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest-new-desktop.json'), 'utf8'));
  assert.equal(manifest.version, sha);
  assert.equal(manifest.releaseTag, `runtime-${sha}`);
  assert.equal(manifest.ref, 'refs/heads/feat/new-ui');
  assert.equal(manifest.pullRequest, null);
  assert.deepEqual(manifest.desktop.map(asset => asset.archive), ['elevenex-new-desktop-macos-arm64.dmg']);
  assert.deepEqual(manifest.desktopRuntime, []);
  assert.equal(manifest.sourceMaps, null);
  assert.equal(manifest.backend.length, 4);
  assert.equal(manifest.targets.length, 4);
  assert.ok([...manifest.desktop, ...manifest.backend, ...manifest.targets].every(asset => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.equal(readFileSync(path.join(directory, 'manifest.json'), 'utf8'), 'legacy manifest');
});

test('new desktop publication rejects missing, corrupt and checksum-less assets', (context) => {
  for (const asset of newDesktopAssets) {
    const missing = fixture(context, newDesktopAssets);
    rmSync(path.join(missing, asset));
    assert.notEqual(publish(missing, newDesktopEnv).status, 0, asset);
    const corrupt = fixture(context, newDesktopAssets);
    writeFileSync(path.join(corrupt, asset), 'corrupt');
    assert.match(publish(corrupt, newDesktopEnv).stderr, /Invalid checksum/, asset);
    const noChecksum = fixture(context, newDesktopAssets);
    rmSync(path.join(noChecksum, `${asset}.sha256`));
    assert.notEqual(publish(noChecksum, newDesktopEnv).status, 0, asset);
  }
});

test('new desktop publication rejects a mismatched release tag', (context) => {
  const result = publish(fixture(context, newDesktopAssets), { ...newDesktopEnv, RELEASE_TAG: `runtime-${'c'.repeat(40)}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag does not match/);
});

test('an unknown release profile cannot silently omit required assets', (context) => {
  const result = publish(fixture(context), { RELEASE_PROFILE: 'unknown' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown release profile/);
});
