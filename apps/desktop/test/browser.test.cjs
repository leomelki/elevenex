const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserDriverLease } = require('../dist/browser/driver');
const { browserUrl, command, agentCommand, layout, intersect, loopback } = require('../dist/browser/validation');
const { BrowserPersistence } = require('../dist/browser/persistence');
const id = '11111111-1111-4111-8111-111111111111';

test('user tabs require explicit handoff; takeover invalidates every previously queued generation', () => {
  const lease = new BrowserDriverLease('you');
  assert.throws(() => lease.assert(1));
  lease.handBack(2); const generation = lease.generation; lease.assert(generation);
  lease.takeOver(); assert.equal(lease.waiting, true); assert.throws(() => lease.assert(generation));
  lease.handBack(2); assert.throws(() => lease.assert(generation)); lease.assert(lease.generation, 2); assert.throws(() => lease.assert(lease.generation, 3));
  lease.takeOver(true); assert.equal(lease.driver, 'needs'); assert.throws(() => lease.assert(lease.generation));
});
test('navigation and tools reject privileged protocols, credentials, unknown fields and invalid coordinates', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'app://elevenex', 'https://user:pass@example.com', 'https://example.com/\nsecret']) assert.throws(() => browserUrl(url));
  for (const value of ['http://127.1', 'http://2130706433', 'http://localhost.', 'http://x.localhost', 'http://[::ffff:127.0.0.1]', 'http://127.0.0.2']) assert.equal(loopback(new URL(value)), true);
  assert.equal(loopback(new URL('https://example.com')), false);
  assert.equal(browserUrl('https://example.com/'), 'https://example.com/');
  assert.throws(() => command({ kind: 'open', url: 'https://example.com', preload: '/tmp/unsafe' }));
  assert.throws(() => agentCommand({ kind: 'type', tabId: id, generation: 1, text: 'secret' }));
  assert.throws(() => agentCommand({ kind: 'click', tabId: id, generation: 1, x: NaN, y: 2, step: 'Click' }));
  assert.throws(() => command({ kind: 'theme', tabId: id, theme: 'custom-css' }));
  assert.throws(() => layout({ sequence: 1, visible: true, reducedMotion: false, bounds: { x: 1, y: 1, width: Infinity, height: 1 } }));
  assert.deepEqual(intersect({ x: 90.2, y: 5, width: 200, height: 100 }, 120, 80), { x: 91, y: 5, width: 29, height: 75 });
});
test('task navigation persistence bounds tabs and strips credential-bearing query/fragment on restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ex-browser-test-'));
  try {
    const store = new BrowserPersistence(root);
    store.save('machine:task:1', { active: 0, tabs: [{ url: 'https://example.com/account?token=private#code', width: 'phone' }] });
    await store.flush();
    assert.deepEqual(await store.read('machine:task:1'), { active: 0, tabs: [{ url: 'https://example.com/account', width: 'phone' }] });
    assert.equal(await store.read('other-machine:task:1'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automation expiry and disposal revoke a late action before input and stop polling', async context => {
  const { BrowserAutomation } = require('../dist/browser/automation');
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const lease = new BrowserDriverLease('agent', 2);
  let release; const delayed = new Promise(resolve => { release = resolve; });
  let accepted = 0, reads = 0;
  const task = { scopeId: 'scope', taskId: 1, setPorts: () => undefined,
    revoke: () => lease.takeOver(),
    agent: async (input, session, signal) => {
      assert.equal(input.kind, 'click');
      const abort = () => { if (lease.driver === 'agent' && lease.generation === 1) lease.takeOver(); };
      signal.addEventListener('abort', abort, { once: true });
      try { await delayed; lease.assert(1, session); accepted++; return { tabs: [], observation: 'withheld', message: '' }; }
      finally { signal.removeEventListener('abort', abort); }
    },
  };
  const client = { state: () => ({ scope: { id: 'scope' } }), cancel: () => undefined,
    execute: async () => ({ ok: true, value: { ports: [], command: ++reads === 1 ? { id, sessionId: 2, input: { kind: 'click', tabId: id, generation: 1, x: 1, y: 1, step: 'Test' } } : null } }),
  };
  const automation = new BrowserAutomation(1, client);
  const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  automation.select(task); context.mock.timers.tick(0); await settle();
  assert.equal(reads, 1); context.mock.timers.tick(2000); await settle();
  assert.equal(lease.driver, 'you');
  release(); await settle(); assert.equal(accepted, 0, 'Expired DOM work must never dispatch late input');
  context.mock.timers.tick(400); await settle(); assert.equal(reads, 2, 'Timed-out observation must not block reconciliation');
  automation.dispose(); const previous = reads; context.mock.timers.tick(10000); await settle(); assert.equal(reads, previous);
});

test('public proxy destinations reject private, rebound and reserved addresses', () => {
  const { publicBrowserAddress } = require('../dist/browser/public-address');
  for (const value of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(publicBrowserAddress(value), false, value);
  for (const value of ['8.8.8.8', '1.1.1.1', '192.0.78.24', '2001:4860:4860::8888']) assert.equal(publicBrowserAddress(value), true, value);
});

test('task SOCKS transport bounds handshakes, preserves streams and closes owned sockets', async context => {
  const { createServer, createConnection } = require('node:net');
  const { once } = require('node:events');
  const { browserSocks } = require('../dist/browser/socks');
  const echo = createServer(socket => socket.pipe(socket));
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => echo.close(resolve)));
  let resolutions = 0;
  const proxy = await browserSocks(async () => { resolutions++; return { host: '127.0.0.1', port: echo.address().port }; });
  context.after(() => proxy.close());
  const bad = createConnection(proxy.port, '127.0.0.1'); bad.on('error', () => undefined);
  const badClosed = once(bad, 'close'); bad.end(Buffer.alloc(1100, 65)); await badClosed;
  assert.equal(resolutions, 0, 'An invalid browser request must not become a connector');
  const client = createConnection(proxy.port, '127.0.0.1'); client.on('error', () => undefined);
  const greeting = once(client, 'data'); client.write(Buffer.from([5, 1, 0])); assert.deepEqual((await greeting)[0], Buffer.from([5, 0]));
  const connected = once(client, 'data'); client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x12, 0x34]));
  assert.equal((await connected)[0][1], 0);
  const response = once(client, 'data'); client.write('opaque task data'); assert.equal((await response)[0].toString(), 'opaque task data');
  const closed = once(client, 'close'); proxy.disconnect(); await closed; assert.equal(resolutions, 1);
});
