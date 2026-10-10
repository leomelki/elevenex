const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const downloadUtils = require('../download-utils.cjs');
const fetchJson = downloadUtils.fetchJson;
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
      ? Array.from({ length: 10 }, (_, index) => release(`runtime-pr-${index + 1}-${latest}`))
      : [release(`runtime-${latest}`)];
  });
  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /per_page=10&/);
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

test('oversized release responses are retried with smaller pages', { skip: !target.supported }, async (context) => {
  const queries = [];
  const server = http.createServer((request, response) => {
    const query = new URL(request.url, 'http://localhost').search;
    queries.push(query);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(query.includes('per_page=10&')
      ? [{ ...release(`runtime-${latest}`), body: 'x'.repeat(8 * 1024 * 1024) }]
      : [release(`runtime-${latest}`)]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const instance = updater(context, (url, options) => fetchJson(
    `http://127.0.0.1:${server.address().port}/${new URL(url).search}`, options,
  ));

  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
  assert.deepEqual(queries, ['?per_page=10&page=1', '?per_page=5&page=1']);
});

test('shrinking a later page restarts pagination without skipping releases', { skip: !target.supported }, async (context) => {
  const queries = [];
  const previews = Array.from({ length: 10 }, (_, index) => release(`runtime-pr-${index + 1}-${latest}`));
  const instance = updater(context, async (url) => {
    const query = new URL(url).search;
    queries.push(query);
    if (query === '?per_page=10&page=1') return previews;
    if (query === '?per_page=10&page=2') {
      throw Object.assign(new Error('Response too large'), { code: 'ERR_RESPONSE_TOO_LARGE' });
    }
    if (query === '?per_page=5&page=1' || query === '?per_page=5&page=2') return previews.slice(0, 5);
    return [release(`runtime-${latest}`)];
  });

  const state = await instance.check();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, latest);
  assert.deepEqual(queries, [
    '?per_page=10&page=1', '?per_page=10&page=2',
    '?per_page=5&page=1', '?per_page=5&page=2', '?per_page=5&page=3',
  ]);
});

test('a single oversized release terminates with an error', { skip: !target.supported }, async (context) => {
  const sizes = [];
  const instance = updater(context, async (url) => {
    sizes.push(Number(new URL(url).searchParams.get('per_page')));
    throw Object.assign(new Error('Response too large'), { code: 'ERR_RESPONSE_TOO_LARGE' });
  });
  const state = await instance.check();
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Response too large');
  assert.deepEqual(sizes, [10, 5, 2, 1]);
});

test('rate limits are reported without retrying with smaller pages', { skip: !target.supported }, async (context) => {
  let requests = 0;
  const instance = updater(context, async () => {
    requests += 1;
    throw Object.assign(new Error('HTTP 403'), { statusCode: 403 });
  });
  const state = await instance.check();
  assert.equal(state.status, 'error');
  assert.match(state.error, /rate limiting/);
  assert.equal(requests, 1);
});
