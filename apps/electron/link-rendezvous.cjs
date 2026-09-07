// Serverless rendezvous: finding a peer with no infrastructure of our own.
//
// The relay transport works because both ends dial a machine somebody runs. This
// one removes that requirement. Public brokers — Nostr relays and MQTT brokers —
// are used purely as a bulletin board: each side posts an offer under a topic
// derived from the pairing key, reads the other side's, and from then on the
// connection is peer-to-peer. No session bytes ever cross a broker.
//
// What a broker operator can observe is a random-looking topic and the timing of
// two posts to it. It cannot read the signalling (Trystero seals it with a
// password we derive from the pairing key), it cannot join the room without that
// key, and it cannot impersonate either end, because SecureChannel still runs the
// same pairing-key handshake over the resulting connection that the relay path
// uses. A hostile broker's whole power is to withhold messages, which looks like
// a failed pairing rather than a compromised one.
//
// Several brokers are used at once rather than one: they are volunteer
// infrastructure, and the cost of one being down should be a slower connection
// rather than a broken feature.
//
// Like link-webrtc.cjs, the actual work happens in a hidden renderer, because
// Trystero is a browser library and Node has no RTCPeerConnection. Unlike
// link-webrtc.cjs, that renderer cannot be about:blank: an opaque origin is not
// a secure context, so it has no crypto.subtle, and Trystero needs SubtleCrypto
// to derive room topics and seal signalling. A privileged scheme served from
// memory gives a secure context without shipping an HTML file.

'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { hkdfSync } = require('node:crypto');

const { resolveIceServers } = require('./link-webrtc.cjs');

const RENDEZVOUS_SCHEME = 'elevenex-rtc';
const RENDEZVOUS_URL = `${RENDEZVOUS_SCHEME}://rendezvous/`;

// Nostr and MQTT both connected in about a second in testing; the torrent
// strategy needs a tracker announce interval and took fifteen, which is long
// enough to feel broken, so it is not in the default set.
const DEFAULT_STRATEGIES = ['nostr', 'mqtt'];

// Namespaces the topic so an unrelated Trystero app cannot collide with ours.
const APP_ID = 'elevenex-link';

const ROOM_INFO = 'elevenex/rendezvous/room';
const PASSWORD_INFO = 'elevenex/rendezvous/password';

/**
 * Room name and signalling password, both derived from the pairing key.
 *
 * The room name is what a broker sees, so it must not be the pairId: that
 * travels in relay traffic too, and reusing it would let anyone who saw one
 * correlate the other. HKDF from the key gives a name that is meaningless
 * without the key, and the password is a separate derivation so that seeing the
 * topic tells you nothing about how to decrypt what is posted to it.
 */
function rendezvousIdentity(pairingKey) {
  const salt = Buffer.alloc(0);
  return {
    roomId: Buffer.from(hkdfSync('sha256', pairingKey, salt, ROOM_INFO, 16)).toString('hex'),
    password: Buffer.from(hkdfSync('sha256', pairingKey, salt, PASSWORD_INFO, 32)).toString('base64'),
  };
}

// Must run before the app is ready, which is why it is separate from serving.
function registerRendezvousScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDEZVOUS_SCHEME,
      privileges: { secure: true, standard: true, supportFetchAPI: true },
    },
  ]);
}

// The page has no content: the preload owns every line of logic. It exists only
// to give that preload a secure origin to run in.
function serveRendezvousScheme(protocol) {
  protocol.handle(RENDEZVOUS_SCHEME, () => new Response('<!doctype html><meta charset="utf-8">', {
    headers: { 'content-type': 'text/html' },
  }));
}

/**
 * Builds the factory the runtime uses to open a rendezvous.
 *
 * Returns null without a BrowserWindow, matching createWebRtcPeerFactory: a
 * non-Electron caller (the tests, notably) simply has no p2p transport.
 */
function createRendezvousFactory({ BrowserWindow, onError = () => {} } = {}) {
  if (!BrowserWindow) {
    return null;
  }

  let host = null;
  let port = null;
  let nextRoomId = 1;
  const rooms = new Map();

  function ensureHost() {
    if (host && !host.isDestroyed()) {
      return;
    }

    const { MessageChannelMain } = require('electron');
    host = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'link-rendezvous-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // The preload dynamic-imports Trystero, which needs Node resolution.
        sandbox: false,
        // Throttling a hidden window would stall ICE and the data channel
        // exactly when a background session needs them.
        backgroundThrottling: false,
      },
    });

    host.loadURL(RENDEZVOUS_URL).catch((error) => onError(error));

    const channel = new MessageChannelMain();
    port = channel.port1;
    port.on('message', (event) => handleMessage(event.data));
    port.start();

    host.webContents.once('did-finish-load', () => {
      host.webContents.postMessage('elevenex-rendezvous:port', null, [channel.port2]);
    });

    host.on('closed', () => {
      host = null;
      port = null;
      for (const room of rooms.values()) {
        room.shutdown(new Error('The rendezvous renderer went away.'));
      }
      rooms.clear();
    });
  }

  function handleMessage(message) {
    const room = rooms.get(message?.id);
    if (!room) {
      return;
    }
    switch (message.t) {
      case 'peer':
        room.addPeer(message.peer);
        break;
      case 'data':
        room.peerMessage(message.peer, Buffer.from(message.b));
        break;
      case 'gone':
        room.dropPeer(message.peer);
        break;
      case 'error':
        room.emitError(new Error(message.message || 'The rendezvous failed.'));
        break;
      default:
        break;
    }
  }

  function post(message) {
    if (!port) {
      return false;
    }
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  class RendezvousPeer extends EventEmitter {
    constructor(room, peerId) {
      super();
      this.room = room;
      this.peerId = peerId;
      this.closed = false;
    }

    send(message) {
      if (this.closed) {
        return false;
      }
      // Copied into a plain Uint8Array so the structured clone does not carry a
      // Buffer's pooled backing store.
      const bytes = new Uint8Array(message.length);
      bytes.set(message);
      return post({ t: 'send', id: this.room.id, peer: this.peerId, b: bytes });
    }

    close() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      post({ t: 'drop', id: this.room.id, peer: this.peerId });
      this.emit('close');
    }

    emitClose() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.emit('close');
    }
  }

  class Rendezvous extends EventEmitter {
    constructor(id) {
      super();
      this.id = id;
      this.peers = new Map();
      this.closed = false;
    }

    addPeer(peerId) {
      if (this.closed || this.peers.has(peerId)) {
        return;
      }
      const peer = new RendezvousPeer(this, peerId);
      this.peers.set(peerId, peer);
      this.emit('peer', peer);
    }

    peerMessage(peerId, payload) {
      this.peers.get(peerId)?.emit('message', payload);
    }

    dropPeer(peerId) {
      const peer = this.peers.get(peerId);
      if (!peer) {
        return;
      }
      this.peers.delete(peerId);
      peer.emitClose();
    }

    emitError(error) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
    }

    shutdown(error) {
      if (error) {
        this.emitError(error);
      }
      for (const peer of [...this.peers.values()]) {
        peer.emitClose();
      }
      this.peers.clear();
    }

    close() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.shutdown(null);
      rooms.delete(this.id);
      post({ t: 'leave', id: this.id });
    }
  }

  /**
   * Joins the rendezvous for a pairing. Emits 'peer' for every device that
   * turns up holding the same pairing key — plural, because the sharing side
   * may legitimately be reached by several devices, and because a peer found
   * through two brokers at once arrives twice.
   */
  return function openRendezvous({
    pairingKey,
    iceServers = resolveIceServers(),
    strategies = DEFAULT_STRATEGIES,
  }) {
    ensureHost();

    const { roomId, password } = rendezvousIdentity(pairingKey);
    const id = nextRoomId;
    nextRoomId += 1;

    const room = new Rendezvous(id);
    rooms.set(id, room);

    post({
      t: 'join',
      id,
      appId: APP_ID,
      room: roomId,
      password,
      strategies,
      rtcConfig: { iceServers },
    });

    return room;
  };
}

module.exports = {
  APP_ID,
  DEFAULT_STRATEGIES,
  RENDEZVOUS_SCHEME,
  RENDEZVOUS_URL,
  createRendezvousFactory,
  registerRendezvousScheme,
  rendezvousIdentity,
  serveRendezvousScheme,
};
