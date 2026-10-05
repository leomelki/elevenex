const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteConnectionAttempts } = require('../remote-connection-attempts.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('two windows share work and cancel independently', async () => {
  const registry = createRemoteConnectionAttempts();
  const work = deferred();
  let calls = 0;
  let signal;
  const factory = (value) => { calls++; signal = value; return work.promise; };
  const first = registry.run(17, 'window-a:1', factory);
  const second = registry.run(17, 'window-b:1', factory);
  await Promise.resolve();
  assert.equal(calls, 1);
  const canceled = assert.rejects(first, /canceled/);
  registry.cancel(17, 'window-a:1');
  await canceled;
  assert.equal(signal.aborted, false);
  work.resolve('ready');
  assert.equal(await second, 'ready');
});

test('last cancellation aborts SSH work and a retry starts fresh despite a late result', async () => {
  const registry = createRemoteConnectionAttempts();
  const work = deferred();
  let signal;
  const first = registry.run(17, 'window-a:1', (value) => { signal = value; return work.promise; });
  await Promise.resolve();
  const canceled = assert.rejects(first, /canceled/);
  registry.cancel(17, 'window-a:1');
  await canceled;
  assert.equal(signal.aborted, true);
  assert.equal(await registry.run(17, 'window-a:2', () => 'new connection'), 'new connection');
  work.resolve('stale connection');
});

test('hung work expires, aborts the process signal, and releases the shared attempt', async () => {
  const registry = createRemoteConnectionAttempts({ timeoutMs: 10 });
  let signal;
  await assert.rejects(registry.run(17, 'window-a:1', (value) => {
    signal = value;
    return new Promise(() => {});
  }), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(await registry.run(17, 'window-a:2', () => 'ready'), 'ready');
});

test('closing a window cancels its attempts across servers and preserves other windows', async () => {
  const registry = createRemoteConnectionAttempts();
  const work = deferred();
  const first = registry.run(17, 'window-a:1', () => work.promise);
  const otherServer = registry.run(18, 'window-a:2', () => new Promise(() => {}));
  const second = registry.run(17, 'window-b:1', () => work.promise);
  const canceled = Promise.all([assert.rejects(first, /canceled/), assert.rejects(otherServer, /canceled/)]);
  registry.cancelWindow('window-a');
  await canceled;
  work.resolve('ready');
  assert.equal(await second, 'ready');
});
