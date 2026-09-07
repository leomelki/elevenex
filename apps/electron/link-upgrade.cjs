// Upgrading a relayed link to a direct peer-to-peer one.
//
// The relay session is established first and always works. Once it is up, both
// ends try to build a direct connection, exchanging offer/answer/ICE as SIGNAL
// frames *inside* that encrypted session — so the relay forwards signalling it
// cannot read and cannot tamper with.
//
// When the direct path opens, a second encrypted session is built over it and
// new forwarded connections are routed there. Nothing migrates mid-stream:
// in-flight streams drain on the relay session while new ones take the fast
// path. That avoids the one genuinely hard problem in a transport switch —
// handing a live, ordered, authenticated byte stream from one carrier to
// another without dropping or duplicating a frame — for a cost that is only
// visible on connections that were already open.
//
// If the direct session dies, callers fall back to the relay session, which was
// never torn down.

'use strict';

const { EventEmitter } = require('node:events');

const { SecureChannel } = require('./link-secure.cjs');
const { createMuxSession } = require('./link-mux.cjs');

const SIGNAL_KIND = 'rtc';
const DEFAULT_UPGRADE_TIMEOUT_MS = 20000;

// Adapts a peer (anything with send/'message'/'close') to the message-channel
// shape SecureChannel expects. Identical in spirit to the WebSocket and framed
// TCP channels, which is why the layers above cannot tell them apart.
class PeerChannel extends EventEmitter {
  constructor(peer) {
    super();
    this.peer = peer;
    this.closed = false;

    peer.on('message', (message) => this.emit('message', message, true));
    peer.on('close', () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.emit('close');
    });
    peer.on('error', (error) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.close();
    });
  }

  send(message) {
    if (this.closed) {
      return false;
    }
    return this.peer.send(Buffer.isBuffer(message) ? message : Buffer.from(message));
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.peer.close();
    } catch {
      // Already gone.
    }
    this.emit('close');
  }
}

/**
 * Attempts one upgrade over an established relay session.
 *
 * Resolves with a live direct MuxSession, or null when the attempt did not
 * succeed — hole punching failing is an ordinary outcome on a symmetric NAT or
 * a network that blocks UDP, not an error, so the caller simply keeps using the
 * relay.
 */
async function attemptDirectUpgrade({
  session,
  pairingKey,
  isInitiator,
  createPeer,
  timeoutMs = DEFAULT_UPGRADE_TIMEOUT_MS,
  signal,
}) {
  if (typeof createPeer !== 'function' || !session?.isOpen()) {
    return null;
  }

  let peer = null;
  let settled = false;
  let timer = null;
  let onSessionSignal = null;
  let onSessionClose = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (onSessionSignal) {
      session.removeListener('signal', onSessionSignal);
      onSessionSignal = null;
    }
    if (onSessionClose) {
      session.removeListener('close', onSessionClose);
      onSessionClose = null;
    }
  };

  try {
    return await new Promise((resolve, reject) => {
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const abandon = () => {
        if (settled) {
          return;
        }
        try {
          peer?.close();
        } catch {
          // Nothing to do.
        }
        finish(null);
      };

      timer = setTimeout(abandon, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      signal?.addEventListener('abort', abandon, { once: true });

      onSessionClose = () => abandon();
      session.once('close', onSessionClose);

      let peerInstance;
      try {
        peerInstance = createPeer({ initiator: Boolean(isInitiator) });
      } catch (error) {
        reject(error);
        return;
      }
      peer = peerInstance;

      // Everything the peer wants to tell the other side goes through the
      // encrypted session rather than the relay's control channel.
      peer.on('signal', (payload) => {
        if (session.isOpen()) {
          session.sendSignal({ t: SIGNAL_KIND, p: payload });
        }
      });

      onSessionSignal = (message) => {
        if (message?.t !== SIGNAL_KIND) {
          return;
        }
        try {
          peer.signal(message.p);
        } catch {
          abandon();
        }
      };
      session.on('signal', onSessionSignal);

      peer.on('error', () => abandon());
      peer.on('close', () => {
        // Only meaningful before the handshake completes; afterwards the direct
        // session owns the peer and reports its own close.
        abandon();
      });

      peer.on('open', () => {
        const channel = new PeerChannel(peer);
        const secure = new SecureChannel(channel, { pairingKey, isInitiator });
        secure
          .whenReady()
          .then(() => {
            if (settled) {
              secure.close();
              return;
            }
            // A peer that cannot prove it holds the pairing key never gets to
            // serve traffic, exactly as on the relay path.
            finish(createMuxSession(secure, {
              isInitiator,
              // Smaller than the relay path's frames: every mux frame becomes
              // one data-channel message, and staying well inside SCTP's
              // comfortable range avoids relying on large-message fragmentation.
              maxFrameBytes: 64 * 1024,
            }));
          })
          .catch(() => {
            secure.close();
            abandon();
          });
      });
    });
  } finally {
    cleanup();
  }
}

module.exports = {
  DEFAULT_UPGRADE_TIMEOUT_MS,
  PeerChannel,
  SIGNAL_KIND,
  attemptDirectUpgrade,
};
