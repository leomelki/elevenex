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

const prompt = require('../dist/browser/webauthn-prompt-view');
const promptDocumentModule = require('../dist/browser/webauthn-prompt-document');

test('the sheet names the exact origin, keeps lookalike hosts in punycode and offers retry on failure', () => {
  const signIn = prompt.confirmView({ id: 'a', origin: 'https://login.example.test:8443', operation: 'get' });
  assert.equal(signIn.title, 'Sign in to login.example.test:8443');
  assert.equal(signIn.origin, 'https://login.example.test:8443');
  assert.deepEqual(signIn.primary, { label: 'Continue', choice: 'continue' });
  assert.equal(prompt.confirmView({ id: 'a', origin: 'https://аpple.com', operation: 'create' }).title, 'Create a passkey for xn--pple-43d.com');
  assert.equal(prompt.waitingView(signIn, 'win32').title, 'Follow your device’s prompt');
  assert.equal(prompt.waitingView(signIn, 'other').primary, null);
  const timedOut = prompt.failedView(signIn, 'NotAllowedError');
  assert.deepEqual(timedOut.primary, { label: 'Try again', choice: 'retry' });
  assert.match(timedOut.note, /PIN/);
  assert.equal(prompt.failedView(signIn, 'SecurityError').note, '');
  const accounts = prompt.accountsView(signIn, [{ displayName: 'Léo', name: 'leo@example.test' }, { name: 'admin' }, {}]);
  assert.deepEqual(accounts.accounts.map(account => [account.name, account.detail, account.initial]), [['Léo', 'leo@example.test', 'L'], ['admin', '', 'A'], ['Account', '', 'A']]);
  assert.equal(prompt.accountsView(signIn, [{ displayName: 'x'.repeat(500) }]).accounts[0].name.length, 120);
});

test('sheet choices are allow-listed and accounts are bounded by the rendered list', () => {
  assert.equal(prompt.promptChoice('continue'), 'continue');
  assert.equal(prompt.promptChoice('retry'), 'retry');
  assert.equal(prompt.promptChoice('account:1', 2), 'account:1');
  for (const value of ['account:2', 'account:-1', 'account:1e3', 'Continue', undefined, 7, { choice: 'continue' }]) assert.equal(prompt.promptChoice(value, 2), 'cancel');
});

test('the sheet document is fixed, script-free and nonce-styled', () => {
  const tokens = ':root, [data-theme="light"] {\n  --surface-raised: #ffffff;\n}\n[data-theme="dark"] {\n  --surface-raised: #171d25;\n}';
  const { html, policy } = promptDocumentModule.promptDocument({ tokens, font: 'AAAA' }, 'n0nce');
  assert.match(policy, /script-src 'none'/);
  assert.match(policy, /style-src 'nonce-n0nce'/);
  assert.match(policy, /font-src data:/);
  assert.doesNotMatch(policy, /unsafe|\*/);
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i);
  assert.match(html, /<style nonce="n0nce">/);
  assert.match(html, /data:font\/woff2;base64,AAAA/);
  assert.equal(promptDocumentModule.promptDocument({ tokens }, 'n').html.includes('@font-face'), false);
  assert.equal(promptDocumentModule.promptBackground(tokens, false), '#ffffff');
  assert.equal(promptDocumentModule.promptBackground(tokens, true), '#171d25');
  // Views travel as JSON data into a fixed program, never as markup or code.
  const hostile = { ...prompt.accountsView({ id: 'a', origin: 'https://login.example.test', operation: 'get' }, [{ displayName: '</script><img src=x onerror=alert(1)>"); alert(1); ("' }]) };
  const program = promptDocumentModule.renderProgram(hostile);
  assert.deepEqual(JSON.parse(program.slice('window.elevenexPrompt.render('.length, -1)), JSON.parse(JSON.stringify(hostile)));
  new Function(promptDocumentModule.controllerProgram());
});
