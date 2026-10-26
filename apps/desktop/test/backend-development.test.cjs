const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { developmentBackend } = require('../dist/backend/development');
const { BackendManager } = require('../dist/backend/manager');
const { version } = require('./backend-fixtures.cjs');

test('packaged apps and ordinary launches ignore development backend configuration', () => {
  const env = { ELEVENEX_DESKTOP_DEV_BACKEND: '/missing', ELEVENEX_DESKTOP_DEV_NODE: '/missing/node' };
  assert.equal(developmentBackend(true, env), undefined);
  assert.equal(developmentBackend(false, {}), undefined);
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-development-'));
  const directory = join(root, 'runtime');
  await mkdir(directory);
  await writeFile(join(directory, 'backend-release.json'), JSON.stringify({ version, tag: `runtime-${version}` }));
  const env = { ELEVENEX_DESKTOP_DEV_BACKEND: directory, ELEVENEX_DESKTOP_DEV_NODE: process.execPath };
  const options = developmentBackend(false, env);
  const manager = new BackendManager({ root, ...options });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { manager, directory, options };
}

test('local backend starts, restarts and stops under Node without download phases', async t => {
  const { manager, directory } = await setup(t);
  await writeFile(join(directory, 'main.cjs'), `
    require('node:http').createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ backendSha: '${version}', pid: process.pid }));
    }).listen(Number(process.env.ELEVENEX_PROXY_PORT), process.env.ELEVENEX_BIND_HOST);
  `);
  const phases = [];
  manager.subscribe(status => phases.push(status.phase));
  const first = await manager.start();
  assert.equal(first.phase, 'ready');
  assert.equal(first.version, version);
  const firstInfo = await (await fetch(`${first.url}/api/info`)).json();
  const second = await manager.restart();
  assert.equal(second.phase, 'ready');
  const secondInfo = await (await fetch(`${second.url}/api/info`)).json();
  assert.notEqual(firstInfo.pid, secondInfo.pid);
  assert.equal(phases.includes('downloading'), false);
  assert.equal(phases.includes('extracting'), false);
  await manager.dispose();
  assert.equal(manager.snapshot().phase, 'stopped');
  await assert.rejects(fetch(`${second.url}/api/info`));
});

test('missing local output fails without falling back to a release download', async t => {
  const { manager } = await setup(t);
  const phases = [];
  manager.subscribe(status => phases.push(status.phase));
  const status = await manager.start();
  assert.equal(status.phase, 'failed');
  assert.match(status.message, /main.cjs/);
  assert.equal(phases.includes('downloading'), false);
});

test('development configuration validates paths, revision metadata and cancellation', async t => {
  const relative = developmentBackend(false, { ELEVENEX_DESKTOP_DEV_BACKEND: 'relative', ELEVENEX_DESKTOP_DEV_NODE: process.execPath });
  await assert.rejects(relative.release(), /absolute/);
  const { directory, options } = await setup(t);
  await writeFile(join(directory, 'backend-release.json'), '{}');
  await assert.rejects(options.release(), /metadata/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(options.install('', {}, controller.signal, () => {}), /abort/i);
});
