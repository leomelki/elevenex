// WebRTC peers, backed by Electron's own Chromium.
//
// Node has no RTCPeerConnection and this app ships no native modules (see
// link-ws.cjs), so the peer connections live in a hidden renderer and the main
// process drives them. That means Chromium's ICE stack — the best-tested one
// there is — with no addon to compile for five platform targets.
//
// The data path is a MessagePortMain rather than ipcMain/ipcRenderer. Standard
// IPC is a serialised, main-thread-bound channel and this carries whole file
// reads and diffs; a MessagePort is a direct pipe between the two processes and
// keeps that traffic off the IPC bottleneck.
//
// Everything below the peer contract (signal/open/message/close) is identical to
// the in-memory peer in test/link-upgrade.test.cjs, which is what lets the
// switchover logic be tested without a browser.

'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');

// Public STUN is used only to discover this machine's public address; no session
// data passes through it. Overridable for deployments that would rather not talk
// to a third party, at the cost of only reaching peers on the same network.
//
// The list is chosen for two kinds of diversity, because a STUN server that
// cannot be reached costs a hole-punch attempt:
//
//   - Operators, so one provider's outage or rate limit is not the whole story.
//     Google and Cloudflare are anycast and free; Twilio's has been open for
//     years; Nextcloud's is a fourth party on a different network entirely.
//   - Ports, which matters more than operator count on a locked-down network.
//     UDP 3478 and 19302 are the ports a restrictive firewall knows to block,
//     so the list also reaches out on 53 and 443 — ports that carry DNS and
//     QUIC, and are therefore rarely filtered.
//
// Verified reachable by Binding Request before being listed here. Known-dead
// names that still circulate in public lists — stun.stunprotocol.org,
// stun.services.mozilla.com, stun.jitsi.net, openrelay.metered.ca — are
// deliberately absent, as is Google's port 5349, which answers only over TLS.
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.cloudflare.com:53' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.nextcloud.com:443' },
];

function resolveIceServers() {
  const configured = process.env.ELEVENEX_ICE_SERVERS?.trim();
  if (!configured) {
    return DEFAULT_ICE_SERVERS;
  }
  if (configured.toLowerCase() === 'none') {
    return [];
  }
  // Comma-separated URLs, or a JSON array for servers that need credentials.
  if (configured.startsWith('[')) {
    try {
      return JSON.parse(configured);
    } catch {
      return DEFAULT_ICE_SERVERS;
    }
  }
  return configured.split(',').map((urls) => ({ urls: urls.trim() })).filter((entry) => entry.urls);
}

function createWebRtcPeerFactory({ BrowserWindow, onError = () => {} } = {}) {
  if (!BrowserWindow) {
    return null;
  }

  let host = null;
  let port = null;
  let nextPeerId = 1;
  const peers = new Map();

  // One hidden renderer serves every peer; connections are keyed by id inside
  // the port messages. Created lazily so an app that never shares a backend
  // never pays for it.
  function ensureHost() {
    if (host && !host.isDestroyed()) {
      return;
    }

    const { MessageChannelMain } = require('electron');
    host = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'link-webrtc-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // A hidden window is throttled by default, which would stall ICE and
        // the data channel whenever the app is in the background — exactly when
        // a long-running remote session needs it most.
        backgroundThrottling: false,
      },
    });

    // about:blank rather than a shipped HTML file: the preload owns all the
    // logic, so there is no page content and nothing extra to package.
    host.loadURL('about:blank').catch((error) => onError(error));

    const channel = new MessageChannelMain();
    port = channel.port1;
    port.on('message', (event) => handleMessage(event.data));
    port.start();

    host.webContents.once('did-finish-load', () => {
      host.webContents.postMessage('elevenex-webrtc:port', null, [channel.port2]);
    });

    host.on('closed', () => {
      host = null;
      port = null;
      for (const peer of peers.values()) {
        peer.emitClose();
      }
      peers.clear();
    });
  }

  function handleMessage(message) {
    const peer = peers.get(message?.id);
    if (!peer) {
      return;
    }

    switch (message.t) {
      case 'signal':
        peer.emit('signal', message.payload);
        break;
      case 'open':
        peer.emit('open');
        break;
      case 'data':
        peer.emit('message', Buffer.from(message.b));
        break;
      case 'error':
        peer.emitError(new Error(message.message || 'WebRTC peer failed'));
        break;
      case 'close':
        peer.emitClose();
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

  class WebRtcPeer extends EventEmitter {
    constructor(id) {
      super();
      this.id = id;
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
      return post({ t: 'send', id: this.id, b: bytes });
    }

    signal(payload) {
      if (this.closed) {
        return;
      }
      post({ t: 'signal', id: this.id, payload });
    }

    close() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      post({ t: 'destroy', id: this.id });
      peers.delete(this.id);
      this.emit('close');
    }

    emitClose() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      peers.delete(this.id);
      this.emit('close');
    }

    emitError(error) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.emitClose();
    }
  }

  return function createPeer({ initiator }) {
    ensureHost();
    const id = nextPeerId;
    nextPeerId += 1;

    const peer = new WebRtcPeer(id);
    peers.set(id, peer);
    post({
      t: 'create',
      id,
      initiator: Boolean(initiator),
      iceServers: resolveIceServers(),
    });
    return peer;
  };
}

module.exports = {
  DEFAULT_ICE_SERVERS,
  createWebRtcPeerFactory,
  resolveIceServers,
};
