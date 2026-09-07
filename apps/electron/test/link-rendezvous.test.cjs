// The p2p transport with an in-memory rendezvous standing in for the brokers.
//
// The fake here implements exactly the contract link-rendezvous.cjs implements
// over Trystero — a room that emits peers, and peers that carry bytes — so
// everything except the broker plumbing is exercised: the handshake over a peer
// channel, forwarding, duplicate peers arriving from a second broker, and the
// teardown that has to happen when a room is abandoned. The Chromium and
// real-broker half is covered by test/rendezvous-integration.cjs.

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { after, describe, it } = require('node:test');

const { createLinkClient, createLinkHost } = require('../link-runtime.cjs');
const { createPairing } = require('../link-pairing.cjs');
const { rendezvousIdentity } = require('../link-rendezvous.cjs');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }
});

function linkedPeers() {
  const make = () => {
    const peer = new EventEmitter();
    peer.closed = false;
    peer.send = (message) => {
      if (peer.closed || peer.remote.closed) {
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
      if (!peer.remote.closed) {
        peer.remote.closed = true;
        setImmediate(() => peer.remote.emit('close'));
      }
    };
    return peer;
  };

  const left = make();
  const right = make();
  left.remote = right;
  right.remote = left;
  return [left, right];
}

/**
 * A broker network: rooms with the same derived name are introduced to each
 * other, and nothing else can see them.
 */
function createFakeBrokers() {
  const rooms = new Map();

  // Every room handed out, so a test can play the part of a second broker
  // introducing a peer the other one already found.
  openRendezvous.instances = [];

  function openRendezvous({ pairingKey }) {
    const { roomId } = rendezvousIdentity(pairingKey);
    const rendezvous = new EventEmitter();
    rendezvous.closed = false;
    rendezvous.close = () => {
      rendezvous.closed = true;
      const members = rooms.get(roomId) || [];
      rooms.set(roomId, members.filter((member) => member !== rendezvous));
    };

    const members = rooms.get(roomId) || [];
    for (const member of members) {
      if (member.closed) {
        continue;
      }
      const [mine, theirs] = linkedPeers();
      setImmediate(() => {
        rendezvous.emit('peer', mine);
        member.emit('peer', theirs);
      });
    }
    rooms.set(roomId, [...members.filter((member) => !member.closed), rendezvous]);
    openRendezvous.instances.push(rendezvous);

    return rendezvous;
  }

  return openRendezvous;
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

async function startBackend(body) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(body);
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

describe('rendezvous identity', () => {
  it('derives the same room from the same key, and a different one otherwise', () => {
    const key = createPairing({ transport: 'p2p' }).pairingKey;
    const other = createPairing({ transport: 'p2p' }).pairingKey;

    assert.deepEqual(rendezvousIdentity(key), rendezvousIdentity(key));
    assert.notEqual(rendezvousIdentity(key).roomId, rendezvousIdentity(other).roomId);
  });

  it('does not reuse the room name as the signalling password', () => {
    const { roomId, password } = rendezvousIdentity(createPairing({ transport: 'p2p' }).pairingKey);
    assert.notEqual(roomId, password);
  });

  it('never puts the pairing key itself on a broker', () => {
    const pairing = createPairing({ transport: 'p2p' });
    const { roomId, password } = rendezvousIdentity(pairing.pairingKey);
    const secret = pairing.pairingKey.toString('hex');

    assert.ok(!roomId.includes(secret));
    assert.ok(!Buffer.from(password, 'base64').equals(pairing.pairingKey));
  });
});

describe('p2p links', () => {
  it('carries traffic between two ends that only ever met in a room', async () => {
    const backendPort = await startBackend('served peer to peer');
    const openRendezvous = createFakeBrokers();
    const pairing = createPairing({ transport: 'p2p', label: 'Desktop' });

    const host = createLinkHost({ pairing, getTargetPort: () => backendPort, openRendezvous });
    await host.start();
    cleanups.push(() => host.stop());

    const client = createLinkClient({ pairing, localPort: 0, openRendezvous });
    await client.start();
    cleanups.push(() => client.stop());
    await client.whenConnected({ timeoutMs: 10000 });

    assert.equal(await fetchThrough(client.localPort), 'served peer to peer');
    // Nothing is relaying, so reporting a relay path would be a lie.
    assert.equal(client.toStatus().path, 'direct');
  });

  it('refuses a peer that does not hold the pairing key', async () => {
    const backendPort = await startBackend('should not be reachable');
    const openRendezvous = createFakeBrokers();

    const host = createLinkHost({
      pairing: createPairing({ transport: 'p2p' }),
      getTargetPort: () => backendPort,
      openRendezvous,
    });
    await host.start();
    cleanups.push(() => host.stop());

    // A different key is a different room, so the impostor never even meets the
    // host — and if a broker introduced them anyway, the handshake would fail.
    const impostor = createLinkClient({
      pairing: createPairing({ transport: 'p2p' }),
      localPort: 0,
      openRendezvous,
    });
    await impostor.start();
    cleanups.push(() => impostor.stop());

    await assert.rejects(() => impostor.whenConnected({ timeoutMs: 1500 }));
    assert.equal(host.toStatus().connectedPeers, 0);
  });

  it('closes the duplicate when a second broker introduces the same peer', async () => {
    const backendPort = await startBackend('still one connection');
    const openRendezvous = createFakeBrokers();
    const pairing = createPairing({ transport: 'p2p' });

    const host = createLinkHost({ pairing, getTargetPort: () => backendPort, openRendezvous });
    await host.start();
    cleanups.push(() => host.stop());

    const client = createLinkClient({ pairing, localPort: 0, openRendezvous });
    await client.start();
    cleanups.push(() => client.stop());
    await client.whenConnected({ timeoutMs: 10000 });

    // The room the client is sitting in, playing the part of the second broker
    // turning up with a device the first one already introduced.
    const clientRoom = openRendezvous.instances.at(-1);
    const [duplicate, farEnd] = linkedPeers();
    const closed = new Promise((resolve) => duplicate.once('close', resolve));
    clientRoom.emit('peer', duplicate);
    await closed;

    assert.ok(duplicate.closed, 'the duplicate peer should have been closed');
    assert.ok(farEnd.closed, 'closing a duplicate should take its far end with it');
    // The connection that was already working must be untouched by all this.
    assert.equal(await fetchThrough(client.localPort), 'still one connection');
  });
});
