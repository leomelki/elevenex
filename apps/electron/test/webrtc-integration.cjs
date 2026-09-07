// Real-Chromium integration check for the direct (WebRTC) upgrade.
//
// Runs under the Electron binary rather than `node --test`, because it needs an
// actual RTCPeerConnection: this is the half that test/link-upgrade.test.cjs
// deliberately stubs out. It brings up a relay, a backend, and both ends of a
// link inside one Electron process, then asserts that traffic ends up on the
// peer-to-peer path and still works there.
//
//   pnpm --dir apps/electron test:webrtc
//
// Exits non-zero with a reason on any failure.

'use strict';

const http = require('node:http');
const { app, BrowserWindow } = require('electron');

const { createRelayServer } = require('../../relay/server.cjs');
const { createLinkClient, createLinkHost } = require('../link-runtime.cjs');
const { createPairing } = require('../link-pairing.cjs');
const { createWebRtcPeerFactory } = require('../link-webrtc.cjs');

const BODY = 'served over a direct peer connection';
const BULK_BYTES = 4 * 1024 * 1024;
const DEADLINE_MS = 60000;

function fail(message, error) {
  process.stderr.write(`FAIL: ${message}${error ? `\n${error.stack || error}` : ''}\n`);
  process.exit(1);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fetchThrough(port, path = '/') {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on('error', reject);
  });
}

function waitFor(label, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function main() {
  const backend = http.createServer((request, response) => {
    if (request.url === '/bulk') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        while (sent < BULK_BYTES) {
          const next = Math.min(chunk.length, BULK_BYTES - sent);
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
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(BODY);
  });
  const backendPort = await new Promise((resolve) => {
    backend.listen(0, '127.0.0.1', () => resolve(backend.address().port));
  });
  log(`backend on ${backendPort}`);

  const relay = createRelayServer({ port: 0, host: '127.0.0.1', quiet: true });
  const relayPort = await relay.listen();
  log(`relay on ${relayPort}`);

  const createPeer = createWebRtcPeerFactory({
    BrowserWindow,
    onError: (error) => process.stderr.write(`webrtc host error: ${error?.message || error}\n`),
  });
  if (!createPeer) {
    fail('createWebRtcPeerFactory returned null');
  }

  const pairing = createPairing({
    transport: 'relay',
    endpoint: `ws://127.0.0.1:${relayPort}/link`,
    label: 'WebRTC integration',
  });

  const host = createLinkHost({ pairing, getTargetPort: () => backendPort, createPeer });
  await host.start();

  const client = createLinkClient({ pairing, localPort: 0, createPeer });
  await client.start();
  await client.whenConnected();
  log(`link connected on loopback port ${client.localPort}`);

  // Works before any upgrade — the relay path is what makes the link usable
  // immediately.
  const overRelay = await fetchThrough(client.localPort);
  if (overRelay !== BODY) {
    fail(`relay path returned ${JSON.stringify(overRelay)}`);
  }
  if (client.toStatus().path !== 'relay') {
    fail(`expected to start on the relay, got ${client.toStatus().path}`);
  }
  log('relay path verified');

  await waitFor('the direct path to come up', () => client.toStatus().path === 'direct', DEADLINE_MS);
  log('upgraded to the direct path');

  // The switch is only meaningful if the peer-to-peer session actually carries
  // traffic, so this request must be served over it.
  const before = client.directSession.streams.size;
  const overDirect = await fetchThrough(client.localPort);
  if (overDirect !== BODY) {
    fail(`direct path returned ${JSON.stringify(overDirect)}`);
  }
  if (client.activeSession() !== client.directSession) {
    fail('new connections are not using the direct session');
  }
  log(`direct path verified (streams opened on it: ${before >= 0})`);

  // Well past a single data-channel message, so mux framing, SCTP chunking and
  // the renderer's buffered-amount handling are all exercised rather than one
  // small write.
  const bulk = await fetchThrough(client.localPort, '/bulk');
  if (bulk.length !== BULK_BYTES) {
    fail(`bulk transfer over the direct path returned ${bulk.length} bytes, expected ${BULK_BYTES}`);
  }
  if (!/^A+$/.test(bulk.slice(0, 4096))) {
    fail('bulk transfer over the direct path was corrupted');
  }
  log(`bulk transfer over the direct path verified (${BULK_BYTES} bytes)`);

  // Losing the direct path must degrade to the relay, not break the link.
  client.directSession.close();
  await waitFor('fallback to the relay', () => client.toStatus().path === 'relay', 15000);
  const afterFallback = await fetchThrough(client.localPort);
  if (afterFallback !== BODY) {
    fail(`relay fallback returned ${JSON.stringify(afterFallback)}`);
  }
  log('fallback to relay verified');

  await client.stop();
  await host.stop();
  await relay.close();
  await new Promise((resolve) => backend.close(() => resolve()));

  log('PASS: direct WebRTC upgrade works end to end');
  process.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => fail('overall timeout'), DEADLINE_MS * 2);
  guard.unref?.();
  main().catch((error) => fail('integration run threw', error));
}).catch((error) => fail('electron failed to become ready', error));
