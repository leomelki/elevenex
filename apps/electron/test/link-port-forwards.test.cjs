const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { it } = require('node:test');
const ws = require('../link-ws.cjs');
const { createLinkManager } = require('../link-manager.cjs');
const { createMuxSession, encodeFrame, FRAME, FLAG } = require('../link-mux.cjs');
const { createPortForwards } = require('../link-port-forwards.cjs');
const { serveStreams } = require('../link-forward.cjs');
const { createRelayServer } = require('../../relay/server.cjs');

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  await new Promise(resolve => server.close(resolve));
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
function request(port, url = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: url }, res => {
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}
async function until(predicate) {
  const deadline = Date.now() + 12000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function pair(t, transport = 'relay') {
  const backend = http.createServer((_req, res) => res.end('backend'));
  const backendPort = await listen(backend);
  t.after(() => close(backend));
  const root = await mkdtemp(path.join(os.tmpdir(), 'elevenex-ports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = createLinkManager({ userDataPath: path.join(root, 'host'), getLocalBackendPort: () => backendPort });
  const client = createLinkManager({ userDataPath: path.join(root, 'client'), getLocalBackendPort: () => 1 });
  let sharing;
  if (transport === 'relay') {
    const relay = createRelayServer({ host: '127.0.0.1', port: 0, quiet: true });
    const port = await relay.listen();
    t.after(() => relay.close());
    sharing = { transport, relayUrl: `ws://127.0.0.1:${port}/link` };
  } else {
    sharing = { transport, directPort: await freePort() };
  }
  t.after(async () => { await client.stopAll(); await host.stopAll(); });
  await host.enableSharing(sharing);
  const device = client.addLink({ code: host.getSharingCode() });
  const connection = await client.connect(device.id);
  return { client, host, device, connection, sharing };
}

for (const transport of ['relay', 'direct']) {
  it(`forwards independent HTTP services and bulk data over ${transport}, leaving the backend intact`, async t => {
    const { client, device, connection } = await pair(t, transport);
    const service = http.createServer((req, res) => res.end(req.url === '/bulk' ? Buffer.alloc(3 * 1024 * 1024, 7) : 'dev server'));
    ws.attachServer(service, { path: '/updates', onConnection: channel => {
      channel.on('message', data => channel.send(data));
    } });
    const remotePort = await listen(service);
    t.after(() => close(service));
    const localPort = await freePort();
    const payload = { id: 101, localPort, remoteHost: 'localhost', remotePort };
    const starts = await Promise.all([client.startForward(device.id, payload), client.startForward(device.id, payload)]);
    assert.ok(starts.every(state => state.status === 'active'));
    assert.ok(starts.every(state => state.running));
    const results = await Promise.all([request(localPort), request(localPort, '/bulk'), request(connection.localPort)]);
    assert.equal(results[0].toString(), 'dev server');
    assert.deepEqual(results[1], Buffer.alloc(3 * 1024 * 1024, 7));
    assert.equal(results[2].toString(), 'backend');
    const updates = await ws.connect(`ws://127.0.0.1:${localPort}/updates`);
    const echoed = once(updates, 'message');
    updates.send(Buffer.from('live reload'));
    assert.equal((await echoed)[0].toString(), 'live reload');
    updates.close();
    await client.stopForward(device.id, 101);
    assert.equal(client.getForwardState(device.id, 101).status, 'inactive');
    assert.equal(client.getForwardState(device.id, 101).running, false);
    await assert.rejects(request(localPort));
    assert.equal((await request(connection.localPort)).toString(), 'backend');
  });
}

it('keeps the same local port across outages and frees it on disconnect', async t => {
  const { client, host, device, sharing } = await pair(t);
  const remote = http.createServer((_req, res) => res.end('resumed'));
  const remotePort = await listen(remote);
  t.after(() => close(remote));
  const localPort = await freePort();
  await client.startForward(device.id, { id: 102, localPort, remoteHost: 'localhost', remotePort });
  await host.disableSharing();
  await until(() => client.getForwardState(device.id, 102).status === 'connecting');
  assert.equal(client.getForwardState(device.id, 102).running, true);
  await assert.rejects(request(localPort));
  await host.enableSharing(sharing);
  await until(() => client.getLinkState(device.id).status === 'connected');
  assert.equal((await request(localPort)).toString(), 'resumed');
  assert.equal(client.getForwardState(device.id, 102).status, 'active');
  await client.disconnect(device.id);
  const replacement = net.createServer();
  replacement.listen(localPort, '127.0.0.1');
  await once(replacement, 'listening');
  await close(replacement);
});

it('reports occupied local ports and unreachable services, then recovers when the service starts', async t => {
  const { client, device } = await pair(t);
  const occupied = net.createServer();
  const localPort = await listen(occupied);
  const remotePort = await freePort();
  await assert.rejects(client.startForward(device.id, { id: 103, localPort, remotePort }), /already in use/);
  assert.equal(client.getForwardState(device.id, 103).running, false);
  await close(occupied);
  await client.startForward(device.id, { id: 103, localPort, remotePort });
  await assert.rejects(request(localPort));
  await until(() => client.getForwardState(device.id, 103).status === 'error');
  assert.match(client.getForwardState(device.id, 103).lastError, /Check that the service is running/);
  assert.equal(client.getForwardState(device.id, 103).running, true);
  const restarted = await client.startForward(device.id, { id: 103, localPort, remotePort });
  assert.equal(restarted.status, 'error');
  assert.match(restarted.lastError, /Check that the service is running/);
  await client.stopForward(device.id, 103);
  assert.equal(client.getForwardState(device.id, 103).running, false);
  // A forward with a failed connection must still stop and release its port.
  occupied.listen(localPort, '127.0.0.1');
  await once(occupied, 'listening');
  await close(occupied);
  await client.startForward(device.id, { id: 103, localPort, remotePort });
  const service = http.createServer((_req, res) => res.end('now running'));
  service.listen(remotePort, '127.0.0.1');
  await once(service, 'listening');
  t.after(() => close(service));
  assert.equal((await request(localPort)).toString(), 'now running');
  assert.equal(client.getForwardState(device.id, 103).status, 'active');
});

it('supports IPv6-only localhost services and server-first TCP protocols with half-close', async t => {
  const { client, device } = await pair(t);
  const service = net.createServer({ allowHalfOpen: true }, socket => {
    socket.write('greeting:');
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.end('done'));
  });
  let remotePort;
  try { remotePort = await listen(service, '::1'); }
  catch (error) { if (error.code === 'EAFNOSUPPORT') { t.skip('IPv6 unavailable'); return; } throw error; }
  t.after(() => close(service));
  const localPort = await freePort();
  await client.startForward(device.id, { id: 104, localPort, remotePort });
  const socket = net.connect({ host: '127.0.0.1', port: localPort, allowHalfOpen: true });
  t.after(() => socket.destroy());
  const [greeting] = await once(socket, 'data');
  assert.equal(greeting.toString(), 'greeting:');
  const received = [];
  socket.on('data', data => received.push(data));
  socket.end('request:');
  await once(socket, 'end');
  assert.equal(Buffer.concat(received).toString(), 'request:done');
});

it('stop closes held connections, and stop racing a start leaves no listener', async t => {
  const { client, device } = await pair(t);
  const sockets = new Set();
  const service = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const remotePort = await listen(service);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await close(service); });
  const localPort = await freePort();
  const payload = { id: 105, localPort, remotePort };
  await Promise.all([client.startForward(device.id, payload), client.stopForward(device.id, 105)]);
  await assert.rejects(request(localPort));
  await client.startForward(device.id, payload);
  const socket = net.connect(localPort, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  await client.stopForward(device.id, 105);
  await closed;
});

function sessions(t) {
  const left = new EventEmitter();
  const right = new EventEmitter();
  left.send = data => setImmediate(() => right.emit('message', data, true));
  right.send = data => setImmediate(() => left.emit('message', data, true));
  left.close = right.close = () => {};
  const client = createMuxSession(left, { isInitiator: true });
  const host = createMuxSession(right, { isInitiator: false });
  t.after(() => { client.close(); host.close(); });
  return { client, host, left };
}

it('fails capability negotiation with older desktops without sending target or application bytes', async t => {
  const { client, host } = sessions(t);
  let accepted = 0;
  host.on('stream', () => accepted++);
  await assert.rejects(client.requirePortForwarding({ timeoutMs: 25 }), /Update Elevenex/);
  assert.throws(() => client.open({ host: 'localhost', port: 3000 }), /unavailable/);
  assert.equal(accepted, 0);
  assert.equal(client.listenerCount('signal'), 0);
});

it('retries a query that arrives before the sharing side is ready', async t => {
  const { client, host } = sessions(t);
  const supported = client.requirePortForwarding({ timeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  serveStreams(host, { targetPort: 1 });
  await supported;
  assert.equal(client.portForwardingSupported, true);
  assert.equal(client.listenerCount('signal'), 0);
});

it('rejects malformed target frames without opening backend streams', async t => {
  const { client, host, left } = sessions(t);
  serveStreams(host, { targetPort: 1 });
  let accepted = 0;
  host.on('stream', () => accepted++);
  for (const target of [{ host: 'localhost', port: 0 }, { host: 'localhost', port: 65536 }, { host: 'bad\nhost', port: 22 }, null]) {
    left.send(encodeFrame(FRAME.OPEN, FLAG.SYN, 333, 0, Buffer.from(JSON.stringify(target))));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(accepted, 0);
  assert.ok(client.isOpen());
});

it('rejects invalid configuration and stops a pending start when disconnected', async t => {
  const { client } = sessions(t);
  const forwards = createPortForwards({ getSession: () => client, getStatus: () => 'connected' });
  const payload = { id: 106, localPort: 3000, remotePort: 3000 };
  for (const change of [{ localPort: 0 }, { localPort: 65536 }, { remotePort: 1.5 }, { bindAddress: '0.0.0.0' }, { remoteHost: 'bad host' }]) {
    assert.throws(() => forwards.start({ ...payload, ...change }));
  }
  const started = forwards.start(payload);
  const stopped = forwards.close();
  await assert.rejects(started, /disconnected/);
  await stopped;
  assert.equal(forwards.getState(106).status, 'inactive');
});
