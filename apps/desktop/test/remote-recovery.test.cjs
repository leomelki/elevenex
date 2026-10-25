const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { RemoteConnection } = require('../dist/remote/connection');
const { RemoteSettingsStore, emptyWindow, emptyContext } = require('../dist/remote/store');
const { backendRelease } = require('../dist/backend/release');
const { failure } = require('../dist/remote/failure');
const { queryDaemon, publishDaemon, verifyHealthRequest, healthResponseProof } = require('../dist/remote/runtime-control');
const { RemoteArchiveCache } = require('../dist/remote/archives');
const { getEventListeners } = require('node:events');
const { ForwardedAgentProxy } = require('../dist/remote/agent-proxy');
const { RemoteManager } = require('../dist/remote/manager');
const { createServer: createSocketServer, connect: connectSocket } = require('node:net');
const version = 'a'.repeat(40);
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await delay(10); }
  assert.fail('Recovery condition did not become true');
}

test('Retry now during background authentication promotes exactly one interactive attempt', async t => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ backendSha: version })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const firstAttempt = deferred(); const prompts = []; const attempts = [];
  let active = 0; let maximumActive = 0;
  const connection = new RemoteConnection({ root: '', helper: '', host: { id: 'test', name: 'test', host: 'test', forwardAgent: false }, release: async () => release,
    changed: () => undefined, healthInterval: 10000,
    connect: async options => {
      active++; maximumActive = Math.max(maximumActive, active); attempts.push(options.interactive);
      try {
        if (!options.interactive) { await firstAttempt.promise; throw failure('authentication', 'authentication', 'Unlock the key.', 'authenticate'); }
        const challenge = { id: 'challenge', kind: 'credential', prompt: 'Password:', expiresAt: Date.now() + 10000 };
        prompts.push(challenge); assert.equal(await options.ask(challenge, options.signal), 'fixture-password');
        const exit = deferred();
        return { instance: 'same-runtime', exited: exit.promise, health: async () => ({ ready: true, instance: 'same-runtime' }),
          forward: async () => ({ port: server.address().port, reachable: true, authorization: null, close: async () => undefined }), close: async () => exit.resolve() };
      } finally { active--; }
    },
  });
  t.after(async () => { await connection.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  connection.acquire(1, false); await until(() => attempts.length === 1);
  connection.retry(1); connection.retry(1); firstAttempt.resolve(); await until(() => connection.challengeFor(1) !== null);
  connection.answer(1, 'challenge', 'fixture-password'); await until(() => connection.snapshot().phase === 'ready');
  assert.deepEqual(attempts, [false, true]); assert.equal(prompts.length, 1); assert.equal(maximumActive, 1);
  await connection.dispose(); assert.throws(() => connection.acquire(2, true), /disposed/);
});

test('draft bursts retain one pending snapshot and persist the latest complete state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-draft-burst-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RemoteSettingsStore(join(root, 'settings.json')); const window = emptyWindow(); const settings = { hosts: [], windows: [window] }; const promises = [];
  for (let index = 0; index < 1000; index++) {
    window.contexts.local = { ...emptyContext(), draft: `${index}: ${'draft'.repeat(1000)}` }; promises.push(store.save(settings));
  }
  assert.equal(new Set(promises).size, 1, 'a typing burst must coalesce rather than queue 1000 snapshots'); await Promise.all(promises);
  assert.equal((await store.load()).windows[0].contexts.local.draft, window.contexts.local.draft);
});

test('daemon discovery uses an available TCP port and never discloses its token to a stale endpoint', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-control-proof-')); const token = 'b'.repeat(64); const instance = 'fixture-instance';
  const received = [];
  const stale = createServer((req, res) => { received.push(req.headers); res.end(JSON.stringify({ version, instance, ready: true })); });
  const real = createServer((req, res) => {
    const nonce = verifyHealthRequest(req, token); if (nonce === null) return res.writeHead(403).end();
    const body = JSON.stringify({ version, instance, ready: true }); res.setHeader('X-Elevenex-Proof', healthResponseProof(token, nonce, body)); res.end(body);
  });
  t.after(async () => { stale.closeAllConnections(); real.closeAllConnections(); await Promise.all([new Promise(resolve => stale.close(resolve)), new Promise(resolve => real.close(resolve))]); await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => stale.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => real.listen(0, '127.0.0.1', resolve));
  await assert.rejects(queryDaemon(root, stale.address().port, token), /identity/);
  assert.equal(received[0].authorization, undefined); assert.equal(JSON.stringify(received).includes(token), false);
  await publishDaemon(root, real.address().port, instance);
  assert.deepEqual(await queryDaemon(root, stale.address().port, token), { version, instance, ready: true });
});

test('hosts share one archive preparation, and cancelling a window leaves other hosts running', async t => {
  const entered = deferred(); const finish = deferred(); let calls = 0; let workerSignal; let report;
  const archive = { path: 'verified.tar.gz', digest: 'c'.repeat(64), bytes: 12 };
  const cache = new RemoteArchiveCache('/unused', async (_root, _release, signal, progress) => { calls++; workerSignal = signal; report = progress; entered.resolve(); await finish.promise; return archive; });
  t.after(() => cache.dispose());
  const first = new AbortController(); const second = new AbortController(); const updates = [];
  const one = cache.prepare(release, first.signal, () => undefined); const cancelled = assert.rejects(one, /abort/i);
  const two = cache.prepare(release, second.signal, value => updates.push(value));
  await entered.promise; first.abort(); await cancelled; assert.equal(workerSignal.aborted, false);
  report({ receivedBytes: 6, totalBytes: 12 }); finish.resolve(); assert.deepEqual(await two, archive);
  assert.equal(calls, 1); assert.deepEqual(updates, [{ receivedBytes: 6, totalBytes: 12 }]);
  assert.equal(getEventListeners(first.signal, 'abort').length, 0); assert.equal(getEventListeners(second.signal, 'abort').length, 0);
});

test('archive work aborts after its last owner and a new owner can retry after cleanup', async t => {
  const entered = deferred(); let calls = 0;
  const cache = new RemoteArchiveCache('/unused', async (_root, _release, signal) => {
    calls++; if (calls === 1) { entered.resolve(); await delay(30000, undefined, { signal }); }
    return { path: 'complete', digest: 'd'.repeat(64), bytes: 1 };
  }); t.after(() => cache.dispose());
  const owner = new AbortController(); const first = cache.prepare(release, owner.signal, () => undefined); const cancelled = assert.rejects(first, /abort/i);
  await entered.promise; owner.abort();
  const second = cache.prepare(release, new AbortController().signal, () => undefined); await cancelled;
  assert.equal((await second).path, 'complete'); assert.equal(calls, 2);
  await cache.dispose(); await assert.rejects(cache.prepare(release, new AbortController().signal, () => undefined), /shutting down/);
});

test('a dead forwarded-agent lease falls back before consuming bytes and revocation affects only its lease', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote agent socket');
  const root = await mkdtemp('/tmp/ex-agent-proxy-'); let now = Date.now();
  const realPath = join(root, 'real.sock'); const proxyPath = join(root, 'proxy.sock');
  const clients = new Set(); const real = createSocketServer(socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => real.listen(realPath, resolve)); const proxy = new ForwardedAgentProxy(proxyPath, () => now); await proxy.listen();
  t.after(async () => { await proxy.dispose(); for (const socket of clients) socket.destroy(); await new Promise(resolve => real.close(resolve)); await rm(root, { recursive: true, force: true }); });
  proxy.renew('working', realPath); now++; proxy.renew('dead', join(root, 'missing.sock'));
  const socket = connectSocket(proxyPath); socket.on('error', () => undefined);
  const reply = new Promise(resolve => socket.once('data', resolve)); socket.write('one-sign-request'); assert.equal(String(await reply), 'one-sign-request');
  proxy.renew('dead', null);
  const again = new Promise(resolve => socket.once('data', resolve)); socket.write('second-request'); assert.equal(String(await again), 'second-request');
  const closed = new Promise(resolve => socket.once('close', resolve)); proxy.renew('working', null); await closed;
});

test('a draft from an old environment is rejected without replacing the current input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-context-scope-'));
  const manager = new RemoteManager({ root, settingsPath: join(root, 'settings.json'), helper: '', release: async () => release,
    connect: async () => { throw failure('authentication', 'authentication', 'Fixture key is locked.', 'authenticate'); } });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  await manager.load(); manager.attach(1); const host = await manager.saveHost({ name: 'test', host: 'test', forwardAgent: false }, null);
  const remote = { kind: 'remote', hostId: host.id }; const local = { kind: 'local' };
  await manager.select(1, remote); await manager.saveContext(1, { ...emptyContext(), draft: 'remote input' }, remote);
  await manager.select(1, local); await manager.saveContext(1, { ...emptyContext(), draft: 'local input' }, local);
  await assert.rejects(manager.saveContext(1, { ...emptyContext(), draft: 'stale remote reply' }, remote), /stale context/);
  assert.equal(manager.snapshot(1).context.draft, 'local input'); await manager.select(1, remote); assert.equal(manager.snapshot(1).context.draft, 'remote input');
});

test('host progress and draft updates notify only windows in their scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-event-scope-')); const attempts = new Map();
  const manager = new RemoteManager({ root, settingsPath: join(root, 'settings.json'), helper: '', release: async () => release,
    connect: async options => { attempts.set(options.host.id, options); await delay(30000, undefined, { signal: options.signal }); throw new Error('Fixture connection unexpectedly completed'); } });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  await manager.load(); manager.attach(1); manager.attach(2); manager.attach(3);
  const first = await manager.saveHost({ name: 'one', host: 'one', forwardAgent: false }, null);
  const second = await manager.saveHost({ name: 'two', host: 'two', forwardAgent: false }, null);
  await manager.select(1, { kind: 'remote', hostId: first.id });
  await manager.select(2, { kind: 'remote', hostId: second.id });
  await until(() => attempts.size === 2);
  const notified = []; const unsubscribe = manager.subscribe(windowId => notified.push(windowId)); t.after(unsubscribe);
  attempts.get(first.id).progress('download', { receivedBytes: 1, totalBytes: 2 });
  assert.deepEqual(notified, [1]); notified.length = 0;
  await manager.saveContext(3, { ...emptyContext(), draft: 'local input' }, { kind: 'local' });
  assert.deepEqual(notified, [3]);
});
