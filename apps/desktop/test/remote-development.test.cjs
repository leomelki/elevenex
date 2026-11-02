const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, mkdir, writeFile, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { developmentRemote } = require('../dist/remote/development');
const { backendRelease } = require('../dist/backend/release');
const { archive, version } = require('./backend-fixtures.cjs');

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'ex-dev-archive-')); const directory = join(root, 'build');
  await mkdir(directory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
  await writeFile(join(directory, 'backend-release.json'), JSON.stringify(release));
  const bytes = archive();
  await writeFile(join(directory, release.archiveName), bytes);
  await writeFile(join(directory, 'remote-archive.json'), JSON.stringify({ version, target: release.target, digest: createHash('sha256').update(bytes).digest('hex') }));
  const env = { ELEVENEX_DESKTOP_DEV_BACKEND: directory, ELEVENEX_DESKTOP_DEV_NODE: process.execPath };
  return { root, directory, release, env, options: developmentRemote(false, env) };
}

test('packaged and ordinary launches never honor custom SSH builds', () => {
  assert.equal(developmentRemote(true, { ELEVENEX_DESKTOP_DEV_BACKEND: '/untrusted' }), undefined);
  assert.equal(developmentRemote(false, {}), undefined);
});

test('development uses local revision metadata and validates its archive without a network download', async t => {
  const { root, directory, release, options, env } = await setup(t);
  assert.deepEqual(await options.release(), release);
  const result = await options.archive(root, release, new AbortController().signal, () => {});
  assert.equal(result.path, join(directory, release.archiveName)); assert.ok(result.bytes > 0);
  assert.deepEqual(await readdir(root), ['build']);
  assert.match(options.namespace, /^[a-f0-9]{32}$/);
  assert.equal(developmentRemote(false, env).namespace, options.namespace);
  assert.notEqual(developmentRemote(false, { ...env, ELEVENEX_DESKTOP_DEV_BACKEND: join(root, 'other') }).namespace, options.namespace);
});

test('development never transfers another target, a stale build or modified bytes', async t => {
  const { root, directory, release, options } = await setup(t);
  const signal = new AbortController().signal;
  await assert.rejects(options.archive(root, { ...release, target: 'other-platform' }, signal, () => {}), /same OS and architecture/);
  await assert.rejects(options.archive(root, { ...release, version: 'b'.repeat(40) }, signal, () => {}), /unavailable/);
  await writeFile(join(directory, release.archiveName), 'modified');
  await assert.rejects(options.archive(root, release, signal, () => {}), /checksum mismatch/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(options.archive(root, release, controller.signal, () => {}), /abort/i);
});

test('development identity follows dirty and untracked sources but excludes its generated stamp', async t => {
  const { root } = await setup(t); const run = promisify(execFile);
  const git = (...args) => run('git', args, { cwd: root });
  await mkdir(join(root, 'apps/backend/src/generated'), { recursive: true });
  await writeFile(join(root, 'apps/backend/src/main.ts'), 'first');
  await git('init'); await git('add', 'apps');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const { developmentRevision } = await import('../../../scripts/desktop-backend-development.mjs');
  const initial = await developmentRevision(root);
  await writeFile(join(root, 'apps/backend/src/generated/git-sha.ts'), initial);
  assert.equal(await developmentRevision(root), initial);
  await writeFile(join(root, 'apps/backend/src/main.ts'), 'dirty');
  const dirty = await developmentRevision(root); assert.notEqual(dirty, initial);
  await writeFile(join(root, 'apps/backend/src/new.ts'), 'untracked');
  assert.notEqual(await developmentRevision(root), dirty);
});
