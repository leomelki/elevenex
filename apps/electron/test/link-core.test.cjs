const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { describe, it } = require('node:test');

const { createMuxSession } = require('../link-mux.cjs');
const { SecureChannel } = require('../link-secure.cjs');

// An in-memory stand-in for a WebSocket: message oriented, ordered, reliable,
// and asynchronous, which is everything the layers above rely on.
function createChannelPair() {
  const left = new EventEmitter();
  const right = new EventEmitter();

  const wire = (from, to) => {
    from.send = (message, _options) => {
      if (from.closed || to.closed) {
        return false;
      }
      const copy = Buffer.from(message);
      setImmediate(() => {
        if (!to.closed) {
          to.emit('message', copy, true);
        }
      });
      return true;
    };
    from.close = () => {
      if (from.closed) {
        return;
      }
      from.closed = true;
      setImmediate(() => {
        from.emit('close');
        if (!to.closed) {
          to.closed = true;
          to.emit('close');
        }
      });
    };
  };

  left.closed = false;
  right.closed = false;
  wire(left, right);
  wire(right, left);
  return { left, right };
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('link mux', () => {
  it('carries a stream end to end', async () => {
    const { left, right } = createChannelPair();
    const client = createMuxSession(left, { isInitiator: true });
    const server = createMuxSession(right, { isInitiator: false });

    const accepted = new Promise((resolve) => server.once('stream', resolve));
    const stream = client.open();
    stream.end(Buffer.from('hello link'));

    const remote = await accepted;
    assert.equal((await collect(remote)).toString(), 'hello link');
  });

  it('is bidirectional and preserves order across many writes', async () => {
    const { left, right } = createChannelPair();
    const client = createMuxSession(left, { isInitiator: true });
    const server = createMuxSession(right, { isInitiator: false });

    server.on('stream', (stream) => {
      // Echo with a marker so both directions are exercised.
      stream.on('data', (chunk) => stream.write(Buffer.concat([Buffer.from('>'), chunk])));
      stream.on('end', () => stream.end());
    });

    const stream = client.open();
    const received = collect(stream);
    for (let index = 0; index < 200; index += 1) {
      stream.write(Buffer.from(`${index},`));
    }
    stream.end();

    const expected = Array.from({ length: 200 }, (_, index) => `>${index},`).join('');
    assert.equal((await received).toString(), expected);
  });

  it('keeps concurrent streams independent', async () => {
    const { left, right } = createChannelPair();
    const client = createMuxSession(left, { isInitiator: true });
    const server = createMuxSession(right, { isInitiator: false });

    server.on('stream', (stream) => {
      stream.pipe(stream); // echo
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const stream = client.open();
        const done = collect(stream);
        stream.end(Buffer.from(`payload-${index}`));
        return done;
      }),
    );

    results.forEach((buffer, index) => {
      assert.equal(buffer.toString(), `payload-${index}`);
    });
  });

  it('moves a payload larger than the flow-control window', async () => {
    const { left, right } = createChannelPair();
    // A window far smaller than the payload forces many window updates, which is
    // the path that stalls if credit accounting is wrong.
    const options = { initialWindow: 16 * 1024, maxFrameBytes: 4 * 1024 };
    const client = createMuxSession(left, { isInitiator: true, ...options });
    const server = createMuxSession(right, { isInitiator: false, ...options });

    const payload = randomBytes(1024 * 1024);
    const accepted = new Promise((resolve) => server.once('stream', resolve));

    const stream = client.open();
    stream.end(payload);

    const remote = await accepted;
    const received = await collect(remote);
    assert.equal(received.length, payload.length);
    assert.ok(received.equals(payload));
  });

  it('propagates a reset as an error rather than a clean end', async () => {
    const { left, right } = createChannelPair();
    const client = createMuxSession(left, { isInitiator: true });
    const server = createMuxSession(right, { isInitiator: false });

    const accepted = new Promise((resolve) => server.once('stream', resolve));
    const stream = client.open();
    stream.write(Buffer.from('partial'));

    const remote = await accepted;
    const failure = new Promise((resolve) => remote.once('error', resolve));
    stream.once('error', () => {}); // The local abort surfaces here too.
    stream.destroy(new Error('aborted'));

    const error = await failure;
    assert.match(error.message, /reset/i);
  });

  it('tears every stream down when the channel closes', async () => {
    const { left, right } = createChannelPair();
    const client = createMuxSession(left, { isInitiator: true });
    createMuxSession(right, { isInitiator: false });

    const stream = client.open();
    stream.write(Buffer.from('x'));
    const failure = new Promise((resolve) => stream.once('error', resolve));

    left.close();
    const error = await failure;
    assert.match(error.message, /closed/i);
  });
});

describe('link secure channel', () => {
  const pairingKey = randomBytes(32);

  async function handshakePair(keyA = pairingKey, keyB = pairingKey) {
    const { left, right } = createChannelPair();
    const initiator = new SecureChannel(left, { pairingKey: keyA, isInitiator: true });
    const responder = new SecureChannel(right, { pairingKey: keyB, isInitiator: false });
    return { initiator, responder };
  }

  it('completes a handshake and encrypts both directions', async () => {
    const { initiator, responder } = await handshakePair();
    await Promise.all([initiator.whenReady(), responder.whenReady()]);

    const toResponder = new Promise((resolve) => responder.once('message', resolve));
    initiator.send(Buffer.from('client says hi'));
    assert.equal((await toResponder).toString(), 'client says hi');

    const toInitiator = new Promise((resolve) => initiator.once('message', resolve));
    responder.send(Buffer.from('host says hi'));
    assert.equal((await toInitiator).toString(), 'host says hi');
  });

  it('rejects a peer holding a different pairing key', async () => {
    const { initiator, responder } = await handshakePair(pairingKey, randomBytes(32));
    await assert.rejects(initiator.whenReady(), /pairing code does not match/);
    await assert.rejects(responder.whenReady(), /pairing code does not match/);
  });

  it('never puts plaintext on the wire', async () => {
    const { left, right } = createChannelPair();
    const seen = [];
    const originalSend = left.send;
    left.send = (message, options) => {
      seen.push(Buffer.from(message));
      return originalSend(message, options);
    };

    const initiator = new SecureChannel(left, { pairingKey, isInitiator: true });
    const responder = new SecureChannel(right, { pairingKey, isInitiator: false });
    await Promise.all([initiator.whenReady(), responder.whenReady()]);

    const secret = 'attacker-must-not-read-this';
    const delivered = new Promise((resolve) => responder.once('message', resolve));
    initiator.send(Buffer.from(secret));
    await delivered;

    for (const frame of seen) {
      assert.ok(!frame.toString('latin1').includes(secret), 'plaintext appeared on the wire');
    }
  });

  it('rejects a reflected handshake', async () => {
    // A malicious relay echoing our own hello back must not yield a session.
    const channel = new EventEmitter();
    channel.closed = false;
    channel.close = () => {
      channel.closed = true;
      channel.emit('close');
    };
    channel.send = (message) => {
      setImmediate(() => channel.emit('message', Buffer.from(message), true));
      return true;
    };

    const secure = new SecureChannel(channel, { pairingKey, isInitiator: true });
    await assert.rejects(secure.whenReady(), /same role|reflected/i);
  });

  it('carries a mux session over the encrypted channel', async () => {
    const { initiator, responder } = await handshakePair();
    await Promise.all([initiator.whenReady(), responder.whenReady()]);

    const client = createMuxSession(initiator, { isInitiator: true });
    const server = createMuxSession(responder, { isInitiator: false });

    server.on('stream', (stream) => stream.pipe(stream));

    const stream = client.open();
    const received = collect(stream);
    stream.end(Buffer.from('through the tunnel'));
    assert.equal((await received).toString(), 'through the tunnel');
  });
});
