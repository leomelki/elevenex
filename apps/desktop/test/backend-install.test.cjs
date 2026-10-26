const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { backendRelease } = require('../dist/backend/release');
const { downloadBackend, releaseResponse } = require('../dist/backend/download');
const { extractBackend } = require('../dist/backend/archive');
const { installBackend } = require('../dist/backend/install');
const { tar, archive, releaseFetch, version } = require('./backend-fixtures.cjs');
const { Response } = globalThis;

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'elevenex-backend-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const signal = () => new AbortController().signal;
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);

test('release resolution pins the source revision and checks tags and platform', () => {
  assert.ok(release.url.endsWith(`/${release.tag}/elevenex-backend-${release.target}.tar.gz`));
  assert.equal(backendRelease({ version, tag: `runtime-pr-42-${version}` }, 'win32', 'x64').target, 'windows-x64');
  for (const metadata of [null, {}, { version: '../escape', tag: 'latest' }, { version, tag: 'latest' }, { version, tag: `runtime-${'b'.repeat(40)}` }]) {
    assert.throws(() => backendRelease(metadata, 'darwin', 'arm64'));
  }
  assert.throws(() => backendRelease({ version, tag: release.tag }, 'freebsd', 'x64'), /Unsupported/);
});

test('first install verifies and extracts, then works offline without another download', async t => {
  const root = await temporary(t);
  const { request, calls } = releaseFetch(release);
  const progress = [];
  const installed = await installBackend(root, release, signal(), (...args) => progress.push(args), request);
  assert.equal(await readFile(installed.entry, 'utf8'), 'console.log("backend");');
  assert.ok(installed.directory.startsWith(root));
  assert.ok(progress.some(([phase]) => phase === 'extracting'));
  assert.equal(calls.length, 2);
  const cached = await installBackend(root, release, signal(), () => {}, async () => { throw new Error('offline'); });
  assert.deepEqual(cached, installed);
  assert.equal((await readdir(join(root, 'runtimes'))).length, 1);
});

test('updates use a separate revision and a failed update preserves the prior runtime', async t => {
  const root = await temporary(t);
  const first = await installBackend(root, release, signal(), () => {}, releaseFetch(release).request);
  const updated = backendRelease({ version: 'b'.repeat(40), tag: `runtime-${'b'.repeat(40)}` }, process.platform, process.arch);
  await assert.rejects(installBackend(root, updated, signal(), () => {}, releaseFetch(updated, archive(), { checksum: '0'.repeat(64) }).request), /checksum mismatch/);
  assert.equal(await readFile(first.entry, 'utf8'), 'console.log("backend");');
  assert.equal((await readdir(join(root, 'runtimes'))).length, 1);
  const second = await installBackend(root, updated, signal(), () => {}, releaseFetch(updated).request);
  assert.notEqual(first.directory, second.directory);
  assert.equal((await readdir(join(root, 'runtimes'))).length, 2);
});

test('a damaged installation is repaired through staging', async t => {
  const root = await temporary(t);
  const first = await installBackend(root, release, signal(), () => {}, releaseFetch(release).request);
  await rm(first.entry);
  const { request, calls } = releaseFetch(release);
  await installBackend(root, release, signal(), () => {}, request);
  assert.equal(calls.length, 2);
  assert.equal(await readFile(first.entry, 'utf8'), 'console.log("backend");');
});

test('cancellation removes staging and publishes no completed installation', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  const request = releaseFetch(release).request;
  await assert.rejects(installBackend(root, release, controller.signal, phase => {
    if (phase === 'extracting') controller.abort();
  }, request), { name: 'AbortError' });
  assert.deepEqual(await readdir(join(root, 'runtimes')), []);
});

test('release redirects cannot leave approved HTTPS hosts or exceed the redirect limit', async () => {
  for (const location of ['http://github.com/asset', 'https://evil.test/asset', 'file:///tmp/asset', 'https://user@github.com/asset']) {
    let calls = 0;
    await assert.rejects(releaseResponse(release.url, signal(), async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    }), /approved HTTPS/);
    assert.equal(calls, 1);
  }
  await assert.rejects(releaseResponse(release.url, signal(), async () => new Response(null, { status: 302, headers: { location: release.url } })), /Too many/);
  await assert.rejects(releaseResponse(release.url, signal(), async () => new Response(null, { status: 404 })), /HTTP 404/);
});

test('downloads reject malformed checksums, wrong filenames, partial and oversized responses', async t => {
  const root = await temporary(t);
  const badBodies = ['invalid', `${'a'.repeat(64)}  wrong.tar.gz`, 'a'.repeat(4097)];
  for (let i = 0; i < badBodies.length; i++) {
    await assert.rejects(downloadBackend(release, join(root, `bad-${i}`), signal(), () => {}, async () => new Response(badBodies[i])));
  }
  const request = releaseFetch(release).request;
  for (const length of ['1073741825', 'NaN', String(archive().length + 1)]) {
    await assert.rejects(downloadBackend(release, join(root, length), signal(), () => {}, async (url, init) => {
      if (String(url).endsWith('.sha256')) return request(url, init);
      return new Response(archive(), { headers: { 'content-length': length } });
    }), /size|Incomplete/);
  }
});

test('safe extraction rejects traversal, links, devices, duplicate files and truncated archives', async t => {
  const root = await temporary(t);
  const cases = [
    [{ name: '../escape', body: 'unsafe' }],
    [{ name: '/backend/absolute', body: 'unsafe' }],
    [{ name: 'backend/../../escape', body: 'unsafe' }],
    [{ name: 'backend/C:drive', body: 'unsafe' }],
    [{ name: 'backend/link', type: '2' }],
    [{ name: 'backend/link', type: '1' }],
    [{ name: 'backend/device', type: '3' }],
    [{ name: 'backend/file', body: 'first' }, { name: 'backend/file', body: 'second' }],
  ];
  for (let index = 0; index < cases.length; index++) {
    const path = join(root, `${index}.tar.gz`);
    await writeFile(path, tar(cases[index]));
    await assert.rejects(extractBackend(path, join(root, `out-${index}`), signal()));
  }
  const truncated = join(root, 'truncated.tar.gz');
  await writeFile(truncated, archive().subarray(0, -12));
  await assert.rejects(extractBackend(truncated, join(root, 'truncated'), signal()));
  await assert.rejects(readFile(join(root, 'escape')));
});

test('extracts archives created by the host tar, including PAX long UTF-8 paths', async t => {
  const root = await temporary(t);
  const { mkdir } = require('node:fs/promises');
  const path = `backend/${'long'.repeat(30)}/${'é'.repeat(70)}.js`;
  await mkdir(join(root, 'input', path, '..'), { recursive: true });
  await writeFile(join(root, 'input', path), 'long UTF-8 path');
  await promisify(execFile)('tar', ['--format=pax', '-czf', join(root, 'native.tar.gz'), '-C', join(root, 'input'), 'backend']);
  await extractBackend(join(root, 'native.tar.gz'), join(root, 'output'), signal());
  assert.equal(await readFile(join(root, 'output', path), 'utf8'), 'long UTF-8 path');
});
