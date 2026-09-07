// Real-Chromium integration check for the serverless (p2p) transport.
//
// Runs under the Electron binary rather than `node --test`, because it needs an
// actual RTCPeerConnection and a secure context for Trystero. It brings up a
// backend and both ends of a link inside one Electron process, with no relay
// anywhere, then asserts that traffic flows over a connection the two ends found
// through public brokers.
//
//   pnpm --dir apps/electron test:rendezvous
//
// This talks to volunteer infrastructure (Nostr relays, MQTT brokers), so it is
// not part of `pnpm test`: a failure here can mean the brokers are having a bad
// day rather than that the code is wrong.
//
// Exits non-zero with a reason on any failure.

'use strict';

const http = require('node:http');
const { app, BrowserWindow, protocol } = require('electron');

const { createLinkClient, createLinkHost } = require('../link-runtime.cjs');
const { createPairing } = require('../link-pairing.cjs');
const {
  createRendezvousFactory,
  registerRendezvousScheme,
  serveRendezvousScheme,
} = require('../link-rendezvous.cjs');

// Before the app is ready, exactly as main.cjs does it.
registerRendezvousScheme(protocol);

const BODY = 'served over a connection nobody brokered';
const BULK_BYTES = 4 * 1024 * 1024;
const DEADLINE_MS = 90000;

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

  // Two factories, so each end gets its own renderer. Trystero's peer identity
  // is per JavaScript context: sharing one renderer would give both ends the
  // same identity, and a room cannot introduce a peer to itself. On real
  // hardware the two ends are separate machines, so this only matters here.
  const openHostRendezvous = createRendezvousFactory({
    BrowserWindow,
    onError: (error) => process.stderr.write(`host rendezvous: ${error?.message || error}\n`),
  });
  const openClientRendezvous = createRendezvousFactory({
    BrowserWindow,
    onError: (error) => process.stderr.write(`client rendezvous: ${error?.message || error}\n`),
  });
  if (!openHostRendezvous || !openClientRendezvous) {
    fail('createRendezvousFactory returned null');
  }

  // No endpoint at all: this is the whole point of the transport.
  const pairing = createPairing({ transport: 'p2p', label: 'Rendezvous integration' });
  if (pairing.endpoint !== '') {
    fail(`a p2p pairing should carry no endpoint, got ${JSON.stringify(pairing.endpoint)}`);
  }

  const started = Date.now();
  const host = createLinkHost({
    pairing,
    getTargetPort: () => backendPort,
    openRendezvous: openHostRendezvous,
  });
  await host.start();
  log('sharing side waiting in the rendezvous');

  const client = createLinkClient({
    pairing,
    localPort: 0,
    openRendezvous: openClientRendezvous,
  });
  await client.start();
  await client.whenConnected({ timeoutMs: DEADLINE_MS });
  log(`link connected on loopback port ${client.localPort} after ${Date.now() - started}ms`);

  const body = await fetchThrough(client.localPort);
  if (body !== BODY) {
    fail(`p2p path returned ${JSON.stringify(body)}`);
  }
  log('request served over the peer-to-peer path');

  // There is no relay in this test, so anything but 'direct' would mean the
  // status is lying about how traffic is flowing.
  if (client.toStatus().path !== 'direct') {
    fail(`expected a direct path, got ${client.toStatus().path}`);
  }

  // The sharing side waits in every broker family at once, so being introduced
  // to the same machine twice is the failure this guards: one connection in,
  // one session held, and it stays that way rather than accumulating.
  await new Promise((resolve) => setTimeout(resolve, 8000));
  if (host.toStatus().connectedPeers !== 1) {
    fail(`the sharing side is holding ${host.toStatus().connectedPeers} sessions, expected 1`);
  }
  log('sharing side settled on exactly one session');

  // Well past a single data-channel message, so mux framing and SCTP chunking
  // are exercised rather than one small write.
  const bulk = await fetchThrough(client.localPort, '/bulk');
  if (bulk.length !== BULK_BYTES) {
    fail(`bulk transfer returned ${bulk.length} bytes, expected ${BULK_BYTES}`);
  }
  if (!/^A+$/.test(bulk.slice(0, 4096))) {
    fail('bulk transfer was corrupted');
  }
  log(`bulk transfer verified (${BULK_BYTES} bytes)`);

  await client.stop();
  await host.stop();
  backend.close();
  log('PASS');
  app.exit(0);
}

app.whenReady().then(() => {
  serveRendezvousScheme(protocol);

  setTimeout(() => fail(`timed out after ${DEADLINE_MS}ms`), DEADLINE_MS).unref?.();
  main().catch((error) => fail('unexpected error', error));
});
