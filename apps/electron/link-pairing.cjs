// Pairing codes.
//
// A code is the whole credential: it names the rendezvous, identifies the
// pairing, and carries the 32-byte key that authenticates the handshake and
// derives the session keys. Anyone holding it can reach the shared backend, so
// it is treated like a password — generated with a CSPRNG, shown once, and
// revocable by regenerating.
//
// The wire form is `EX1-<base64url(json)>`, which is copy-pasteable in one line
// and easy to render as a QR code later.

'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');

const CODE_PREFIX = 'EX1-';
const PAIRING_KEY_BYTES = 32;
const PAIR_ID_BYTES = 16;

const TRANSPORTS = new Set(['relay', 'direct']);

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  const normalized = `${value}`.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

function assertRelayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid relay URL: ${value}`);
  }
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Relay URL must be ws:// or wss://, got ${url.protocol}`);
  }
  return url.toString();
}

function assertDirectEndpoint(value) {
  const text = `${value}`.trim();
  // Accept `host:port`, including bracketed IPv6 literals.
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(text);
  if (!match) {
    throw new Error(`Direct endpoint must be host:port, got ${text}`);
  }
  const port = Number.parseInt(match[2], 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Direct endpoint has an invalid port: ${text}`);
  }
  return text;
}

function parseDirectEndpoint(endpoint) {
  const text = assertDirectEndpoint(endpoint);
  const separator = text.lastIndexOf(':');
  const rawHost = text.slice(0, separator);
  const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
  return { host, port: Number.parseInt(text.slice(separator + 1), 10) };
}

// `label` is display-only: it travels in the code so the connecting side can
// name the entry after the host machine instead of "Untitled".
function createPairing({ transport = 'relay', endpoint, label = '' } = {}) {
  if (!TRANSPORTS.has(transport)) {
    throw new Error(`Unsupported pairing transport: ${transport}`);
  }
  const normalizedEndpoint = transport === 'relay'
    ? assertRelayUrl(endpoint)
    : assertDirectEndpoint(endpoint);

  return {
    version: 1,
    transport,
    endpoint: normalizedEndpoint,
    pairId: randomBytes(PAIR_ID_BYTES).toString('hex'),
    pairingKey: randomBytes(PAIRING_KEY_BYTES),
    label: `${label}`.slice(0, 64),
  };
}

function encodePairingCode(pairing) {
  const payload = {
    v: 1,
    t: pairing.transport,
    u: pairing.endpoint,
    i: pairing.pairId,
    k: toBase64Url(pairing.pairingKey),
  };
  if (pairing.label) {
    payload.n = pairing.label;
  }
  return `${CODE_PREFIX}${toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))}`;
}

function decodePairingCode(code) {
  const text = `${code}`.trim();
  if (!text.startsWith(CODE_PREFIX)) {
    throw new Error('That does not look like an Elevenex pairing code.');
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(text.slice(CODE_PREFIX.length)).toString('utf8'));
  } catch {
    throw new Error('This pairing code is damaged — copy it again from the sharing device.');
  }

  if (!payload || payload.v !== 1) {
    throw new Error('This pairing code was made by an incompatible Elevenex version.');
  }
  if (!TRANSPORTS.has(payload.t)) {
    throw new Error('This pairing code uses an unknown transport.');
  }

  const pairingKey = fromBase64Url(payload.k || '');
  if (pairingKey.length !== PAIRING_KEY_BYTES) {
    throw new Error('This pairing code is damaged — copy it again from the sharing device.');
  }
  if (typeof payload.i !== 'string' || !/^[0-9a-f]{32}$/.test(payload.i)) {
    throw new Error('This pairing code is damaged — copy it again from the sharing device.');
  }

  return {
    version: 1,
    transport: payload.t,
    endpoint: payload.t === 'relay'
      ? assertRelayUrl(payload.u)
      : assertDirectEndpoint(payload.u),
    pairId: payload.i,
    pairingKey,
    label: typeof payload.n === 'string' ? payload.n.slice(0, 64) : '',
  };
}

function pairingKeysMatch(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

// Never let a pairing key reach a log line, an IPC payload bound for the
// renderer, or a saved-server record.
function redactPairing(pairing) {
  return {
    version: pairing.version,
    transport: pairing.transport,
    endpoint: pairing.endpoint,
    pairId: pairing.pairId,
    label: pairing.label,
  };
}

module.exports = {
  CODE_PREFIX,
  PAIRING_KEY_BYTES,
  PAIR_ID_BYTES,
  createPairing,
  decodePairingCode,
  encodePairingCode,
  pairingKeysMatch,
  parseDirectEndpoint,
  redactPairing,
};
