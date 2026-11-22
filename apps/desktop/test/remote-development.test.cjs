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
  const workspace = { ELEVENEX_DESKTOP_DEV_REMOTE_WORKSPACE: 'untrusted' };
  assert.equal(developmentRemote(true, { ...workspace, ELEVENEX_DESKTOP_DEV_BACKEND: '/untrusted' }), undefined);
  assert.equal(developmentRemote(false, workspace), undefined);
});

test('the shared command keeps a fixed workspace and accepts an exact existing ID', async () => {
  const { developmentLaunchOptions } = await import('../../../scripts/desktop-backend-development.mjs');
  const base = developmentLaunchOptions(['--linux'], true);
  const id = 'c'.repeat(32);
  assert.match(base.workspace, /^[a-f0-9]{32}$/);
  assert.equal(developmentLaunchOptions([], true).workspace, base.workspace);
  assert.deepEqual(developmentLaunchOptions(['--linux', '--workspace', id, '--x64'], true), { linuxArchitecture: 'x64', workspace: id });
  assert.deepEqual(developmentLaunchOptions(['--linux']), { linuxArchitecture: 'arm64' });
  assert.throws(() => developmentLaunchOptions(['--workspace', id]), /desktop:dev/);
  for (const args of [['--workspace'], ['--workspace', '../desktop-remote'], ['--workspace', id, '--workspace', id]]) {
    assert.throws(() => developmentLaunchOptions(args, true), /workspace|desktop:dev/);
  }
});

test('shared development workspace selection scopes saved machine state and validates its input', async t => {
  const { root, env, options, release } = await setup(t);
  const id = 'a'.repeat(32);
  const selection = { ...env, ELEVENEX_DESKTOP_DEV_REMOTE_WORKSPACE: id };
  const shared = developmentRemote(false, selection);
  assert.equal(shared.namespace, id);
  assert.equal(shared.settingsFilename, `remote-settings.shared-${id}.json`);
  assert.equal(developmentRemote(false, { ...selection, ELEVENEX_DESKTOP_DEV_BACKEND: join(root, 'other') }).namespace, id);
  assert.equal(options.settingsFilename, undefined);
  assert.throws(() => developmentRemote(false, { ...selection, ELEVENEX_DESKTOP_DEV_REMOTE_WORKSPACE: '../remote' }), /Invalid shared development workspace/);
  const linux = backendRelease({ version, tag: `runtime-${version}` }, 'linux', release.target === 'linux-arm64' ? 'x64' : 'arm64');
  await assert.rejects(shared.archive(root, linux, AbortSignal.timeout(1000), () => {}), new RegExp(`desktop:dev:shared --workspace ${id} --linux`));
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

test('a Mac development launcher can provide a Linux ARM64 archive using the detected server target', async t => {
  const { root, directory, options } = await setup(t);
  const release = backendRelease({ version, tag: `runtime-${version}` }, 'linux', 'arm64');
  const bytes = archive();
  await writeFile(join(directory, release.archiveName), bytes);
  await writeFile(join(directory, 'remote-archive.json'), JSON.stringify({ version, target: release.target, digest: createHash('sha256').update(bytes).digest('hex') }));
  const result = await options.archive(root, release, new AbortController().signal, () => {});
  assert.equal(result.path, join(directory, 'elevenex-backend-linux-arm64.tar.gz'));
  await assert.rejects(options.archive(root, backendRelease({ version, tag: `runtime-${version}` }, 'linux', 'x64'), new AbortController().signal, () => {}), /desktop:dev --linux --x64/);
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

test('a shared Linux build keeps its revision across checkout line endings and tracks real changes', async t => {
  const { root } = await setup(t);
  await promisify(execFile)('git', ['init'], { cwd: root });
  const sources = join(root, 'apps/backend/src');
  await mkdir(sources, { recursive: true });
  const source = join(sources, 'main.ts');
  const binary = join(sources, 'asset.wasm');
  const { developmentRevision } = await import('../../../scripts/desktop-backend-development.mjs');
  await writeFile(source, 'export const value = 1;\n');
  await writeFile(binary, Buffer.from([0, 13, 10, 1]));
  const regular = await developmentRevision(root);
  const linux = await developmentRevision(root, 'arm64');
  await writeFile(source, 'export const value = 1;\r\n');
  assert.equal(await developmentRevision(root, 'arm64'), linux);
  assert.notEqual(await developmentRevision(root), regular);
  assert.notEqual(await developmentRevision(root, 'x64'), linux);
  await writeFile(binary, Buffer.from([0, 10, 1]));
  assert.notEqual(await developmentRevision(root, 'arm64'), linux);
  await writeFile(binary, Buffer.from([0, 13, 10, 1]));
  await writeFile(source, 'export const value = 2;\r\n');
  assert.notEqual(await developmentRevision(root, 'arm64'), linux);
});
