const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const sha = 'b'.repeat(40);
const tag = `runtime-pr-123-${sha}`;
const targets = [
  'elevenex-remote-runtime-linux-x64.tar.gz',
  'elevenex-remote-runtime-linux-arm64.tar.gz',
  'elevenex-remote-runtime-darwin-arm64.tar.gz',
  'elevenex-remote-runtime-win32-x64.zip',
];
const desktop = [
  'elevenex-new-desktop-macos-arm64.dmg',
  'elevenex-new-desktop-linux-x86_64.AppImage',
  'elevenex-new-desktop-linux-amd64.deb',
  'elevenex-new-desktop-linux-arm64.AppImage',
  'elevenex-new-desktop-linux-arm64.deb',
  'elevenex-new-desktop-windows-x64.exe',
];
const backend = [
  'elevenex-backend-macos-arm64.tar.gz',
  'elevenex-backend-linux-x64.tar.gz',
  'elevenex-backend-linux-arm64.tar.gz',
  'elevenex-backend-windows-x64.tar.gz',
];
const assets = [...targets, ...desktop, ...backend];

function fixture(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-manifest-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  mkdirSync(source);
  const files = assets.map(asset => {
    const file = path.join(source, asset);
    writeFileSync(file, asset);
    return file;
  });
  const staged = path.join(directory, 'artifacts');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'stage-release-assets.cjs'), staged, ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return staged;
}

function publish(directory, env = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, 'write-release-manifest.cjs'), directory], {
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: sha, RELEASE_TAG: tag, RELEASE_PR: '123', ...env },
  });
}

test('complete preview assets produce a manifest with matching runtime identity and verified checksums', (context) => {
  const directory = fixture(context);
  const result = publish(directory);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest-new-desktop.json'), 'utf8'));
  assert.equal(manifest.version, sha);
  assert.equal(manifest.releaseTag, tag);
  assert.equal(manifest.ref, 'refs/pull/123/head');
  assert.equal(manifest.pullRequest, 123);
  for (const [section, expected] of [[manifest.targets, targets], [manifest.desktop, desktop], [manifest.backend, backend]]) {
    assert.deepEqual(section.map(asset => asset.archive), expected);
    for (const asset of section) {
      assert.equal(asset.sha256, createHash('sha256').update(asset.archive).digest('hex'));
    }
  }
});

test('branch releases retain the commit-based runtime tag', (context) => {
  const directory = fixture(context);
  const releaseTag = `runtime-${sha}`;
  const result = publish(directory, { RELEASE_PR: '', RELEASE_TAG: releaseTag, GITHUB_REF: 'refs/heads/main' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest-new-desktop.json'), 'utf8'));
  assert.equal(manifest.releaseTag, releaseTag);
  assert.equal(manifest.ref, 'refs/heads/main');
  assert.equal(manifest.pullRequest, null);
});

test('missing, corrupt and checksum-less uploads prevent publication', (context) => {
  for (const asset of [targets[0], desktop[3], backend[3]]) {
    const missing = fixture(context);
    rmSync(path.join(missing, asset));
    assert.notEqual(publish(missing).status, 0, asset);
    const corrupt = fixture(context);
    writeFileSync(path.join(corrupt, asset), 'corrupt');
    assert.match(publish(corrupt).stderr, /Invalid checksum/, asset);
    const noChecksum = fixture(context);
    rmSync(path.join(noChecksum, `${asset}.sha256`));
    assert.notEqual(publish(noChecksum).status, 0, asset);
  }
});

test('checksum sidecars must identify their own release asset', (context) => {
  const directory = fixture(context);
  const asset = desktop[0];
  const checksum = createHash('sha256').update(asset).digest('hex');
  writeFileSync(path.join(directory, `${asset}.sha256`), `${checksum}  different.dmg\n`);
  assert.match(publish(directory).stderr, /Invalid checksum filename/);
});

test('publication refuses an incorrect runtime tag or unexpected installer', (context) => {
  const directory = fixture(context);
  assert.match(publish(directory, { RELEASE_TAG: `runtime-${'c'.repeat(40)}` }).stderr, /tag does not match/);
  writeFileSync(path.join(directory, 'elevenex-desktop-windows-x64.exe'), 'old installer');
  assert.match(publish(directory).stderr, /Unexpected release asset/);
});
