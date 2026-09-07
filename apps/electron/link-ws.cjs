// Minimal RFC 6455 WebSocket client and server.
//
// apps/electron has no runtime dependencies — main.cjs runs on Node built-ins
// and Electron alone, and electron-builder's `files` list only ships `*.cjs`
// (see test/package-files.test.cjs). Pulling in `ws` would mean bundling
// node_modules into the packaged app, so the handful of framing rules the relay
// link needs are implemented here instead.
//
// Deliberately not implemented: permessage-deflate, subprotocol negotiation and
// client-side fragmentation on send. The link layer above already compresses
// nothing and frames its own messages, so none of that would earn its keep.
// Fragmented *incoming* messages are reassembled, because a conforming peer may
// always send them.

'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');

const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11D';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

// Bounds an attacker's ability to make us buffer: a peer that announces a
// gigantic payload length is dropped rather than allocated for.
const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;

function acceptValueFor(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeFrame(opcode, payload, masked) {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 65536) {
    headerLength += 8;
  } else if (length > 125) {
    headerLength += 2;
  }
  if (masked) {
    headerLength += 4;
  }

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | opcode; // FIN + opcode; we never fragment on send.

  let offset = 2;
  if (length >= 65536) {
    frame[1] = 127;
    // Node cannot express a 64-bit length in one write, and we cap messages far
    // below 2^32 anyway, so the high word is always zero.
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(length, 6);
    offset = 10;
  } else if (length > 125) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = length;
  }

  if (masked) {
    frame[1] |= 0x80;
    const maskKey = randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < length; index += 1) {
      frame[offset + index] = payload[index] ^ maskKey[index & 3];
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

// A parsed message plus the machinery to reassemble fragments. Kept as a plain
// object rather than a class because the channel owns exactly one of them.
function createParserState() {
  return {
    buffered: [],
    bufferedBytes: 0,
    fragments: [],
    fragmentBytes: 0,
    fragmentOpcode: null,
  };
}

class WebSocketChannel extends EventEmitter {
  constructor(socket, { isServer, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES, head = null }) {
    super();
    this.socket = socket;
    this.isServer = Boolean(isServer);
    this.maxMessageBytes = maxMessageBytes;
    this.closed = false;
    this.closeSent = false;
    this.started = false;
    this.head = head && head.length > 0 ? head : null;
    this.state = createParserState();

    // Only the non-data events are wired here. Reading is deferred to start()
    // so the first frame cannot be emitted before the caller has subscribed —
    // see the comment there.
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#finish());
  }

  // Begins reading. A server can send its first frame in the very same TCP
  // segment as the 101 response, in which case those bytes arrive as the
  // upgrade `head` rather than through 'data'. Attaching the reader in the
  // constructor would emit that frame synchronously, before the code awaiting
  // connect() ever gets to add a 'message' listener, and the message would be
  // dropped. Leaving the socket paused until the consumer is ready removes the
  // race entirely.
  start() {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    if (this.head) {
      // Pushed to the front of the paused socket buffer so it is read before
      // anything that arrived after it.
      this.socket.unshift(this.head);
      this.head = null;
    }
    this.socket.on('data', (chunk) => this.#onData(chunk));
  }

  get writableBufferedBytes() {
    return this.socket.writableLength;
  }

  send(payload, { binary = true } = {}) {
    if (this.closed || this.closeSent) {
      return false;
    }
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const opcode = binary ? OPCODE.BINARY : OPCODE.TEXT;
    // Clients must mask, servers must not (RFC 6455 §5.1).
    return this.socket.write(encodeFrame(opcode, buffer, !this.isServer));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.closed || this.closeSent) {
      return;
    }
    this.socket.write(encodeFrame(OPCODE.PING, payload, !this.isServer));
  }

  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) {
      return;
    }
    this.closeSent = true;
    const reasonBuffer = Buffer.from(reason, 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload, !this.isServer));
    } catch {
      // The socket is already gone; #finish() will run from its 'close' event.
    }
    // Do not wait forever for the peer's close echo.
    this.socket.end();
  }

  destroy() {
    this.closeSent = true;
    this.socket.destroy();
  }

  #fail(error) {
    if (this.closed) {
      return;
    }
    // A socket error before anything subscribed must not become an uncaught
    // exception; the close that follows is enough to unblock the caller.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.socket.destroy();
  }

  #finish() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit('close');
  }

  #onData(chunk) {
    const state = this.state;
    state.buffered.push(chunk);
    state.bufferedBytes += chunk.length;

    // Frames arrive split across TCP segments, so parse whatever is complete and
    // keep the remainder for the next chunk.
    for (;;) {
      const buffer = state.buffered.length === 1
        ? state.buffered[0]
        : Buffer.concat(state.buffered, state.bufferedBytes);
      state.buffered = [buffer];

      const frame = this.#tryParseFrame(buffer);
      if (frame === null) {
        return;
      }
      if (frame === false) {
        return; // Parser already failed the channel.
      }

      const rest = buffer.subarray(frame.consumed);
      state.buffered = rest.length > 0 ? [rest] : [];
      state.bufferedBytes = rest.length;

      if (!this.#handleFrame(frame)) {
        return;
      }
      if (state.bufferedBytes === 0) {
        return;
      }
    }
  }

  // Returns null when more bytes are needed, false when the channel was failed,
  // and a frame descriptor otherwise.
  #tryParseFrame(buffer) {
    if (buffer.length < 2) {
      return null;
    }

    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) {
        return null;
      }
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) {
        return null;
      }
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      if (high !== 0) {
        this.#fail(new Error('WebSocket frame exceeds the supported length'));
        return false;
      }
      payloadLength = low;
      offset += 8;
    }

    if (payloadLength > this.maxMessageBytes) {
      this.#fail(new Error(`WebSocket frame of ${payloadLength} bytes exceeds the limit`));
      return false;
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) {
        return null;
      }
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length < offset + payloadLength) {
      return null;
    }

    // Copy before unmasking: the source buffer is shared with the tail we keep.
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
    if (maskKey) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskKey[index & 3];
      }
    }

    return { fin, opcode, payload, consumed: offset + payloadLength };
  }

  // Returns false when parsing must stop (channel closed or failed).
  #handleFrame(frame) {
    const state = this.state;

    switch (frame.opcode) {
      case OPCODE.PING:
        if (!this.closeSent) {
          this.socket.write(encodeFrame(OPCODE.PONG, frame.payload, !this.isServer));
        }
        return true;

      case OPCODE.PONG:
        this.emit('pong', frame.payload);
        return true;

      case OPCODE.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        this.emit('closing', code, reason);
        if (!this.closeSent) {
          this.closeSent = true;
          try {
            this.socket.write(encodeFrame(OPCODE.CLOSE, frame.payload, !this.isServer));
          } catch {
            // Peer is gone; the socket close event finishes the channel.
          }
        }
        this.socket.end();
        return false;
      }

      case OPCODE.CONTINUATION: {
        if (state.fragmentOpcode === null) {
          this.#fail(new Error('WebSocket continuation frame without a start frame'));
          return false;
        }
        state.fragments.push(frame.payload);
        state.fragmentBytes += frame.payload.length;
        if (state.fragmentBytes > this.maxMessageBytes) {
          this.#fail(new Error('WebSocket message exceeds the limit'));
          return false;
        }
        if (!frame.fin) {
          return true;
        }
        const payload = Buffer.concat(state.fragments, state.fragmentBytes);
        const opcode = state.fragmentOpcode;
        state.fragments = [];
        state.fragmentBytes = 0;
        state.fragmentOpcode = null;
        this.emit('message', payload, opcode === OPCODE.BINARY);
        return true;
      }

      case OPCODE.TEXT:
      case OPCODE.BINARY: {
        if (state.fragmentOpcode !== null) {
          this.#fail(new Error('WebSocket data frame interleaved with a fragmented message'));
          return false;
        }
        if (!frame.fin) {
          state.fragmentOpcode = frame.opcode;
          state.fragments = [frame.payload];
          state.fragmentBytes = frame.payload.length;
          return true;
        }
        this.emit('message', frame.payload, frame.opcode === OPCODE.BINARY);
        return true;
      }

      default:
        this.#fail(new Error(`Unsupported WebSocket opcode 0x${frame.opcode.toString(16)}`));
        return false;
    }
  }
}

function connect(url, { headers = {}, handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS, maxMessageBytes } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Invalid WebSocket URL: ${url}`));
      return;
    }

    const secure = target.protocol === 'wss:' || target.protocol === 'https:';
    if (!secure && target.protocol !== 'ws:' && target.protocol !== 'http:') {
      reject(new Error(`Unsupported WebSocket scheme: ${target.protocol}`));
      return;
    }

    const key = randomBytes(16).toString('base64');
    const transport = secure ? https : http;
    const request = transport.request({
      protocol: secure ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      request.destroy();
      reject(new Error('WebSocket handshake timed out'));
    }, handshakeTimeoutMs);
    // A pending handshake must never hold the process open on its own.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    const failOnce = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    request.on('error', failOnce);

    request.on('response', (response) => {
      // A non-101 answer means the relay rejected us; surface its status rather
      // than a generic socket error.
      response.resume();
      failOnce(new Error(`WebSocket handshake failed with HTTP ${response.statusCode}`));
    });

    request.on('upgrade', (response, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);

      const expected = acceptValueFor(key);
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('WebSocket handshake returned an invalid accept key'));
        return;
      }

      socket.setNoDelay(true);
      const channel = new WebSocketChannel(socket, { isServer: false, maxMessageBytes, head });
      resolve(channel);
      // setImmediate rather than nextTick: the promise continuations that
      // attach the caller's listeners are microtasks, and nextTick would run
      // ahead of them.
      setImmediate(() => channel.start());
    });

    request.end();
  });
}

// Attaches a WebSocket endpoint to an existing http.Server. `onConnection`
// receives (channel, request); returning without calling it rejects the
// upgrade.
function attachServer(server, { path = null, onConnection, maxMessageBytes } = {}) {
  if (typeof onConnection !== 'function') {
    throw new TypeError('attachServer requires an onConnection callback');
  }

  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key'];
    const upgrade = `${request.headers.upgrade || ''}`.toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.destroy();
      return;
    }

    if (path !== null) {
      const requestPath = (request.url || '/').split('?')[0];
      if (requestPath !== path) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${acceptValueFor(key)}\r\n\r\n`,
    );

    const channel = new WebSocketChannel(socket, { isServer: true, maxMessageBytes, head });
    // onConnection subscribes synchronously, so reading can begin as soon as it
    // returns.
    onConnection(channel, request);
    channel.start();
  });
}

module.exports = {
  OPCODE,
  WebSocketChannel,
  acceptValueFor,
  attachServer,
  connect,
  encodeFrame,
};
