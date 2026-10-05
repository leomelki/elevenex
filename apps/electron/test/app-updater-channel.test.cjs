const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const downloadUtils = require('../download-utils.cjs');
const { resolveUpdateTarget } = require('../app-updater.cjs');

const target = resolveUpdateTarget();
const current = 'a'.repeat(40);
const latest = 'b'.repeat(40);

function release(tag, date = '2026-10-01T00:00:00Z') {
  return { tag_name: tag, published_at: date, assets: [{ name: target.assetName }] };
}

function updater(context, fetchJson, version = current) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'elevenex-channel-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  context.mock.method(downloadUtils, 'fetchJson', fetchJson);
  // The updater captures its download functions at module load time.
  delete require.cache[require.resolve('../app-updater.cjs')];
  const { createAppUpdater } = require('../app-updater.cjs');
  return createAppUpdater({
    app: { isPackaged: true, getPath: () => directory },
    shell: {}, getCurrentVersion: () => version, onStateChanged: () => {}, requestQuit: () => {},
  });
}

test('PR previews never replace a regular desktop update', { skip: !target.supported }, async (context) => {
  const instance = updater(context, async () => [
    release(`runtime-pr-123-${'c'.repeat(40)}`, '2026-10-02T00:00:00Z'),
    release(`runtime-${latest}`),
  ]);
  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
});

test('a full page of previews cannot hide the next regular release', { skip: !target.supported }, async (context) => {
  const urls = [];
  const instance = updater(context, async (url) => {
    urls.push(url);
    return urls.length === 1
      ? Array.from({ length: 100 }, (_, index) => release(`runtime-pr-${index + 1}-${latest}`))
      : [release(`runtime-${latest}`)];
  });
  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /page=1$/);
  assert.match(urls[1], /page=2$/);
});

test('preview installations can return to a regular main release', { skip: !target.supported }, async (context) => {
  const instance = updater(context, async () => [release(`runtime-${latest}`)], 'c'.repeat(40));
  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
});

test('a repository with only previews terminates without offering one', { skip: !target.supported }, async (context) => {
  const instance = updater(context, async () => [release(`runtime-pr-123-${latest}`)]);
  const state = await instance.check();
  assert.equal(state.status, 'up-to-date');
  assert.equal(state.latestVersion, null);
});
