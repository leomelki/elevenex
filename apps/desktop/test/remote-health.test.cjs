const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { getEventListeners } = require('node:events');
const { RemoteConnection } = require('../dist/remote/connection');
const { backendRelease } = require('../dist/backend/release');

const version = 'a'.repeat(40);
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await delay(10); }
  assert.fail('Remote health condition did not become true');
}

async function setup(t, overrides = {}) {
  let httpMode = 'ready', healthMode = 'ready', instance = 'original', reportedVersion = version;
  let starts = 0, closes = 0, forwardCloses = 0, checks = 0, inFlight = 0, maximumInFlight = 0;
  let exit;
  const signals = [], events = [];
  const server = createServer((_request, response) => {
    if (httpMode === 'headers') return;
    if (httpMode === 'body') { response.writeHead(200); response.write('{'); return; }
    response.end(JSON.stringify({ backendSha: reportedVersion }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = new RemoteConnection({
    root: '', helper: '', host: { id: 'health', name: 'health', host: 'health' }, release: async () => release,
    changed: () => events.push(connection.snapshot()), healthInterval: 10, healthTimeout: 50, healthGrace: 600,
    backoff: 30000, random: () => 0.5, ...overrides,
    connect: async () => {
      starts++;
      const exited = new Promise(resolve => { exit = resolve; });
      return {
        instance, exited,
        health: async signal => {
          checks++; signals.push(signal); inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
          try {
            if (healthMode === 'stalled') await delay(30000, undefined, { signal });
            if (healthMode === 'slow') await delay(4200, undefined, { signal });
            return { ready: healthMode !== 'unavailable', instance };
          } finally { inFlight--; }
        },
        forward: async () => ({ port: server.address().port, reachable: true, authorization: null, close: async () => { forwardCloses++; } }),
        close: async () => { closes++; exit(); },
      };
    },
  });
  t.after(async () => { await connection.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  connection.acquire(1, true);
  await until(() => connection.snapshot().phase === 'ready');
  return {
    connection, events, signals,
    counts: () => ({ starts, closes, forwardCloses, checks, inFlight, maximumInFlight }),
    health: value => { healthMode = value; }, http: value => { httpMode = value; },
    instance: value => { instance = value; }, version: value => { reportedVersion = value; },
    exit: () => exit(),
  };
}

test('the default health deadline permits latency exceeding the former four-second cutoff', { timeout: 15000 }, async t => {
  const { connection, counts, health } = await setup(t, { healthTimeout: undefined, healthGrace: undefined });
  health('slow');
  const initial = counts().checks;
  await until(() => counts().checks > initial);
  await delay(4300);
  assert.equal(connection.snapshot().phase, 'ready');
  assert.equal(counts().starts, 1); assert.equal(counts().closes, 0);
  assert.equal(connection.snapshot().generation, 1);
});

for (const mode of ['ssh', 'headers', 'body']) test(`a temporary ${mode} stall recovers without replacing SSH, forwards or the backend scope`, async t => {
  const { connection, events, counts, signals, health, http } = await setup(t);
  const url = connection.backendUrl(), transport = connection.currentTransport();
  if (mode === 'ssh') health('stalled'); else http(mode);
  await until(() => connection.logs().some(log => log.code === 'health-delayed'));
  // Network/focus notifications must not bypass the grace period or overlap probes.
  for (let index = 0; index < 20; index++) connection.networkChanged();
  health('ready'); http('ready');
  await until(() => connection.logs().some(log => log.code === 'health-restored'));
  assert.equal(connection.backendUrl(), url); assert.equal(connection.currentTransport(), transport);
  assert.equal(connection.snapshot().generation, 1); assert.equal(connection.snapshot().failure, null);
  assert.ok(events.every(status => status.generation === 0 || status.phase === 'ready'));
  assert.equal(counts().starts, 1); assert.equal(counts().closes, 0); assert.equal(counts().forwardCloses, 0);
  assert.equal(counts().maximumInFlight, 1);
  assert.ok(signals.every(signal => getEventListeners(signal, 'abort').length === 0));
});

test('continuous failed probes have a bounded grace period and one recovery; successful probes reset the grace', async t => {
  const { connection, counts, health } = await setup(t, { healthGrace: 250 });
  for (let index = 0; index < 2; index++) {
    health('stalled');
    await until(() => connection.logs().filter(log => log.code === 'health-delayed').length === index + 1);
    health('ready');
    await until(() => connection.logs().filter(log => log.code === 'health-restored').length === index + 1);
    assert.equal(counts().closes, 0);
  }
  const started = performance.now(); health('stalled');
  await until(() => connection.snapshot().retryAt !== null);
  assert.ok(performance.now() - started >= 250);
  assert.equal(connection.snapshot().phase, 'recovering');
  assert.equal(connection.snapshot().failure.stage, 'application');
  assert.equal(connection.backendUrl(), undefined);
  assert.equal(counts().starts, 1); assert.equal(counts().closes, 1); assert.equal(counts().forwardCloses, 1);
  health('ready'); connection.networkChanged();
  await until(() => connection.snapshot().phase === 'ready');
  assert.equal(counts().starts, 2); assert.equal(connection.snapshot().generation, 2);
});

for (const reason of ['exit', 'release', 'dispose']) test(`${reason} interrupts an in-flight health probe without waiting for the network grace`, { timeout: 5000 }, async t => {
  const { connection, counts, health, exit } = await setup(t, { healthTimeout: 30000, healthGrace: 60000 });
  health('stalled'); await until(() => counts().inFlight === 1);
  if (reason === 'exit') {
    exit();
    await until(() => connection.snapshot().retryAt !== null);
    assert.equal(connection.snapshot().failure.stage, 'transport');
  }
  if (reason === 'release') await connection.release(1);
  else if (reason === 'dispose') await connection.dispose();
  assert.equal(counts().inFlight, 0);
  assert.equal(counts().closes, 1); assert.equal(counts().forwardCloses, 1);
});

for (const problem of ['unavailable', 'instance', 'revision']) test(`confirmed ${problem} changes bypass the network grace period`, async t => {
  const fixture = await setup(t, { healthGrace: 60000 });
  if (problem === 'unavailable') fixture.health('unavailable');
  if (problem === 'instance') fixture.instance('replacement');
  if (problem === 'revision') fixture.version('b'.repeat(40));
  await until(() => fixture.counts().closes === 1);
  assert.equal(fixture.connection.snapshot().phase, problem === 'revision' ? 'paused' : 'recovering');
  assert.ok(!fixture.connection.logs().some(log => log.code === 'health-delayed'));
});
