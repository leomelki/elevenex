// End-to-end: a real relay, a real sharing side, a real connecting side, and a
// real HTTP + WebSocket server standing in for the backend. Everything runs over
// loopback sockets — no mocks below the pairing code — so a pass here means the
// whole stack actually forwards traffic.

const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { after, describe, it } = require('node:test');

const ws = require('../link-ws.cjs');
const { createLinkClient, createLinkHost } = require('../link-runtime.cjs');
const { createPairing, decodePairingCode, encodePairingCode } = require('../link-pairing.cjs');
const { createRelayServer } = require('../../relay/server.cjs');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }
});

// Stands in for the elevenex backend: a few HTTP routes plus a WebSocket
// gateway, which is the traffic mix the link has to carry.
async function startBackend() {
  const server = http.createServer((request, response) => {
    if (request.url === '/hello') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('hello from the shared backend');
      return;
    }
    if (request.url === '/bulk') {
      const size = 4 * 1024 * 1024;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      // Written in chunks so the flow-control window is exercised rather than
      // one giant buffer handed to the kernel.
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 0xab);
      const pump = () => {
        while (sent < size) {
          const next = Math.min(chunk.length, size - sent);
          sent += next;
          if (!response.write(chunk.subarray(0, next))) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
      return;
    }
    if (request.method === 'POST' && request.url === '/echo-body') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end(`received ${body.length}`);
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  ws.attachServer(server, {
    path: '/gateway',
    onConnection: (channel) => {
      channel.on('message', (message) => {
        channel.send(Buffer.concat([Buffer.from('echo:'), message]), { binary: true });
      });
    },
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { server, port };
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
  });
}

function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Length': body.length } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString(),
        }));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

// Brings up relay + host + client and returns the loopback port that now
// represents the remote backend.
async function startLink({ backendPort, transport = 'relay' }) {
  let pairing;

  if (transport === 'relay') {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', quiet: true });
    const relayPort = await relay.listen();
    cleanups.push(() => relay.close());
    pairing = createPairing({
      transport: 'relay',
      endpoint: `ws://127.0.0.1:${relayPort}/link`,
      label: 'Test host',
    });
  } else {
    // Port 0 is not usable for a direct pairing (the code has to name a port),
    // so grab a free one the same way the app does.
    const probe = http.createServer();
    const freePort = await new Promise((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
    });
    await new Promise((resolve) => probe.close(() => resolve()));
    pairing = createPairing({
      transport: 'direct',
      endpoint: `127.0.0.1:${freePort}`,
      label: 'Test host',
    });
  }

  const host = createLinkHost({
    pairing,
    getTargetPort: () => backendPort,
    bindHost: '127.0.0.1',
  });
  await host.start();
  cleanups.push(() => host.stop());

  // The connecting side only ever sees the code, exactly like a real user.
  const clientPairing = decodePairingCode(encodePairingCode(pairing));
  const client = createLinkClient({ pairing: clientPairing, localPort: 0 });
  await client.start();
  cleanups.push(() => client.stop());
  await client.whenConnected();

  return { client, host, pairing, localPort: client.localPort };
}

describe('remote link end to end', () => {
  it('forwards HTTP through a relay', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const response = await httpGet(localPort, '/hello');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString(), 'hello from the shared backend');
  });

  it('forwards HTTP through a direct connection', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port, transport: 'direct' });

    const response = await httpGet(localPort, '/hello');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString(), 'hello from the shared backend');
  });

  it('carries a WebSocket gateway', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const channel = await ws.connect(`ws://127.0.0.1:${localPort}/gateway`);
    const received = [];
    const drained = new Promise((resolve) => {
      channel.on('message', (message) => {
        received.push(message.toString());
        if (received.length === 3) {
          resolve();
        }
      });
    });

    channel.send(Buffer.from('one'));
    channel.send(Buffer.from('two'));
    channel.send(Buffer.from('three'));
    await drained;
    channel.close();

    assert.deepEqual(received, ['echo:one', 'echo:two', 'echo:three']);
  });

  it('keeps a WebSocket and HTTP requests alive on the same link', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const channel = await ws.connect(`ws://127.0.0.1:${localPort}/gateway`);
    const echoed = new Promise((resolve) => channel.once('message', resolve));

    // Interleave: the socket must survive unrelated request traffic on the very
    // same multiplexed connection.
    const responses = await Promise.all([
      httpGet(localPort, '/hello'),
      httpGet(localPort, '/hello'),
      httpGet(localPort, '/hello'),
    ]);
    channel.send(Buffer.from('still here'));

    assert.equal((await echoed).toString(), 'echo:still here');
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
    }
    channel.close();
  });

  it('streams a payload far larger than the flow-control window', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const response = await httpGet(localPort, '/bulk');
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.length, 4 * 1024 * 1024);
    assert.ok(response.body.every((byte) => byte === 0xab));
  });

  it('carries a large request body upstream', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const body = randomBytes(2 * 1024 * 1024);
    const response = await httpPost(localPort, '/echo-body', body);
    assert.equal(response.body, `received ${body.length}`);
  });

  it('handles many concurrent requests', async () => {
    const backend = await startBackend();
    const { localPort } = await startLink({ backendPort: backend.port });

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => httpGet(localPort, '/hello')),
    );
    for (const response of responses) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.toString(), 'hello from the shared backend');
    }
  });

  it('reconnects and keeps the same local port after the link drops', async () => {
    const backend = await startBackend();
    const { client, localPort } = await startLink({ backendPort: backend.port });

    assert.equal((await httpGet(localPort, '/hello')).statusCode, 200);

    // Simulate a network drop by killing the live session underneath.
    const reconnected = new Promise((resolve) => {
      const onStatus = (status) => {
        if (status.status === 'connected') {
          client.removeListener('status', onStatus);
          resolve(status);
        }
      };
      client.on('status', onStatus);
    });
    client.session.close();

    const status = await reconnected;
    assert.equal(status.localPort, localPort, 'the loopback port must survive a reconnect');
    assert.equal((await httpGet(localPort, '/hello')).statusCode, 200);
  });

  it('refuses a peer with the wrong pairing key', async () => {
    const backend = await startBackend();
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', quiet: true });
    const relayPort = await relay.listen();
    cleanups.push(() => relay.close());

    const pairing = createPairing({
      transport: 'relay',
      endpoint: `ws://127.0.0.1:${relayPort}/link`,
    });

    const host = createLinkHost({ pairing, getTargetPort: () => backend.port });
    await host.start();
    cleanups.push(() => host.stop());

    // Same rendezvous, wrong key — the relay will splice them, the handshake
    // must not.
    const impostor = createLinkClient({
      pairing: { ...pairing, pairingKey: randomBytes(32) },
      localPort: 0,
    });
    await impostor.start();
    cleanups.push(() => impostor.stop());

    await assert.rejects(impostor.whenConnected({ timeoutMs: 4000 }));
    assert.notEqual(impostor.status, 'connected');
  });
});
