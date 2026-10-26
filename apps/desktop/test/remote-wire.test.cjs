const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, connect } = require('node:net');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Wire, SocketChannels } = require('../dist/remote/wire');

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}

async function tunnel(t, serve, prefetched) {
  const toRemote = new PassThrough(); const toLocal = new PassThrough();
  const local = new Wire(toLocal, toRemote); const remote = new Wire(toRemote, toLocal);
  const localChannels = new SocketChannels(local); const remoteChannels = new SocketChannels(remote);
  const sockets = new Set();
  const service = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => undefined); serve(socket);
  });
  const remotePort = await listen(service);
  remote.on('message', frame => { if (frame.type === 'open') remoteChannels.accept(frame.id, frame.port, ''); });
  const forward = createServer({ allowHalfOpen: true }, socket => {
    if (prefetched) socket.unshift(prefetched);
    localChannels.open(socket, remotePort);
  }); const port = await listen(forward);
  const client = connect(port, '127.0.0.1'); client.on('error', () => undefined);
  t.after(async () => {
    client.destroy(); localChannels.dispose(); remoteChannels.dispose(); local.close(); remote.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => service.close(resolve)), new Promise(resolve => forward.close(resolve))]);
  });
  await once(client, 'connect');
  return { client, local, remote, toRemote, toLocal, port, sockets, localChannels, remoteChannels };
}

test('TCP half-close preserves a complete response after the request EOF', { timeout: 5000 }, async t => {
  const response = Buffer.alloc(2 * 1024 * 1024, 0xab);
  const { client } = await tunnel(t, socket => {
    socket.resume(); socket.once('end', () => socket.end(response));
  });
  const received = [];
  client.on('data', bytes => received.push(bytes));
  const closed = once(client, 'close'); client.end('request'); await closed;
  const bytes = Buffer.concat(received);
  assert.equal(bytes.length, response.length);
  assert.ok(bytes.equals(response));
});

test('a tunnel pipelines a bounded window while acknowledgements are delayed', { timeout: 5000 }, async t => {
  const { client, toRemote, toLocal, remote } = await tunnel(t, socket => socket.resume());
  const frames = []; const held = [];
  // Hold only ACKs, preserving the actual TCP open handshake. A single-frame
  // stop-and-wait transport cannot use the available bandwidth on a distant host.
  const send = remote.send.bind(remote);
  remote.send = frame => { if (frame.type === 'ack') held.push(frame); else return send(frame); };
  remote.on('message', frame => { if (frame.type === 'data') frames.push(frame); });
  const transferred = new Promise(resolve => remote.on('message', () => {
    if (frames.length >= 4) resolve();
  }));
  client.write(Buffer.alloc(2 * 1024 * 1024, 0xee));
  await transferred;
  await delay(30);
  assert.equal(frames.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'base64'), 0), 512 * 1024, 'the unacknowledged byte window is bounded');
  assert.ok(frames.every(frame => Buffer.byteLength(frame.data, 'base64') <= 65536));
  assert.ok(toRemote.writableLength <= 4 * 1024 * 1024);
  assert.ok(toLocal.writableLength <= 4 * 1024 * 1024);
  for (const ack of held) send(ack);
});

test('large prefetched socket chunks are split without truncation', { timeout: 5000 }, async t => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x73);
  const { client, remote } = await tunnel(t, socket => socket.pipe(socket), bytes);
  let largest = 0;
  remote.on('message', frame => { if (frame.type === 'data') largest = Math.max(largest, Buffer.byteLength(frame.data, 'base64')); });
  const chunks = []; let received = 0;
  await new Promise(resolve => client.on('data', chunk => {
    chunks.push(chunk); received += chunk.length; if (received === bytes.length) resolve();
  }));
  assert.ok(Buffer.concat(chunks).equals(bytes)); assert.ok(largest <= 65536);
});

test('a blocked shared transport bounds queued output and resumes all data after drain', { timeout: 5000 }, async t => {
  const { client, local, remote, toRemote } = await tunnel(t, socket => socket.pipe(socket));
  await new Promise(resolve => local.on('message', frame => { if (frame.type === 'opened') resolve(); }));
  let closed = false; local.once('closed', () => { closed = true; });
  toRemote.pause();
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x2f); let received = 0;
  const finished = new Promise(resolve => client.on('data', chunk => { received += chunk.length; if (received === bytes.length) resolve(); }));
  client.write(bytes); await delay(50);
  assert.ok(toRemote.writableLength <= 96 * 1024, 'backpressure stops adding data after a bounded frame');
  assert.equal(closed, false);
  toRemote.resume(); await finished;
  assert.equal(received, bytes.length); assert.ok(remote.listenerCount('message') > 0);
});

test('latency uses a byte window instead of one round trip per frame', { timeout: 5000 }, async t => {
  const { client, remote } = await tunnel(t, socket => socket.resume());
  const timers = new Set(); t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const send = remote.send.bind(remote);
  remote.send = frame => {
    if (frame.type !== 'ack') return send(frame);
    const timer = setTimeout(() => { timers.delete(timer); send(frame); }, 40); timers.add(timer);
  };
  const size = 4 * 1024 * 1024; let received = 0;
  const finished = new Promise(resolve => remote.on('message', frame => {
    if (frame.type === 'data') { received += Buffer.byteLength(frame.data, 'base64'); if (received === size) resolve(); }
  }));
  const start = performance.now(); client.write(Buffer.alloc(size)); await finished;
  t.diagnostic(`4 MiB with 40 ms ACK delay: ${Math.round(performance.now() - start)} ms (fixture, not WAN throughput).`);
  assert.equal(received, size);
});

test('channel saturation closes only the extra client and disposal releases every socket', { timeout: 5000 }, async t => {
  const { client, port, sockets, localChannels, remoteChannels } = await tunnel(t, socket => socket.pipe(socket));
  const clients = Array.from({ length: 63 }, () => connect(port, '127.0.0.1'));
  for (const socket of clients) socket.on('error', () => undefined);
  t.after(() => { for (const socket of clients) socket.destroy(); });
  await Promise.all(clients.map(socket => once(socket, 'connect')));
  while (sockets.size < 64) await delay(5);
  const extra = connect(port, '127.0.0.1'); extra.on('error', () => undefined); t.after(() => extra.destroy());
  await once(extra, 'close');
  const echoed = once(client, 'data'); client.write('still connected'); assert.equal((await echoed)[0].toString(), 'still connected');
  const closed = clients.map(socket => once(socket, 'close'));
  localChannels.dispose(); remoteChannels.dispose(); await Promise.all(closed);
  while (sockets.size) await delay(5);
  assert.equal(sockets.size, 0);
});

test('a stalled channel does not block another service on the same transport', { timeout: 5000 }, async t => {
  const { client, remote, port } = await tunnel(t, socket => socket.pipe(socket));
  const send = remote.send.bind(remote);
  remote.send = frame => { if (frame.type !== 'ack' || frame.id !== 1) return send(frame); };
  const stalled = new Promise(resolve => remote.on('message', frame => { if (frame.type === 'data' && frame.id === 1) resolve(); }));
  client.write(Buffer.alloc(2 * 1024 * 1024)); await stalled;
  const other = connect(port, '127.0.0.1'); other.on('error', () => undefined); t.after(() => other.destroy());
  const echoed = once(other, 'data'); other.write('independent service');
  assert.equal((await echoed)[0].toString(), 'independent service');
});
