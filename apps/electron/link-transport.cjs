// The two ways the two ends find each other.
//
//   relay  — both sides dial an outbound WebSocket to a rendezvous server which
//            splices them together. Works behind NAT and CGNAT with nothing
//            configured on either router, which is the point of the feature.
//   direct — the sharing side listens on a TCP port and the connecting side
//            dials it. No server to run; usable on a LAN or wherever the host is
//            already reachable.
//
// Both produce the same message-oriented channel, so everything above (the
// encryption, the mux, the port forwarding) is identical either way. That seam
// is also where a future hole-punched transport would slot in without the layers
// above noticing.

'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

const ws = require('./link-ws.cjs');

const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
// Long enough not to be chatty, short enough to hold open the NAT mappings and
// idle timeouts that sit between the two ends and the relay.
const KEEPALIVE_INTERVAL_MS = 25000;

// Message framing for raw TCP. The WebSocket transport already preserves message
// boundaries; this gives the direct transport the same guarantee.
class FramedChannel extends EventEmitter {
  constructor(socket, { maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.closed = false;
    this.buffered = Buffer.alloc(0);

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.close();
    });
    socket.on('close', () => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.emit('close');
    });
  }

  send(message) {
    if (this.closed) {
      return false;
    }
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const header = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    header.writeUInt32BE(payload.length, 0);
    return this.socket.write(Buffer.concat([header, payload], header.length + payload.length));
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  #onData(chunk) {
    this.buffered = this.buffered.length === 0
      ? chunk
      : Buffer.concat([this.buffered, chunk], this.buffered.length + chunk.length);

    for (;;) {
      if (this.buffered.length < LENGTH_PREFIX_BYTES) {
        return;
      }
      const length = this.buffered.readUInt32BE(0);
      if (length > this.maxMessageBytes) {
        if (this.listenerCount('error') > 0) {
          this.emit('error', new Error(`Link frame of ${length} bytes exceeds the limit`));
        }
        this.close();
        return;
      }
      if (this.buffered.length < LENGTH_PREFIX_BYTES + length) {
        return;
      }
      const payload = Buffer.from(
        this.buffered.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length),
      );
      this.buffered = this.buffered.subarray(LENGTH_PREFIX_BYTES + length);
      this.emit('message', payload, true);
    }
  }
}

function connectDirect({ host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);

    const failOnce = (error) => {
      socket.destroy();
      reject(error);
    };

    socket.once('timeout', () => failOnce(new Error(`Timed out connecting to ${host}:${port}`)));
    socket.once('error', failOnce);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', failOnce);
      resolve(new FramedChannel(socket));
    });
  });
}

function createDirectServer({ host = '0.0.0.0', port, onChannel, onError }) {
  const server = net.createServer((socket) => {
    onChannel(new FramedChannel(socket));
  });

  server.on('error', (error) => {
    if (onError) {
      onError(error);
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Live link connections never end by themselves; drop them rather than
        // waiting out a shutdown that would otherwise hang.
        server.closeAllConnections?.();
      });
    },
  };
}

function buildRelayUrl(endpoint, pairId, role) {
  const url = new URL(endpoint);
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  url.searchParams.set('pair', pairId);
  url.searchParams.set('role', role);
  return url.toString();
}

// Resolves once the *other* end is also connected. Both sides need that signal:
// the encrypted handshake starts by sending a hello, and a hello sent into an
// empty room would be dropped by the relay and never answered.
function awaitRelayPeer({ endpoint, pairId, role, signal, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    let channel = null;
    let settled = false;
    let keepalive = null;

    const cleanup = () => {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };

    function onAbort() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      channel?.close();
      reject(new Error('Aborted'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    ws.connect(buildRelayUrl(endpoint, pairId, role), { handshakeTimeoutMs: connectTimeoutMs })
      .then((connected) => {
        channel = connected;
        if (settled) {
          channel.close();
          return;
        }

        keepalive = setInterval(() => channel.ping(), KEEPALIVE_INTERVAL_MS);
        if (typeof keepalive.unref === 'function') {
          keepalive.unref();
        }

        const onControl = (message, isBinary) => {
          if (isBinary || settled) {
            return;
          }
          let control;
          try {
            control = JSON.parse(message.toString('utf8'));
          } catch {
            return;
          }

          if (control.t === 'peer') {
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            channel.removeListener('message', onControl);
            channel.removeListener('close', onClose);
            // The keepalive outlives this promise and is cleared when the
            // channel closes, so the session it hands off stays warm.
            channel.once('close', () => clearInterval(keepalive));
            resolve(channel);
            return;
          }

          if (control.t === 'error') {
            settled = true;
            cleanup();
            channel.close();
            const error = new Error(control.message || 'The relay rejected this connection.');
            // The relay answered on purpose — nobody is sharing this code, the
            // id is malformed, it is at capacity. Marked so the caller can tell
            // the user now instead of retrying in silence behind a timeout.
            error.code = 'RELAY_REJECTED';
            reject(error);
          }
        };

        const onClose = () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error('The relay closed the connection before a peer arrived.'));
        };

        channel.on('message', onControl);
        channel.once('close', onClose);
        channel.on('error', () => {});
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
  });
}

module.exports = {
  FramedChannel,
  KEEPALIVE_INTERVAL_MS,
  awaitRelayPeer,
  buildRelayUrl,
  connectDirect,
  createDirectServer,
};
