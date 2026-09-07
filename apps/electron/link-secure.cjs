// End-to-end encryption for the remote link.
//
// The relay splices two sockets together and is otherwise untrusted: it sees
// only ciphertext, and it cannot impersonate either end because the handshake is
// authenticated by the pre-shared pairing key. That property is what lets the
// pairing key double as the authorization check — the backend behind this link
// has no auth of its own, so possession of the key *is* the credential, and a
// relay operator (or anyone who guesses a pairing id) gets nothing.
//
// Handshake, both sides symmetric:
//   1. exchange HELLO {version, role, ephemeral X25519 public key, nonce}
//   2. shared = X25519(own ephemeral private, peer ephemeral public)
//   3. keys   = HKDF(ikm = shared, salt = pairing key, info = transcript hash)
//   4. exchange CONFIRM = HMAC(confirm key, role || transcript hash)
//
// Step 3 is what binds the pairing key in: without it an attacker completes the
// Diffie-Hellman but derives different keys, and step 4 fails. Ephemeral keys
// give forward secrecy — a leaked pairing key does not decrypt past sessions.

'use strict';

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const { EventEmitter } = require('node:events');

const PROTOCOL_VERSION = 1;
const ROLE_INITIATOR = 0;
const ROLE_RESPONDER = 1;

const PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const HELLO_BYTES = 2 + PUBLIC_KEY_BYTES + NONCE_BYTES;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const COUNTER_BYTES = 8;
const CONFIRM_BYTES = 32;

const HKDF_INFO_PREFIX = Buffer.from('elevenex-link-v1', 'utf8');
const CONFIRM_INFO = Buffer.from('elevenex-link-v1-confirm', 'utf8');

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;

// DER prefix for an X25519 SubjectPublicKeyInfo. Node exports and imports public
// keys as structured DER, but the wire format is the bare 32-byte point, so the
// prefix is added and stripped here.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function exportRawPublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - PUBLIC_KEY_BYTES));
}

function importRawPublicKey(raw) {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw], X25519_SPKI_PREFIX.length + raw.length),
    format: 'der',
    type: 'spki',
  });
}

function hkdf(sharedSecret, pairingKey, info, byteLength) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, pairingKey, info, byteLength));
}

function buildHello(role, publicKey, nonce) {
  const hello = Buffer.allocUnsafe(HELLO_BYTES);
  hello[0] = PROTOCOL_VERSION;
  hello[1] = role;
  publicKey.copy(hello, 2);
  nonce.copy(hello, 2 + PUBLIC_KEY_BYTES);
  return hello;
}

function parseHello(message) {
  if (message.length !== HELLO_BYTES) {
    throw new Error('Malformed link handshake message');
  }
  if (message[0] !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported link protocol version ${message[0]}`);
  }
  const role = message[1];
  if (role !== ROLE_INITIATOR && role !== ROLE_RESPONDER) {
    throw new Error('Invalid link handshake role');
  }
  return {
    role,
    publicKey: Buffer.from(message.subarray(2, 2 + PUBLIC_KEY_BYTES)),
    nonce: Buffer.from(message.subarray(2 + PUBLIC_KEY_BYTES)),
  };
}

function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

// Wraps a message channel (a WebSocket, or the framed TCP channel) and exposes
// the same shape, so MuxSession cannot tell the difference.
class SecureChannel extends EventEmitter {
  constructor(channel, { pairingKey, isInitiator, handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS }) {
    super();
    if (!Buffer.isBuffer(pairingKey) || pairingKey.length !== KEY_BYTES) {
      throw new TypeError(`Pairing key must be ${KEY_BYTES} bytes`);
    }

    this.channel = channel;
    this.pairingKey = pairingKey;
    this.role = isInitiator ? ROLE_INITIATOR : ROLE_RESPONDER;
    this.closed = false;
    this.ready = false;
    this.phase = 'hello';

    this.sendKey = null;
    this.receiveKey = null;
    this.sendCounter = 0n;
    this.receiveCounter = 0n;
    this.expectedConfirm = null;

    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    this.privateKey = privateKey;
    this.publicKeyRaw = exportRawPublicKey(publicKey);
    this.nonce = randomBytes(NONCE_BYTES);
    this.hello = buildHello(this.role, this.publicKeyRaw, this.nonce);

    this.handshakeComplete = new Promise((resolve, reject) => {
      this.resolveHandshake = resolve;
      this.rejectHandshake = reject;
    });
    // Nothing else consumes this promise when the caller only awaits `ready`,
    // so keep an inert catch on it to avoid an unhandled rejection warning.
    this.handshakeComplete.catch(() => {});

    this.handshakeTimer = setTimeout(() => {
      this.#fail(new Error('Link handshake timed out'));
    }, handshakeTimeoutMs);
    if (typeof this.handshakeTimer.unref === 'function') {
      this.handshakeTimer.unref();
    }

    channel.on('message', (message, isBinary) => {
      if (isBinary === false) {
        return; // Relay control messages are text and handled elsewhere.
      }
      this.#onMessage(message);
    });
    channel.on('close', () => this.#onClosed());
    channel.on('error', (error) => this.#fail(error));

    channel.send(this.hello, { binary: true });
  }

  whenReady() {
    return this.handshakeComplete;
  }

  send(message, _options) {
    if (!this.ready || this.closed) {
      return false;
    }
    const payload = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const counter = this.sendCounter;
    this.sendCounter += 1n;

    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(counter, 4);

    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();

    const framed = Buffer.allocUnsafe(COUNTER_BYTES + ciphertext.length + TAG_BYTES);
    framed.writeBigUInt64BE(counter, 0);
    ciphertext.copy(framed, COUNTER_BYTES);
    tag.copy(framed, COUNTER_BYTES + ciphertext.length);

    return this.channel.send(framed, { binary: true });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.channel.close();
  }

  #fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    if (!this.ready) {
      this.rejectHandshake(error);
    }
    // A handshake failure happens before anything has had a chance to subscribe
    // — the caller is still awaiting whenReady(), which already carries the
    // reason. Emitting 'error' unconditionally would throw it as an uncaught
    // exception and take the process down on a mistyped pairing code.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.channel.close();
    this.emit('close');
  }

  #onClosed() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    if (!this.ready) {
      this.rejectHandshake(new Error('Link closed during handshake'));
    }
    this.emit('close');
  }

  #onMessage(message) {
    try {
      if (this.phase === 'hello') {
        this.#onHello(message);
        return;
      }
      if (this.phase === 'confirm') {
        this.#onConfirm(message);
        return;
      }
      this.#onSealed(message);
    } catch (error) {
      this.#fail(error);
    }
  }

  #onHello(message) {
    const peer = parseHello(message);

    // A relay that echoes our own hello back would otherwise have us complete a
    // Diffie-Hellman with ourselves. Both checks make that a hard failure.
    if (peer.role === this.role) {
      throw new Error('Link peer announced the same role');
    }
    if (equalBytes(peer.publicKey, this.publicKeyRaw)) {
      throw new Error('Link peer reflected our own handshake');
    }

    const sharedSecret = diffieHellman({
      privateKey: this.privateKey,
      publicKey: importRawPublicKey(peer.publicKey),
    });

    // Ordered by role rather than arrival, so both ends hash the same bytes.
    const transcript = this.role === ROLE_INITIATOR
      ? Buffer.concat([this.hello, message])
      : Buffer.concat([message, this.hello]);
    const transcriptHash = createHash('sha256').update(transcript).digest();

    const info = Buffer.concat([HKDF_INFO_PREFIX, transcriptHash]);
    const keyMaterial = hkdf(sharedSecret, this.pairingKey, info, KEY_BYTES * 2);
    const initiatorToResponder = keyMaterial.subarray(0, KEY_BYTES);
    const responderToInitiator = keyMaterial.subarray(KEY_BYTES);

    if (this.role === ROLE_INITIATOR) {
      this.sendKey = initiatorToResponder;
      this.receiveKey = responderToInitiator;
    } else {
      this.sendKey = responderToInitiator;
      this.receiveKey = initiatorToResponder;
    }

    const confirmKey = hkdf(sharedSecret, this.pairingKey, CONFIRM_INFO, KEY_BYTES);
    const confirmFor = (role) => createHmac('sha256', confirmKey)
      .update(Buffer.from([role]))
      .update(transcriptHash)
      .digest();

    this.expectedConfirm = confirmFor(peer.role);
    this.phase = 'confirm';
    this.channel.send(confirmFor(this.role), { binary: true });
  }

  #onConfirm(message) {
    if (message.length !== CONFIRM_BYTES || !equalBytes(message, this.expectedConfirm)) {
      // Wrong pairing key, or an active attacker between the two ends.
      throw new Error('Link peer failed authentication — the pairing code does not match');
    }
    this.expectedConfirm = null;
    this.phase = 'sealed';
    this.ready = true;
    clearTimeout(this.handshakeTimer);
    this.resolveHandshake(this);
    this.emit('ready');
  }

  #onSealed(message) {
    if (message.length < COUNTER_BYTES + TAG_BYTES) {
      throw new Error('Truncated link frame');
    }
    const counter = message.readBigUInt64BE(0);
    // The channel underneath is ordered and reliable, so any gap or repeat is a
    // replay attempt or a bug, never normal reordering.
    if (counter !== this.receiveCounter) {
      throw new Error('Link frame arrived out of order');
    }
    this.receiveCounter += 1n;

    const ciphertext = message.subarray(COUNTER_BYTES, message.length - TAG_BYTES);
    const tag = message.subarray(message.length - TAG_BYTES);

    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(counter, 4);

    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    this.emit('message', plaintext, true);
  }
}

async function secureChannel(channel, options) {
  const secure = new SecureChannel(channel, options);
  await secure.whenReady();
  return secure;
}

module.exports = {
  CONFIRM_BYTES,
  HELLO_BYTES,
  KEY_BYTES,
  ROLE_INITIATOR,
  ROLE_RESPONDER,
  SecureChannel,
  secureChannel,
};
