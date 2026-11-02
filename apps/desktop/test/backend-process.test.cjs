const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtemp, writeFile, readFile, mkdir, rm } = require('node:fs/promises');
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

test('startup failure retains bounded output from both pipes without terminal escapes', async t => {
  const { root, installation } = await setup(t, `
    process.stdout.write('startup progress'.repeat(1000));
    process.stderr.write('warning'.repeat(2000));
    process.stdout.write('\\n\\x1b[31mstdout bootstrap failure\\x1b[0m\\n');
    process.stderr.write('\\nstderr bootstrap failure\\n');
    process.exitCode = 9;
  `);
  await assert.rejects(startBackend(installation, root, version, new AbortController().signal), error => {
    assert.match(error.message, /Backend stopped during startup \(9\)/);
    assert.match(error.message, /stdout bootstrap failure/);
    assert.match(error.message, /stderr bootstrap failure/);
    assert.equal(error.message.includes('\u001b'), false);
    assert.ok(error.message.length < 11_000);
    return true;
  });
});

test('startup failure explains when the backend produced no diagnostics', async t => {
  const { root, installation } = await setup(t, 'process.exit(9);');
  await assert.rejects(startBackend(installation, root, version, new AbortController().signal), /without diagnostic output/);
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

test('a remote supervisor starts only after acquiring its kernel lock and holds it through cleanup', async t => {
  const { root, installation } = await setup(t, 'setInterval(() => {}, 1000);');
  const supervisor = require.resolve('../dist/backend/host');
  const abandoned = fork(supervisor, [installation.entry, root, '--ownership'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let spawned = false; abandoned.on('message', () => { spawned = true; });
  const abandonedExit = new Promise(resolve => abandoned.once('exit', resolve)); abandoned.disconnect(); await abandonedExit;
  assert.equal(spawned, false);

  const marker = join(root, 'started');
  await writeFile(installation.entry, `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`);
  const host = fork(supervisor, [installation.entry, root, '--ownership'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exit = new Promise(resolve => host.once('exit', resolve));
  t.after(() => host.kill('SIGTERM'));
  const lock = createServer(); await new Promise(resolve => lock.listen(0, '127.0.0.1', resolve)); const port = lock.address().port;
  const acquired = new Promise(resolve => host.once('message', resolve));
  host.send({ type: 'ownership' }, lock, { keepOpen: true }); await acquired;
  await until(async () => { try { return await readFile(marker, 'utf8') === 'started'; } catch { return false; } });
  await new Promise(resolve => lock.close(resolve));
  const conflict = createServer();
  assert.equal((await new Promise(resolve => { conflict.once('error', resolve); conflict.listen(port, '127.0.0.1'); })).code, 'EADDRINUSE');
  host.disconnect(); await exit;
  const replacement = createServer(); await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => replacement.close(resolve));
});
