const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtemp, writeFile, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { startBackend } = require('../dist/backend/process');
const { version } = require('./backend-fixtures.cjs');

const fixture = `
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/api/info') response.end(JSON.stringify({ backendSha: '${version}' }));
  else if (request.url === '/exit75') { response.end('{}'); setTimeout(() => process.exit(75), 20); }
  else response.end(JSON.stringify({ pid: process.pid, worker: worker.pid,
    db: process.env.DB_PATH, dataRoot: process.env.ELEVENEX_DATA_ROOT, bind: process.env.ELEVENEX_BIND_HOST,
    nodeOptions: process.env.NODE_OPTIONS, supervised: process.env.ELEVENEX_BACKEND_SUPERVISED,
    runtimeRoot: process.env.ELEVENEX_BACKEND_RUNTIME_ROOT, inheritedOverride: process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN,
  }));
}).listen(Number(process.env.ELEVENEX_PROXY_PORT), process.env.ELEVENEX_BIND_HOST);
`;

async function setup(t, code = fixture) {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-process-'));
  const entry = join(root, 'fixture.cjs');
  await mkdir(join(root, 'data'));
  await writeFile(entry, code);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, installation: { entry, directory: root, executable: process.execPath } };
}

async function until(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  assert.fail('Condition did not become true');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('starts on loopback with isolated data, verifies readiness, and stops the whole process tree', async t => {
  const { root, installation } = await setup(t);
  const oldOverride = process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN;
  process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN = 'https://untrusted.test';
  t.after(() => { if (oldOverride === undefined) delete process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN; else process.env.ELEVENEX_PROXY_UPSTREAM_ORIGIN = oldOverride; });
  const running = await startBackend(installation, root, version, new AbortController().signal);
  t.after(() => running.stop());
  const info = await (await fetch(running.url)).json();
  assert.equal(info.db, join(root, 'data/elevenex.db'));
  assert.equal(info.dataRoot, join(root, 'data'));
  assert.equal(info.bind, '127.0.0.1');
  assert.equal(info.supervised, '1');
  assert.equal(info.runtimeRoot, root);
  assert.equal(info.inheritedOverride, undefined);
  assert.equal(info.nodeOptions, undefined);
  await running.stop();
  await running.stop();
  await until(() => !alive(info.pid) && !alive(info.worker));
  await assert.rejects(fetch(running.url));
});

test('startup rejects a different backend revision and cancels its polling and process', async t => {
  const { root, installation } = await setup(t);
  await assert.rejects(startBackend(installation, root, 'b'.repeat(40), AbortSignal.timeout(600)), /abort|timeout/i);
});

test('early process failure reports stderr promptly instead of waiting for readiness timeout', async t => {
  const { root, installation } = await setup(t, 'console.error("fixture bootstrap failure"); process.exit(9);');
  const started = Date.now();
  await assert.rejects(startBackend(installation, root, version, new AbortController().signal), /fixture bootstrap failure/);
  assert.ok(Date.now() - started < 5000);
});

test('the supervisor preserves the backend restart exit code', async t => {
  const { root, installation } = await setup(t);
  const running = await startBackend(installation, root, version, new AbortController().signal);
  t.after(() => running.stop());
  const info = await (await fetch(running.url)).json();
  await fetch(`${running.url}/exit75`);
  assert.equal((await running.exited).code, 75);
  await until(() => !alive(info.worker));
});

test('an Electron-equivalent parent crash disconnects the lease and removes backend descendants', async t => {
  const { root, installation } = await setup(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const parentEntry = join(root, 'parent.cjs');
  const hostEntry = require.resolve('../dist/backend/host');
  await writeFile(parentEntry, `
    const { fork } = require('node:child_process');
    fork(${JSON.stringify(hostEntry)}, [${JSON.stringify(installation.entry)}, ${JSON.stringify(root)}], {
      execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELEVENEX_PROXY_PORT: '${port}', ELEVENEX_BIND_HOST: '127.0.0.1' },
    });
  `);
  const parent = fork(parentEntry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => parent.kill('SIGKILL'));
  const url = `http://127.0.0.1:${port}`;
  let info;
  await until(async () => {
    try { info = await (await fetch(url)).json(); return true; }
    catch { return false; }
  });
  parent.kill('SIGKILL');
  await until(() => !alive(info.pid) && !alive(info.worker));
});
