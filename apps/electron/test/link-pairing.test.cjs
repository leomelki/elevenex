const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CODE_PREFIX,
  createPairing,
  decodePairingCode,
  encodePairingCode,
  parseDirectEndpoint,
  redactPairing,
} = require('../link-pairing.cjs');

describe('pairing codes', () => {
  const relayPairing = () => createPairing({
    transport: 'relay',
    endpoint: 'wss://relay.example.com/link',
    label: 'Studio laptop',
  });

  it('round-trips a relay pairing', () => {
    const pairing = relayPairing();
    const decoded = decodePairingCode(encodePairingCode(pairing));

    assert.equal(decoded.transport, 'relay');
    assert.equal(decoded.pairId, pairing.pairId);
    assert.equal(decoded.label, 'Studio laptop');
    assert.ok(decoded.pairingKey.equals(pairing.pairingKey));
  });

  it('round-trips a direct pairing', () => {
    const pairing = createPairing({ transport: 'direct', endpoint: '192.168.1.24:11123' });
    const decoded = decodePairingCode(encodePairingCode(pairing));

    assert.equal(decoded.transport, 'direct');
    assert.deepEqual(parseDirectEndpoint(decoded.endpoint), { host: '192.168.1.24', port: 11123 });
  });

  it('mints a fresh key and id every time', () => {
    const first = relayPairing();
    const second = relayPairing();

    assert.notEqual(first.pairId, second.pairId);
    assert.ok(!first.pairingKey.equals(second.pairingKey), 'pairing keys must not repeat');
    assert.equal(first.pairingKey.length, 32);
  });

  it('rejects codes that are not ours', () => {
    assert.throws(() => decodePairingCode('hello'), /does not look like/i);
    assert.throws(() => decodePairingCode(`${CODE_PREFIX}not-base64-json`), /damaged/i);
  });

  it('rejects a code whose key is the wrong length', () => {
    const pairing = relayPairing();
    const payload = JSON.parse(
      Buffer.from(encodePairingCode(pairing).slice(CODE_PREFIX.length), 'base64').toString('utf8'),
    );
    payload.k = 'c2hvcnQ'; // "short"
    const tampered = `${CODE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;

    assert.throws(() => decodePairingCode(tampered), /damaged/i);
  });

  it('refuses an endpoint that is not a websocket URL', () => {
    assert.throws(
      () => createPairing({ transport: 'relay', endpoint: 'ftp://relay.example.com' }),
      /ws:\/\/ or wss:\/\//,
    );
  });

  it('keeps the key out of the redacted view', () => {
    const redacted = redactPairing(relayPairing());

    assert.equal(redacted.pairingKey, undefined);
    assert.ok(!JSON.stringify(redacted).includes('pairingKey'));
    assert.equal(redacted.transport, 'relay');
  });

  it('parses bracketed IPv6 direct endpoints', () => {
    assert.deepEqual(parseDirectEndpoint('[::1]:11123'), { host: '::1', port: 11123 });
  });
});
