const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { createServer: tcpServer, connect } = require('node:net');
const { TerminalForwards, preferredTerminalPort } = require('../dist/remote/terminal-forwards');

const service = { hostId: 'server-a', targetHost: '127.0.0.1', remotePort: 4200 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const occupied = () => Object.assign(new Error('Occupied'), { code: 'EADDRINUSE' });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ex-terminal-ports-')), path = join(root, 'forwards.json');
  const registries = [];
  t.after(async () => { await Promise.all(registries.map(registry => registry.dispose())); await rm(root, { recursive: true, force: true }); });
  const load = async (definitions = [], hostIds = ['server-a', 'server-b']) => {
    const registry = new TerminalForwards(path); registries.push(registry);
    await registry.load(hostIds, definitions);
    return registry;
  };
  return { path, load };
}

function transport(forward = async (_remote, port) => ({ port, reachable: true, authorization: null, close: async () => {} })) {
  return { forward };
}

test('the preferred port has a stable algorithm independent of process and connection identity', () => {
  assert.equal(preferredTerminalPort(service), 29578);
});

test('an actual HTTP forward shares a listener and survives loss of one window lease', async t => {
  const { load } = await fixture(t), registry = await load();
  const website = createServer((_req, res) => { res.setHeader('Connection', 'close'); res.end('website reached'); });
  await new Promise(resolve => website.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => website.close(resolve)));
  const endpoint = { ...service, remotePort: website.address().port };
  let starts = 0, closes = 0;
  const tunnel = transport(async (remotePort, localPort, changed, host) => {
    starts++;
    const sockets = new Set();
    const listener = tcpServer(socket => {
      const upstream = connect(remotePort, host);
      for (const stream of [socket, upstream]) { sockets.add(stream); stream.once('close', () => sockets.delete(stream)); stream.on('error', () => stream.destroy()); }
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(localPort, '127.0.0.1', resolve); });
    return { port: listener.address().port, reachable: true, authorization: null, close: async () => {
      closes++; for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve));
    } };
  });
  const first = registry.acquire(endpoint, tunnel, () => {}), second = registry.acquire(endpoint, tunnel, () => {});
  const [a, b] = await Promise.all([first.ready, second.ready]);
  assert.equal(a.port, b.port); assert.equal(starts, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${a.port}`)).text(), 'website reached');
  await first.close(); assert.equal(closes, 0);
  assert.equal(await (await fetch(`http://127.0.0.1:${a.port}`)).text(), 'website reached');
  await second.close(); assert.equal(closes, 1);
});

test('a collision is resolved once and the assignment and IPv6 destination survive relaunch', async t => {
  const { path, load } = await fixture(t), registry = await load();
  const endpoint = { ...service, targetHost: '::1' }, requests = [];
  const tunnel = transport(async (remotePort, port, _changed, host) => {
    requests.push({ remotePort, port, host });
    if (requests.length === 1) throw occupied();
    return { port, reachable: true, authorization: null, close: async () => {} };
  });
  await registry.register('forward-a', endpoint);
  const first = registry.acquire(endpoint, tunnel, () => {}), running = await first.ready;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].port, preferredTerminalPort(endpoint));
  assert.equal(running.port, 20000 + (preferredTerminalPort(endpoint) - 20000 + 1) % 10000);
  await first.close(); await registry.dispose();
  const restored = await load([{ id: 'forward-a', hostId: endpoint.hostId, remotePort: endpoint.remotePort }]);
  assert.deepEqual(restored.definition('forward-a'), { ...endpoint, forwardId: 'forward-a' });
  const second = restored.acquire(endpoint, tunnel, () => {});
  assert.equal((await second.ready).port, running.port);
  assert.deepEqual(requests.at(-1), { remotePort: 4200, port: running.port, host: '::1' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).assignments.length, 1);
});

test('an occupied persisted port reports a conflict without silently changing the URL', async t => {
  const { path, load } = await fixture(t), registry = await load();
  const first = registry.acquire(service, transport(), () => {}), port = (await first.ready).port;
  await first.close(); await registry.dispose();
  const before = await readFile(path, 'utf8'), restored = await load(), attempts = [];
  const lease = restored.acquire(service, transport(async (_remote, candidate) => { attempts.push(candidate); throw occupied(); }), () => {});
  await assert.rejects(lease.ready, { code: 'EADDRINUSE' });
  assert.deepEqual(attempts, [port]); assert.equal(await readFile(path, 'utf8'), before);
});

test('colliding service hashes allocate distinct ports even when acquired concurrently', async t => {
  const { load } = await fixture(t), registry = await load(), candidates = new Map();
  let pair;
  for (let remotePort = 1; remotePort <= 10001; remotePort++) {
    const candidate = { ...service, remotePort }, port = preferredTerminalPort(candidate);
    if (candidates.has(port)) { pair = [candidates.get(port), candidate]; break; }
    candidates.set(port, candidate);
  }
  assert.ok(pair);
  const tunnel = transport(), a = registry.acquire(pair[0], tunnel, () => {}), b = registry.acquire(pair[1], tunnel, () => {});
  const [one, two] = await Promise.all([a.ready, b.ready]);
  assert.notEqual(one.port, two.port);
  const otherServer = registry.acquire({ ...pair[0], hostId: 'server-b' }, tunnel, () => {});
  const otherPort = (await otherServer.ready).port;
  assert.notEqual(otherPort, one.port); assert.notEqual(otherPort, two.port);
});

test('initial collision probing is bounded and non-conflict failures do not probe', async t => {
  const { load } = await fixture(t), registry = await load();
  let attempts = 0;
  const unavailable = registry.acquire(service, transport(async () => { attempts++; throw occupied(); }), () => {});
  await assert.rejects(unavailable.ready, { code: 'EADDRINUSE' }); assert.equal(attempts, 64);
  await unavailable.close();
  attempts = 0;
  const denied = registry.acquire(service, transport(async () => { attempts++; throw Object.assign(new Error('Denied'), { code: 'EACCES' }); }), () => {});
  await assert.rejects(denied.ready, { code: 'EACCES' }); assert.equal(attempts, 1);
});

test('transport replacement waits for listener cleanup and reuses the saved port', async t => {
  const { load } = await fixture(t), registry = await load(), closing = deferred(), finish = deferred();
  const first = registry.acquire(service, transport(async (_remote, port) => ({ port, reachable: true, close: async () => { closing.resolve(); await finish.promise; } })), () => {});
  t.after(() => finish.resolve());
  const port = (await first.ready).port;
  let starts = 0;
  const second = registry.acquire(service, transport(async (_remote, port) => { starts++; return { port, reachable: true, close: async () => {} }; }), () => {});
  await closing.promise; assert.equal(starts, 0);
  finish.resolve(); assert.equal((await second.ready).port, port); assert.equal(starts, 1);
  await first.close();
  const third = registry.acquire(service, transport(), () => {});
  await third.ready;
});

test('closing during startup closes the late listener and never persists an unowned assignment', async t => {
  const { path, load } = await fixture(t), registry = await load(), starting = deferred(), finish = deferred();
  let closes = 0;
  const lease = registry.acquire(service, transport(async (_remote, port) => {
    starting.resolve(); await finish.promise;
    return { port, reachable: true, close: async () => { closes++; } };
  }), () => {});
  const rejected = assert.rejects(lease.ready, /cancelled/);
  await starting.promise;
  const closed = lease.close(); finish.resolve(); await closed; await rejected;
  assert.equal(closes, 1); await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('availability changes reach active leases only and are retained for new owners', async t => {
  const { load } = await fixture(t), registry = await load();
  let notify;
  const tunnel = transport(async (_remote, port, changed) => { notify = changed; return { port, reachable: true, close: async () => {} }; });
  const firstEvents = [], secondEvents = [], thirdEvents = [];
  const first = registry.acquire(service, tunnel, value => firstEvents.push(value));
  const second = registry.acquire(service, tunnel, value => secondEvents.push(value));
  await Promise.all([first.ready, second.ready]); notify(false); await first.close(); notify(true);
  const third = registry.acquire(service, tunnel, value => thirdEvents.push(value)); await third.ready;
  assert.deepEqual(firstEvents, [true, false]); assert.deepEqual(secondEvents, [true, false, true]); assert.deepEqual(thirdEvents, [true]);
});

test('an explicit retry recovers all owners of a failed listener and ignores retired callbacks', async t => {
  const { load } = await fixture(t), registry = await load(), callbacks = [], events = [];
  let attempts = 0, denied = true;
  const tunnel = transport(async (_remote, port, changed) => {
    attempts++; callbacks.push(changed);
    if (denied) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return { port, reachable: true, close: async () => {} };
  });
  const first = registry.acquire(service, tunnel, () => {}), second = registry.acquire(service, tunnel, (available, port) => events.push({ available, port }));
  await Promise.all([assert.rejects(first.ready), assert.rejects(second.ready)]);
  denied = false;
  const [a, b] = await Promise.all([first.retry(), second.retry()]);
  assert.equal(attempts, 2); assert.equal(a.port, b.port);
  assert.deepEqual(events.at(-1), { available: true, port: a.port });
  const count = events.length; callbacks[0](false); assert.equal(events.length, count);
  await first.close();
  await second.retry(); assert.equal(attempts, 3);
  callbacks[1](false); assert.equal(events.at(-1).available, true);
});

test('a failed settings write closes the listener and does not advertise an ephemeral assignment', async t => {
  const { path, load } = await fixture(t), registry = await load();
  await mkdir(path);
  let closes = 0;
  const lease = registry.acquire(service, transport(async (_remote, port) => ({ port, reachable: true, close: async () => { closes++; } })), () => {});
  await assert.rejects(lease.ready); assert.equal(closes, 1);
  await lease.close(); await rm(path, { recursive: true });
  const retry = registry.acquire(service, transport(), () => {});
  assert.equal((await retry.ready).port, preferredTerminalPort(service));
});

test('corrupt settings cannot reset assignments or authorize a non-loopback destination', async t => {
  const { path, load } = await fixture(t);
  for (const settings of [
    { version: 2, assignments: [], definitions: [] },
    { version: 1, assignments: [{ ...service, localPort: 0 }], definitions: [] },
    { version: 1, assignments: [], definitions: [{ ...service, targetHost: 'example.com', forwardId: 'forward-a' }] },
    { version: 1, assignments: [{ ...service, localPort: 24000 }, { ...service, hostId: 'server-b', localPort: 24000 }], definitions: [] },
  ]) {
    const bytes = JSON.stringify(settings); await writeFile(path, bytes);
    await assert.rejects(load(), /could not be read/); assert.equal(await readFile(path, 'utf8'), bytes);
  }
});
