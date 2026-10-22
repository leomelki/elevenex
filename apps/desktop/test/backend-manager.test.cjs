const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { BackendManager } = require('../dist/backend/manager');
const { backendRelease } = require('../dist/backend/release');
const { version } = require('./backend-fixtures.cjs');

const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-manager-'));
  let launches = 0;
  let stops = 0;
  const exits = [];
  const manager = new BackendManager({ root, release: async () => release,
    install: async (_root, _release, _signal, progress) => {
      progress('downloading', { receivedBytes: 1, totalBytes: 2 });
      progress('extracting');
      return { directory: root, executable: process.execPath, entry: 'fixture.cjs' };
    },
    start: async () => {
      launches++;
      const exited = deferred();
      exits.push(exited);
      return { url: 'http://127.0.0.1:12345', exited: exited.promise, stop: async () => { stops++; exited.resolve({ code: 0, signal: null }); } };
    }, ...overrides,
  });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { manager, exits, launches: () => launches, stops: () => stops };
}

test('startup is shared across windows, status is replayable and listeners unsubscribe', async t => {
  const { manager, launches, stops } = await setup(t);
  const phases = [];
  const unsubscribe = manager.subscribe(status => phases.push(status.phase));
  const first = manager.start();
  assert.equal(first, manager.start());
  assert.equal((await first).phase, 'ready');
  assert.deepEqual(phases, ['checking', 'checking', 'downloading', 'extracting', 'starting', 'ready']);
  assert.equal((await manager.start()).phase, 'ready');
  assert.equal(launches(), 1);
  const snapshot = manager.snapshot();
  snapshot.phase = 'failed';
  assert.equal(manager.snapshot().phase, 'ready');
  unsubscribe();
  await manager.restart();
  assert.equal(launches(), 2);
  assert.equal(stops(), 1);
  assert.equal(phases.length, 6);
});

test('failed downloads can be retried and errors remain bounded', async t => {
  let attempt = 0;
  const { manager } = await setup(t, { install: async () => {
    if (!attempt++) throw new Error('offline'.repeat(1000));
    return { directory: '', executable: '', entry: '' };
  } });
  const failed = await manager.start();
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.message.length, 2048);
  assert.equal((await manager.start()).phase, 'ready');
});

test('disposing during a download aborts it without launching a backend', async t => {
  const entered = deferred();
  const { manager, launches } = await setup(t, { install: async (_root, _release, signal) => {
    entered.resolve();
    await delay(30_000, undefined, { signal });
    throw new Error('unreachable');
  } });
  void manager.start();
  await entered.promise;
  const first = manager.dispose();
  assert.equal(first, manager.dispose());
  await first;
  assert.equal(manager.snapshot().phase, 'stopped');
  assert.equal(launches(), 0);
  assert.equal((await manager.start()).phase, 'stopped');
});

test('backend restart requests are supervised and loops stop after a bounded budget', async t => {
  const { manager, exits, launches } = await setup(t);
  await manager.start();
  for (let index = 0; index < 4; index++) {
    const changed = new Promise(resolve => {
      const stop = manager.subscribe(status => {
        if (status.phase === 'ready' || status.phase === 'failed') { stop(); resolve(status); }
      });
    });
    exits[index].resolve({ code: 75, signal: null });
    const status = await changed;
    assert.equal(status.phase, index === 3 ? 'failed' : 'ready');
  }
  assert.equal(launches(), 4);
  assert.equal((await manager.start()).phase, 'ready');
});
