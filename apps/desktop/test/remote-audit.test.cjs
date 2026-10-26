const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { createServer: tcpServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { RemoteManager } = require('../dist/remote/manager');
const { backendRelease } = require('../dist/backend/release');

const version = 'a'.repeat(40);
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
const host = { name: 'Development', host: 'dev-alias' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(work, predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = work(); if (predicate(value)) return value; await delay(10); }
  assert.fail('Remote condition did not become true');
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ex-remote-'));
  const server = createServer((_req, res) => res.end(JSON.stringify({ backendSha: version })));
  const port = await listen(server);
  let starts = 0; let stops = 0; let health = true;
  const transports = [];
  const connector = async options => {
    starts++;
    options.progress('discovery'); options.progress('runtime');
    const exited = deferred();
    const transport = { instance: 'instance-1', exited: exited.promise,
      health: async () => ({ ready: health, instance: 'instance-1' }),
      forward: async (remotePort, localPort) => {
        if (remotePort === 0) return { port, reachable: true, close: async () => undefined };
        const listener = tcpServer(socket => socket.end());
        const bound = await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(localPort, '127.0.0.1', () => resolve(listener.address().port)); });
        return { port: bound, reachable: true, close: async () => new Promise(resolve => listener.close(resolve)) };
      },
      close: async () => { stops++; exited.resolve(); },
    };
    transports.push(transport); return transport;
  };
  const options = { root, settingsPath: join(root, 'settings.json'), helper: '', release: async () => release,
    connect: connector, healthInterval: 20, backoff: 5, random: () => 0.5, ...overrides };
  const manager = new RemoteManager(options); await manager.load(); manager.attach(1); manager.attach(2);
  const savedHost = await manager.saveHost(host, null);
  const remote = { kind: 'remote', hostId: savedHost.id };
  t.after(async () => { await manager.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { manager, remote, root, options, transports, starts: () => starts, stops: () => stops, setHealth: value => { health = value; } };
}
const ready = (manager, window = 1) => until(() => manager.snapshot(window), value => value.connection?.phase === 'ready');

for (const pause of [false, true]) test(`${pause ? 'pause' : 'disconnect'} publishes window state before slow forward cleanup`, async t => {
  const { manager, remote, transports, starts } = await setup(t);
  await manager.select(1, remote); await manager.select(2, remote); await ready(manager);
  const closing = deferred(); const finish = deferred(); t.after(() => finish.resolve());
  const forward = transports[0].forward;
  transports[0].forward = async (...args) => {
    const running = await forward(...args);
    return { ...running, close: async () => { closing.resolve(); await finish.promise; await running.close(); } };
  };
  await manager.addForward(1, { remotePort: 8000, localPort: 0, label: 'service' });
  await until(() => manager.snapshot(1).forwards[0], value => value?.phase === 'listening');
  const events = []; const unsubscribe = manager.subscribe((id, snapshot) => { if (id === 1) events.push(snapshot); }); t.after(unsubscribe);
  const disconnecting = manager.disconnect(1, pause); await closing.promise;
  const snapshot = events.at(-1);
  assert.equal(snapshot.connection.phase, pause ? 'paused' : 'disconnected');
  assert.equal(snapshot.connection.authenticated, false);
  assert.equal(snapshot.connection.transport, 'closed');
  assert.equal(snapshot.connection.application, 'unknown');
  assert.equal(snapshot.connection.failure, null);
  assert.equal(snapshot.connection.retryAt, null);
  assert.equal(snapshot.connection.progress, null);
  assert.equal(snapshot.forwards[0].phase, 'stopped');
  assert.equal(snapshot.forwards[0].boundPort, null);
  assert.equal(manager.backendAccess(1), null);
  assert.equal(manager.snapshot(2).connection.phase, 'ready');
  assert.equal(starts(), 1);
  finish.resolve(); await disconnecting;
});

test('a delayed environment switch cannot release a newly reacquired connection lease', async t => {
  const { manager, remote, transports } = await setup(t);
  await manager.select(1, remote); await manager.select(2, remote); await ready(manager);
  const closing = deferred(); const finish = deferred();
  const forward = transports[0].forward;
  transports[0].forward = async (...args) => {
    const running = await forward(...args);
    return { ...running, close: async () => { closing.resolve(); await finish.promise; await running.close(); } };
  };
  t.after(() => finish.resolve());
  await manager.addForward(1, { remotePort: 8000, localPort: 0, label: 'delayed close' });
  await until(() => manager.snapshot(1).forwards[0], value => value?.phase === 'listening');
  const selectingLocal = manager.select(1, { kind: 'local' }); await closing.promise;
  await manager.select(1, remote); await ready(manager);
  finish.resolve(); await selectingLocal;
  await manager.disconnect(2);
  assert.equal(manager.snapshot(1).connection.phase, 'ready');
});

test('editing a disconnected host cannot lose a concurrent connect lease', async t => {
  const { manager, remote } = await setup(t);
  await manager.select(1, remote); await ready(manager); await manager.disconnect(1);
  await Promise.all([manager.saveHost({ ...host, name: 'Edited' }, remote.hostId), manager.select(1, remote)]);
  await ready(manager);
  await manager.disconnect(1);
  assert.equal(manager.snapshot(1).connection.phase, 'disconnected');
});

test('host edits and removal reject a pending selection before it has acquired a connection', async t => {
  const { manager, remote } = await setup(t);
  const selecting = manager.select(1, remote);
  await assert.rejects(manager.saveHost({ ...host, name: 'Must not replace' }, remote.hostId), /Disconnect/);
  await assert.rejects(manager.removeHost(remote.hostId), /Disconnect/);
  await selecting; await ready(manager);
  assert.equal(manager.hosts()[0].name, host.name);
});

test('application disposal cancels a selection waiting to persist without starting SSH', async t => {
  const { manager, remote, starts } = await setup(t);
  const selecting = manager.select(1, remote);
  const rejected = assert.rejects(selecting, /shutting down/);
  await manager.dispose(); await rejected;
  assert.equal(starts(), 0);
});

test('a host edit retiring an old connection cannot delete or dispose its replacement', async t => {
  const { manager, remote, transports } = await setup(t);
  await manager.select(1, remote); await ready(manager);
  const closing = deferred(); const finish = deferred();
  const close = transports[0].close;
  transports[0].close = async () => { closing.resolve(); await finish.promise; await close(); };
  t.after(() => finish.resolve());
  const disconnecting = manager.disconnect(1); await closing.promise;
  const editing = manager.saveHost({ ...host, host: 'replacement-alias' }, remote.hostId);
  await manager.select(1, remote); await ready(manager);
  finish.resolve(); await Promise.all([disconnecting, editing]);
  assert.equal(manager.snapshot(1).connection.phase, 'ready');
  assert.equal(manager.hosts()[0].host, 'replacement-alias');
  await manager.disconnect(1);
});

test('application shutdown waits for connection cleanup detached by a host edit', async t => {
  const finish = deferred(); t.after(() => finish.resolve());
  const { manager, remote, transports } = await setup(t);
  await manager.select(1, remote); await ready(manager);
  const closing = deferred(); const close = transports[0].close;
  transports[0].close = async () => { closing.resolve(); await finish.promise; await close(); };
  const disconnecting = manager.disconnect(1); await closing.promise;
  const editing = manager.saveHost({ ...host, name: 'Updated' }, remote.hostId);
  let stopped = false; const stopping = manager.dispose().then(() => { stopped = true; });
  await delay(20); assert.equal(stopped, false);
  finish.resolve();
  // A concurrent IPC response can no longer snapshot the closed window.
  await Promise.allSettled([disconnecting, editing]); await stopping;
  assert.equal(stopped, true);
});

test('a failed selection save releases its existing connection lease', async t => {
  const { manager, remote, root, stops } = await setup(t);
  await manager.select(1, remote); await ready(manager);
  const path = join(root, 'settings.json'); await rm(path); await mkdir(path);
  try {
    await assert.rejects(manager.select(1, remote));
    assert.equal(manager.snapshot(1).connection.phase, 'disconnected');
    assert.equal(stops(), 1);
  } finally { await rm(path, { recursive: true, force: true }); }
});


test('Home editing keeps appearance changes live, reconnects destination changes, and removal/Undo preserve identity and order', async t => {
  const { manager, remote, starts } = await setup(t);
  const original = manager.hosts()[0];
  await manager.saveHost({ name: 'Second', host: 'second' }, null);
  await manager.select(1, remote); await manager.select(2, remote); await ready(manager);
  const generation = manager.snapshot(1).connection.generation;
  await manager.editMachineHost(1, { name: 'Renamed', host: original.host, hue: 'rose' }, original.id);
  assert.equal(starts(), 1); assert.equal(manager.snapshot(1).connection.generation, generation);
  assert.equal(manager.hosts()[0].hue, 'rose');
  await manager.editMachineHost(1, { name: 'Moved', host: 'staging', user: 'leo', port: 2222, hue: 'plum' }, original.id);
  await ready(manager, 1); await ready(manager, 2);
  assert.equal(starts(), 2); assert.equal(manager.hosts()[0].host, 'staging');
  await assert.rejects(manager.removeMachineHost(original.id, false), /Confirm/);
  assert.equal(manager.hosts().length, 2);
  const removal = await manager.removeMachineHost(original.id, true);
  assert.equal(manager.hosts().length, 1);
  for (const id of [1, 2]) { assert.deepEqual(manager.snapshot(id).selection, { kind: 'local' }); assert.equal(manager.snapshot(id).challenge, null); }
  await manager.restoreMachineHost(removal.host, removal.index);
  assert.equal(manager.hosts()[0].id, original.id); assert.equal(manager.hosts()[0].hue, 'plum'); assert.equal(starts(), 2);
  await assert.rejects(manager.restoreMachineHost(removal.host, removal.index), /cannot be restored/);
});
