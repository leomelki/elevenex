const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setImmediate } = require('node:timers');
const { webAuthnRequest, webAuthnOptions } = require('../dist/browser/webauthn-validation');
const { RemoteWebAuthn } = require('../dist/browser/remote-webauthn');
const pending = () => ({ id: randomUUID(), origin: 'https://login.example.test', operation: 'get' });
const options = request => ({ ...request, optionsJson: JSON.stringify({ challenge: 'AQ', rpId: 'example.test', extensions: { remoteDesktopClientOverride: { origin: request.origin, sameOriginWithAncestors: true } } }) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('authentication delegation is bounded, origin-confined and strips the remote override', () => {
  const request = pending();
  assert.equal(JSON.parse(webAuthnOptions(options(request), request).optionsJson).extensions.remoteDesktopClientOverride, undefined);
  for (const origin of ['http://example.test', 'https://example.test/path', 'https://alice:password@example.test', 'file:///tmp/site', 'https://example.test#fragment']) assert.throws(() => webAuthnRequest({ ...request, origin }));
  for (const value of [
    { ...options(request), id: randomUUID() }, { ...options(request), operation: 'create' }, { ...options(request), origin: 'https://other.test' },
    { ...options(request), optionsJson: ' '.repeat(65537) },
    { ...request, optionsJson: JSON.stringify({ extensions: { remoteDesktopClientOverride: { origin: request.origin, sameOriginWithAncestors: false } } }) },
    { ...request, optionsJson: JSON.stringify({ extensions: { remoteDesktopClientOverride: { origin: request.origin, sameOriginWithAncestors: true }, remoteClientDataJSON: '{}' } }) },
  ]) assert.throws(() => webAuthnOptions(value, request));
});

test('repeated snapshots prompt once and an uncertain completion is never replayed', async () => {
  const request = pending(), sent = [];
  let prompts = 0;
  const relay = new RemoteWebAuthn({}, { run: async () => { prompts++; return { responseJson: '{}' }; } }, () => true, async body => {
    sent.push(body); if (body.result) throw new Error('Interrupted response'); return options(request);
  });
  relay.sync(request); relay.sync(request); await tick(); relay.sync(request); await tick();
  assert.equal(prompts, 1);
  // One completion only: never send another result after an unknown outcome.
  assert.equal(sent.filter(item => item.result).length, 1);
});

test('cancellation during option retrieval cannot open native authentication', async () => {
  const request = pending(); let resolve, prompts = 0, writes = 0;
  const relay = new RemoteWebAuthn({}, { run: async () => { prompts++; } }, () => true, body => {
    if (body.result) writes++;
    return new Promise(done => { resolve = done; });
  });
  relay.sync(request); relay.sync(); resolve(options(request)); await tick();
  assert.equal(prompts, 0); assert.equal(writes, 0);
});

test('viewer loss aborts native UI and suppresses a late credential response', async () => {
  const request = pending(); let finish, signal, current = true, writes = 0;
  const relay = new RemoteWebAuthn({}, { run: (_parent, _options, inputSignal) => { signal = inputSignal; return new Promise(resolve => { finish = resolve; }); } }, () => current, async body => { if (body.result) writes++; return options(request); });
  relay.sync(request); await tick(); current = false; relay.sync(request);
  assert.equal(signal.aborted, true);
  finish({ responseJson: '{}' }); await tick();
  assert.equal(writes, 0);
});
