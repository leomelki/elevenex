// Stream multiplexer for the remote link.
//
// The link carries one forwarded TCP connection per stream, exactly the way
// `ssh -L` carries one `direct-tcpip` channel per forwarded connection — so the
// frontend's HTTP calls, all the WebSocket gateways and the PTY streams ride a
// single underlying connection without any of them being parsed. Nothing above
// layer 4 is understood here.
//
// The underlying channel is *message oriented* (a WebSocket, or an AEAD frame
// stream), so every mux frame is exactly one message and there is no byte-stream
// reassembly to do. That is the main reason this is small.
//
// Flow control is per stream and credit based, like yamux: a sender may have
// `sendWindow` unacknowledged bytes outstanding, and the receiver returns credit
// only as the consumer actually drains the data. Without it a fast PTY or a
// large diff would buffer without bound on the receiving side.

'use strict';

const { Duplex } = require('node:stream');
const { EventEmitter } = require('node:events');

const PROTOCOL_VERSION = 1;
const HEADER_BYTES = 12;

const FRAME = {
  DATA: 0,
  WINDOW_UPDATE: 1,
  PING: 2,
  GOAWAY: 3,
};

const FLAG = {
  SYN: 0x1,
  ACK: 0x2,
  FIN: 0x4,
  RST: 0x8,
};

// 1 MiB keeps a single stream from stalling on a long link — at 100 ms RTT a
// 256 KiB window would cap one transfer around 20 Mbps, which is the classic
// reason tunnelled connections feel slow transcontinentally.
const DEFAULT_INITIAL_WINDOW = 1024 * 1024;
// Bounds per-frame allocation and keeps one big write from monopolising the
// shared connection ahead of an interactive keystroke.
const DEFAULT_MAX_FRAME_BYTES = 128 * 1024;
// A misbehaving or hostile peer must not be able to make us allocate a stream
// object per frame.
const DEFAULT_MAX_CONCURRENT_STREAMS = 512;

function encodeHeader(type, flags, streamId, value) {
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header[0] = PROTOCOL_VERSION;
  header[1] = type;
  header.writeUInt16BE(flags, 2);
  header.writeUInt32BE(streamId, 4);
  header.writeUInt32BE(value, 8);
  return header;
}

function encodeFrame(type, flags, streamId, value, payload = null) {
  const header = encodeHeader(type, flags, streamId, value);
  if (!payload || payload.length === 0) {
    return header;
  }
  return Buffer.concat([header, payload], HEADER_BYTES + payload.length);
}

function decodeFrame(message) {
  if (message.length < HEADER_BYTES) {
    return null;
  }
  const version = message[0];
  if (version !== PROTOCOL_VERSION) {
    return null;
  }
  return {
    type: message[1],
    flags: message.readUInt16BE(2),
    streamId: message.readUInt32BE(4),
    value: message.readUInt32BE(8),
    payload: message.subarray(HEADER_BYTES),
  };
}

class MuxStream extends Duplex {
  constructor(session, streamId, { initialWindow, maxFrameBytes }) {
    super({ allowHalfOpen: true });
    this.session = session;
    this.streamId = streamId;
    this.maxFrameBytes = maxFrameBytes;

    // Bytes we may still send before the peer returns credit.
    this.sendWindow = initialWindow;
    // Credit we owe the peer, batched so a chatty stream does not emit a window
    // update per 16-byte keystroke.
    this.creditWindow = initialWindow;
    this.pendingCredit = 0;

    this.outbound = [];
    this.outboundBytes = 0;
    this.writeCallback = null;
    this.finPending = false;
    this.finSent = false;
    this.resetSent = false;

    this.inbound = [];
    this.readableBlocked = false;
    this.remoteEnded = false;
    // Set once the peer has seen this stream, so a local destroy knows whether a
    // reset is worth sending.
    this.acknowledged = false;
  }

  _read() {
    this.readableBlocked = false;
    this.#flushInbound();
  }

  _write(chunk, _encoding, callback) {
    if (this.destroyed || this.finSent) {
      callback(new Error('Cannot write to a closed link stream'));
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length > 0) {
      this.outbound.push(buffer);
      this.outboundBytes += buffer.length;
    }
    // Node issues one _write at a time and waits for the callback, so a single
    // slot is enough. It is invoked once the window has let everything out.
    this.writeCallback = callback;
    this.pump();
  }

  _final(callback) {
    this.finPending = true;
    this.pump();
    callback();
  }

  _destroy(error, callback) {
    // A destroy before a clean FIN means the local TCP side aborted; tell the
    // peer so it can abort its own side rather than wait on a half-open stream.
    if (!this.finSent && !this.resetSent && this.session.isOpen()) {
      this.resetSent = true;
      this.session.sendFrame(FRAME.DATA, FLAG.RST, this.streamId, 0, null);
    }
    this.session.forgetStream(this.streamId);
    callback(error);
  }

  // Moves as much queued data as the send window allows onto the wire.
  pump() {
    while (this.outboundBytes > 0 && this.sendWindow > 0) {
      const take = Math.min(this.maxFrameBytes, this.sendWindow, this.outboundBytes);
      const payload = this.#takeOutbound(take);
      const flags = this.acknowledged ? 0 : FLAG.SYN;
      this.acknowledged = true;
      this.sendWindow -= payload.length;
      this.session.sendFrame(FRAME.DATA, flags, this.streamId, payload.length, payload);
    }

    if (this.outboundBytes === 0 && this.writeCallback) {
      const callback = this.writeCallback;
      this.writeCallback = null;
      callback();
    }

    if (this.finPending && this.outboundBytes === 0 && !this.finSent) {
      this.finSent = true;
      const flags = FLAG.FIN | (this.acknowledged ? 0 : FLAG.SYN);
      this.acknowledged = true;
      this.session.sendFrame(FRAME.DATA, flags, this.streamId, 0, null);
    }
  }

  #takeOutbound(byteCount) {
    const first = this.outbound[0];
    if (first.length <= byteCount) {
      this.outbound.shift();
      this.outboundBytes -= first.length;
      return first;
    }
    this.outbound[0] = first.subarray(byteCount);
    this.outboundBytes -= byteCount;
    return first.subarray(0, byteCount);
  }

  onWindowUpdate(delta) {
    this.sendWindow += delta;
    this.pump();
  }

  onData(payload) {
    if (payload.length === 0 || this.destroyed) {
      return;
    }
    this.inbound.push(payload);
    this.#flushInbound();
  }

  onRemoteEnd() {
    this.remoteEnded = true;
    this.#flushInbound();
  }

  onRemoteReset() {
    // The peer aborted. Surface it as an error so the local socket is destroyed
    // rather than being half-closed cleanly, which would look like a normal EOF
    // to an HTTP client and hide a truncated response.
    this.resetSent = true;
    this.destroy(new Error('Remote link stream was reset'));
  }

  // Credit is returned only as the readable side accepts data, so the peer's
  // window tracks real consumption rather than arrival.
  #flushInbound() {
    while (this.inbound.length > 0 && !this.readableBlocked) {
      const chunk = this.inbound.shift();
      const accepted = this.push(chunk);
      this.#returnCredit(chunk.length);
      if (!accepted) {
        this.readableBlocked = true;
      }
    }

    if (this.remoteEnded && this.inbound.length === 0) {
      this.remoteEnded = false;
      this.push(null);
    }
  }

  #returnCredit(byteCount) {
    this.pendingCredit += byteCount;
    // Batch at half the window: frequent enough that the sender never stalls,
    // rare enough that a keystroke stream does not double its frame count.
    if (this.pendingCredit * 2 >= this.creditWindow && this.session.isOpen()) {
      const delta = this.pendingCredit;
      this.pendingCredit = 0;
      this.session.sendFrame(FRAME.WINDOW_UPDATE, 0, this.streamId, delta, null);
    }
  }
}

class MuxSession extends EventEmitter {
  constructor(channel, options = {}) {
    super();
    this.channel = channel;
    this.initialWindow = options.initialWindow ?? DEFAULT_INITIAL_WINDOW;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxConcurrentStreams = options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS;
    this.streams = new Map();
    this.closed = false;

    // yamux's convention: the side that dialled owns odd stream ids, so the two
    // ends can both open streams without ever colliding.
    this.nextStreamId = options.isInitiator ? 1 : 2;

    channel.on('message', (message, isBinary) => {
      if (isBinary === false) {
        return; // Control text from the relay is not ours to interpret.
      }
      this.#onMessage(message);
    });
    channel.on('close', () => this.close());
    channel.on('error', (error) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      this.close();
    });
  }

  isOpen() {
    return !this.closed;
  }

  sendFrame(type, flags, streamId, value, payload) {
    if (this.closed) {
      return;
    }
    this.channel.send(encodeFrame(type, flags, streamId, value, payload), { binary: true });
  }

  open() {
    if (this.closed) {
      throw new Error('Cannot open a stream on a closed link session');
    }
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = new MuxStream(this, streamId, {
      initialWindow: this.initialWindow,
      maxFrameBytes: this.maxFrameBytes,
    });
    this.streams.set(streamId, stream);
    return stream;
  }

  forgetStream(streamId) {
    this.streams.delete(streamId);
  }

  close() {
    if (this.closed) {
      return;
    }
    // Tell the peer before the transport goes, so its session ends on a GOAWAY
    // rather than on a socket error it has to guess the meaning of. Best effort:
    // if the channel is already down this is a no-op.
    this.sendFrame(FRAME.GOAWAY, 0, 0, 0, null);
    this.closed = true;
    for (const stream of [...this.streams.values()]) {
      // In-flight streams must fail, not end cleanly: a truncated response that
      // looks like a normal EOF is indistinguishable from a complete one to an
      // HTTP client. But a stream nobody subscribed to would turn that into an
      // uncaught exception, so it is torn down silently instead.
      if (stream.listenerCount('error') > 0) {
        stream.destroy(new Error('Remote link closed'));
      } else {
        stream.destroy();
      }
    }
    this.streams.clear();
    // The session owns the channel's lifetime. Without this the socket
    // underneath stays open after the session ends, which leaks the connection
    // and makes a graceful server shutdown wait forever on it.
    try {
      this.channel.close();
    } catch {
      // Already torn down.
    }
    this.emit('close');
  }

  #onMessage(message) {
    const frame = decodeFrame(message);
    if (!frame) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', new Error('Malformed link frame'));
      }
      this.close();
      return;
    }

    if (frame.type === FRAME.GOAWAY) {
      this.close();
      return;
    }

    if (frame.type === FRAME.PING) {
      if ((frame.flags & FLAG.ACK) === 0) {
        this.sendFrame(FRAME.PING, FLAG.ACK, 0, frame.value, null);
      }
      return;
    }

    let stream = this.streams.get(frame.streamId);

    if (!stream) {
      if ((frame.flags & FLAG.SYN) === 0) {
        // Late frames for a stream we already tore down are expected; only a
        // reset needs answering, and even that is pointless once it is gone.
        return;
      }
      if (this.streams.size >= this.maxConcurrentStreams) {
        this.sendFrame(FRAME.DATA, FLAG.RST, frame.streamId, 0, null);
        return;
      }
      stream = new MuxStream(this, frame.streamId, {
        initialWindow: this.initialWindow,
        maxFrameBytes: this.maxFrameBytes,
      });
      // The peer has evidently seen this id, so our first frame back needs no SYN.
      stream.acknowledged = true;
      this.streams.set(frame.streamId, stream);
      this.emit('stream', stream);
    }

    if (frame.type === FRAME.WINDOW_UPDATE) {
      stream.onWindowUpdate(frame.value);
      return;
    }

    if ((frame.flags & FLAG.RST) !== 0) {
      stream.onRemoteReset();
      return;
    }

    if (frame.payload.length > 0) {
      stream.onData(frame.payload);
    }

    if ((frame.flags & FLAG.FIN) !== 0) {
      stream.onRemoteEnd();
    }
  }
}

function createMuxSession(channel, options) {
  return new MuxSession(channel, options);
}

module.exports = {
  DEFAULT_INITIAL_WINDOW,
  DEFAULT_MAX_FRAME_BYTES,
  FLAG,
  FRAME,
  HEADER_BYTES,
  MuxSession,
  MuxStream,
  PROTOCOL_VERSION,
  createMuxSession,
  decodeFrame,
  encodeFrame,
};
