const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createConnectionRegistry } = require('../connection-registry.cjs');

const LOCAL = { mode: 'local' };
const SERVER_A = { mode: 'ssh', serverId: 1, label: 'Prod' };
const SERVER_B = { mode: 'ssh', serverId: 2, label: 'Staging' };

function trackingRegistry() {
  const acquired = [];
  const released = [];
  const errors = [];
  const registry = createConnectionRegistry({
    onAcquire: (envRef) => acquired.push(envRef),
    onRelease: (envRef) => released.push(envRef),
    onError: (error) => errors.push(error),
  });
  return { acquired, errors, registry, released };
}

describe('connection registry leases', () => {
  it('notifies only on the first holder and the last release', () => {
    const { acquired, registry, released } = trackingRegistry();

    registry.acquire('w1', SERVER_A);
    registry.acquire('w2', SERVER_A);
    assert.equal(acquired.length, 1, 'second window must reuse the live tunnel');

    registry.release('w1', SERVER_A);
    assert.deepEqual(released, [], 'tunnel must stay up while w2 still holds it');

    registry.release('w2', SERVER_A);
    assert.equal(released.length, 1);
    assert.equal(released[0].serverId, 1);
  });

  it('reports holders and environments accurately', () => {
    const { registry } = trackingRegistry();
    registry.acquire('w1', SERVER_A);
    registry.acquire('w2', SERVER_A);
    registry.acquire('w3', LOCAL);

    assert.deepEqual(registry.holders(SERVER_A).sort(), ['w1', 'w2']);
    assert.deepEqual(registry.holders(SERVER_B), []);
    assert.deepEqual(
      registry.environments().map((entry) => entry.key).sort(),
      ['local', 'server-1'],
    );
    assert.equal(registry.environmentOf('w3').mode, 'local');
    assert.equal(registry.environmentOf('unknown'), null);
  });

  it('refreshes the label on re-acquire without churning the lease', () => {
    const { acquired, registry, released } = trackingRegistry();
    registry.acquire('w1', SERVER_A);
    registry.acquire('w1', { mode: 'ssh', serverId: 1, label: 'Renamed' });

    assert.equal(acquired.length, 1);
    assert.deepEqual(released, []);
    assert.equal(registry.environmentOf('w1').label, 'Renamed');
  });
});

describe('connection registry setEnvironment', () => {
  it('releases the old environment and acquires the new one', () => {
    const { acquired, registry, released } = trackingRegistry();
    registry.acquire('w1', SERVER_A);
    registry.setEnvironment('w1', SERVER_B);

    assert.deepEqual(acquired.map((ref) => ref.serverId), [1, 2]);
    assert.deepEqual(released.map((ref) => ref.serverId), [1]);
    assert.deepEqual(registry.holders(SERVER_A), []);
    assert.deepEqual(registry.holders(SERVER_B), ['w1']);
  });

  it('keeps the old environment alive when another window still holds it', () => {
    const { registry, released } = trackingRegistry();
    registry.acquire('w1', SERVER_A);
    registry.acquire('w2', SERVER_A);
    registry.setEnvironment('w1', LOCAL);

    assert.deepEqual(released, [], 'w2 is still on server 1');
    assert.deepEqual(registry.holders(SERVER_A), ['w2']);
  });

  it('is a no-op when switching to the same environment', () => {
    const { acquired, registry, released } = trackingRegistry();
    registry.acquire('w1', LOCAL);
    registry.setEnvironment('w1', LOCAL);

    assert.equal(acquired.length, 1);
    assert.deepEqual(released, []);
  });

  it('does not tear down the embedded backend shared by another local window', () => {
    // Regression: opening/switching a window to SSH used to stop the embedded
    // backend unconditionally, killing the other local window's connection.
    const { registry, released } = trackingRegistry();
    registry.acquire('w1', LOCAL);
    registry.acquire('w2', LOCAL);
    registry.setEnvironment('w1', SERVER_A);

    assert.deepEqual(released, []);
    assert.deepEqual(registry.holders(LOCAL), ['w2']);
  });
});

describe('connection registry releaseAll', () => {
  it('drops whatever a closing window held without the caller tracking it', () => {
    const { registry, released } = trackingRegistry();
    registry.acquire('w1', SERVER_A);

    const result = registry.releaseAll('w1');
    assert.equal(result.isLastHolder, true);
    assert.equal(released.length, 1);
    assert.equal(registry.releaseAll('w1'), null, 'second call is harmless');
  });
});

describe('connection registry run coalescing', () => {
  it('shares one in-flight promise per environment', async () => {
    const { registry } = trackingRegistry();
    let calls = 0;
    let resolve;
    const gate = new Promise((r) => { resolve = r; });
    const factory = () => { calls += 1; return gate; };

    const first = registry.run(SERVER_A, factory);
    const second = registry.run(SERVER_A, factory);
    assert.equal(calls, 1, 'two windows waiting on the same server share one install run');
    assert.equal(registry.isRunning(SERVER_A), true);

    resolve('ready');
    assert.deepEqual(await Promise.all([first, second]), ['ready', 'ready']);
    assert.equal(registry.isRunning(SERVER_A), false);
  });

  it('does not coalesce across different environments', () => {
    const { registry } = trackingRegistry();
    let calls = 0;
    const factory = () => { calls += 1; return new Promise(() => {}); };
    registry.run(SERVER_A, factory);
    registry.run(SERVER_B, factory);
    assert.equal(calls, 2);
  });

  it('clears the entry after rejection so a retry starts fresh', async () => {
    const { registry } = trackingRegistry();
    let calls = 0;
    const factory = () => { calls += 1; return Promise.reject(new Error('install failed')); };

    await assert.rejects(registry.run(SERVER_A, factory), /install failed/);
    assert.equal(registry.isRunning(SERVER_A), false);

    await assert.rejects(registry.run(SERVER_A, factory), /install failed/);
    assert.equal(calls, 2, 'a failed remote install must be retryable');
  });

  it('surfaces a synchronous factory throw as a rejection', async () => {
    const { registry } = trackingRegistry();
    await assert.rejects(registry.run(SERVER_A, () => { throw new Error('boom'); }), /boom/);
    assert.equal(registry.isRunning(SERVER_A), false);
  });
});

describe('connection registry error isolation', () => {
  it('reports hook failures instead of breaking the bookkeeping', () => {
    const errors = [];
    const registry = createConnectionRegistry({
      onAcquire: () => { throw new Error('spawn failed'); },
      onError: (error) => errors.push(error),
    });

    registry.acquire('w1', SERVER_A);
    assert.equal(errors.length, 1);
    assert.deepEqual(registry.holders(SERVER_A), ['w1'], 'lease is still recorded');
  });

  it('reports async hook rejections', async () => {
    const errors = [];
    const registry = createConnectionRegistry({
      onRelease: () => Promise.reject(new Error('stop failed')),
      onError: (error) => errors.push(error),
    });

    registry.acquire('w1', SERVER_A);
    registry.releaseAll('w1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 1);
  });
});
