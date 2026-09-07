// The upgrade path with a real (in-memory) peer standing in for WebRTC.
//
// The peer here implements exactly the contract link-webrtc.cjs implements over
// an RTCDataChannel — signal/open/message/close — so everything except the
// Chromium plumbing is exercised: signalling over the encrypted session, the
// second handshake, the switchover, and the fallback when the direct path dies.
// The Chromium half is covered by e2e/tests/link-webrtc.spec.ts.

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { after, describe, it } = require('node:test');

const { createRelayServer } = require('../../relay/server.cjs');
const { createLinkClient, createLinkHost } = require('../link-runtime.cjs');
const { createPairing } = require('../link-pairing.cjs');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }
});

/**
 * A pair of peers that find each other through the signalling channel, the way
 * two RTCPeerConnections do. `rendezvous` stands in for the physical network.
 */
function createPeerFactory(rendezvous, { failToConnect = false } = {}) {
  return ({ initiator }) => {
    const peer = new EventEmitter();
    peer.closed = false;

    peer.send = (message) => {
      if (peer.closed || !peer.remote || peer.remote.closed) {
        return false;
      }
      const copy = Buffer.from(message);
      setImmediate(() => {
        if (!peer.remote.closed) {
          peer.remote.emit('message', copy);
        }
      });
      return true;
    };

    peer.close = () => {
      if (peer.closed) {
        return;
      }
      peer.closed = true;
      setImmediate(() => peer.emit('close'));
      const remote = peer.remote;
      if (remote && !remote.closed) {
        remote.closed = true;
        setImmediate(() => remote.emit('close'));
      }
    };

    // Feeding a remote signal in is what lets the two sides pair up.
    peer.signal = (payload) => {
      if (payload.hello === 'offer' && !initiator) {
        rendezvous.responder = peer;
        peer.emit('signal', { hello: 'answer' });
        link();
      } else if (payload.hello === 'answer' && initiator) {
        link();
      }
    };

    function link() {
      const { initiator: offerer, responder } = rendezvous;
      if (!offerer || !responder || offerer.linked) {
        return;
      }
      offerer.linked = true;
      responder.linked = true;
      offerer.remote = responder;
      responder.remote = offerer;
      setImmediate(() => {
        offerer.emit('open');
        responder.emit('open');
      });
    }

    if (initiator) {
      rendezvous.initiator = peer;
      if (!failToConnect) {
        setImmediate(() => peer.emit('signal', { hello: 'offer' }));
      }
    }

    return peer;
  };
}

async function startBackend(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.end(body);
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
}

async function startRelay() {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = await relay.listen();
  cleanups.push(() => relay.close());
  return `ws://127.0.0.1:${port}/link`;
}

function fetchThrough(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

async function startPair({ failToConnect = false } = {}) {
  const relayUrl = await startRelay();
  const backendPort = await startBackend('served over the link');
  const pairing = createPairing({ transport: 'relay', endpoint: relayUrl });
  const rendezvous = {};
  const createPeer = createPeerFactory(rendezvous, { failToConnect });

  const host = createLinkHost({
    pairing,
    getTargetPort: () => backendPort,
    createPeer,
  });
  await host.start();
  cleanups.push(() => host.stop());

  const client = createLinkClient({ pairing, localPort: 0, createPeer });
  await client.start();
  cleanups.push(() => client.stop());
  await client.whenConnected();

  return { client, host, rendezvous };
}

function waitFor(predicate, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for the expected state'));
        return;
      }
      setTimeout(poll, 20).unref?.();
    };
    poll();
  });
}

describe('direct upgrade', () => {
  it('starts on the relay and moves traffic to the direct path', async () => {
    const { client } = await startPair();

    // Usable immediately, before any upgrade has had a chance to complete.
    assert.equal(await fetchThrough(client.localPort), 'served over the link');

    await waitFor(() => client.toStatus().path === 'direct');
    assert.ok(client.directSession, 'a direct session should have been adopted');

    // And still usable once traffic has moved.
    assert.equal(await fetchThrough(client.localPort), 'served over the link');
    assert.equal(client.activeSession(), client.directSession);
  });

  it('keeps working over the relay when the direct path never opens', async () => {
    const { client } = await startPair({ failToConnect: true });

    assert.equal(await fetchThrough(client.localPort), 'served over the link');
    assert.equal(client.toStatus().path, 'relay');
    assert.equal(client.activeSession(), client.session);
  });

  it('falls back to the relay when the direct path drops', async () => {
    const { client } = await startPair();
    await waitFor(() => client.toStatus().path === 'direct');

    client.directSession.close();

    await waitFor(() => client.toStatus().path === 'relay');
    // The relay session was never torn down, so this is a downgrade rather than
    // an outage.
    assert.equal(client.activeSession(), client.session);
    assert.equal(await fetchThrough(client.localPort), 'served over the link');
  });

  it('authenticates the direct path independently of the relay one', async () => {
    // A peer that completes the WebRTC handshake but cannot prove it holds the
    // pairing key must not end up serving traffic.
    const { attemptDirectUpgrade } = require('../link-upgrade.cjs');
    const relayUrl = await startRelay();
    const backendPort = await startBackend('x');
    const pairing = createPairing({ transport: 'relay', endpoint: relayUrl });
    const rendezvous = {};
    const createPeer = createPeerFactory(rendezvous);

    const host = createLinkHost({ pairing, getTargetPort: () => backendPort, createPeer });
    await host.start();
    cleanups.push(() => host.stop());

    const client = createLinkClient({ pairing, localPort: 0 });
    await client.start();
    cleanups.push(() => client.stop());
    await client.whenConnected();

    const upgraded = await attemptDirectUpgrade({
      session: client.session,
      pairingKey: randomBytes(32), // wrong key
      isInitiator: true,
      createPeer,
      timeoutMs: 3000,
    });

    assert.equal(upgraded, null, 'a peer with the wrong key must not be adopted');
    assert.equal(client.toStatus().path, 'relay');
  });

  it('does nothing when no peer factory is configured', async () => {
    const relayUrl = await startRelay();
    const backendPort = await startBackend('no webrtc here');
    const pairing = createPairing({ transport: 'relay', endpoint: relayUrl });

    const host = createLinkHost({ pairing, getTargetPort: () => backendPort });
    await host.start();
    cleanups.push(() => host.stop());

    const client = createLinkClient({ pairing, localPort: 0 });
    await client.start();
    cleanups.push(() => client.stop());
    await client.whenConnected();

    assert.equal(await fetchThrough(client.localPort), 'no webrtc here');
    assert.equal(client.toStatus().path, 'relay');
  });
});
