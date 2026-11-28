const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { MachinePreferences } = require('../dist/machines/preferences');
const { MachineApplication } = require('../dist/machines/application');
const { sshHostSuggestions } = require('../dist/machines/ssh-hosts');

test('first-run flag is durable, coalesces writes and preserves damaged preferences', async t => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-machine-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'prefs.json');
  const preferences = new MachinePreferences(path); await preferences.load();
  assert.equal(preferences.hasOpenedMachine, false);
  const one = preferences.markOpened(); assert.equal(one, preferences.markOpened()); await one;
  const restored = new MachinePreferences(path); await restored.load();
  assert.equal(restored.hasOpenedMachine, true);
  await writeFile(path, '{broken');
  const damaged = new MachinePreferences(path); await damaged.load();
  assert.ok(damaged.error); await assert.rejects(damaged.markOpened());
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('machine snapshots order events, isolate launch requests and only complete a ready selected machine', async () => {
  let backendChanged, remoteChanged, opened = false;
  let local = { phase: 'starting', version: null };
  const env = { selection: { kind: 'local' }, challenge: null, connection: null, forwards: [], context: {} };
  const events = [];
  const backend = { snapshot: () => local, subscribe: fn => { backendChanged = fn; return () => { backendChanged = null; }; } };
  const remote = { snapshot: () => env, hosts: () => [{ id: 'dev', name: 'Dev', host: 'dev' }], machineStatuses: () => [], backendStatus: () => local,
    subscribeDirectory: fn => { remoteChanged = fn; return () => { remoteChanged = null; }; } };
  const preferences = { get hasOpenedMachine() { return opened; }, error: null, markOpened: async () => { opened = true; } };
  const machines = new MachineApplication(backend, remote, preferences, (id, state) => events.push([id, state]));
  machines.attach(1); machines.attach(2, { kind: 'local' });
  assert.equal(machines.snapshot(1).launchSelection, null);
  assert.deepEqual(machines.snapshot(2).launchSelection, { kind: 'local' });
  await assert.rejects(machines.opened(1, { kind: 'local' }), /not ready/);
  await assert.rejects(machines.opened(1, { kind: 'remote', hostId: 'dev' }), /changed/);
  assert.throws(() => machines.validateSelection({ kind: 'remote', hostId: 'unknown' }), /Unknown/);
  assert.throws(() => machines.validateSelection({ kind: 'local', url: 'evil' }), /Invalid/);
  local = { phase: 'ready', version: 'abc', url: 'http://127.0.0.1:1234' }; backendChanged(local);
  remoteChanged(1, env);
  assert.ok(machines.snapshot(1).revision > 0);
  await machines.opened(2, { kind: 'local' });
  assert.equal(machines.snapshot(1).hasOpenedMachine, true);
  assert.equal(machines.snapshot(2).launchSelection, null);
  assert.ok(events.every(([id, state], index) => !events.slice(0, index).some(([beforeId, before]) => beforeId === id && before.revision >= state.revision)));
  machines.detach(1); assert.throws(() => machines.snapshot(1), /no longer/);
  machines.dispose(); assert.equal(backendChanged, null); assert.equal(remoteChanged, null);
});

test('SSH suggestions are bounded and inert: explicit aliases only, no Match exec or wildcard evaluation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-ssh-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'config');
  assert.deepEqual(await sshHostSuggestions(path, ''), []);
  await writeFile(path, 'Host dev dev-two *.example !blocked\nMatch exec "touch /tmp/should-not-exist"\nInclude other\nHost "build" # comment\n' + Array.from({ length: 100 }, (_, i) => `Host host-${i}`).join('\n'));
  assert.deepEqual(await sshHostSuggestions(path, 'dev'), [{ host: 'dev' }, { host: 'dev-two' }]);
  assert.deepEqual(await sshHostSuggestions(path, 'build'), [{ host: 'build' }]);
  assert.equal((await sshHostSuggestions(path, '')).length, 8);
  await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(sshHostSuggestions(path, ''), /unavailable/);
});

test('machine appearance persists without losing first-run completion and validates edit payloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-machine-look-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'prefs.json'), preferences = new MachinePreferences(path); await preferences.load();
  await Promise.all([preferences.saveAppearance({ name: 'My Mac', hue: 'rose' }), preferences.markOpened()]);
  const restored = new MachinePreferences(path); await restored.load();
  assert.deepEqual(restored.localAppearance, { name: 'My Mac', hue: 'rose' }); assert.equal(restored.hasOpenedMachine, true);
  const { editInput } = require('../dist/machines/validation');
  for (const input of [{ name: '', hue: 'rose' }, { name: 'Mac', hue: 'pink' }, { name: 'Mac', hue: 'pine', host: 'dev' }]) assert.throws(() => editInput(input, false), /Invalid/);
  for (const input of [{ name: 'Dev', hue: 'pine', host: 'evil; command' }, { name: 'Dev', hue: 'pine', host: 'dev', port: 65536 }, { name: 'Dev', hue: 'pine', host: 'dev', password: 'secret' }]) assert.throws(() => editInput(input, true));
});

test('Undo tokens are window-owned, single-use, bounded and discarded on window disposal', async () => {
  const host = { id: 'dev', name: 'Dev', host: 'dev' }, events = []; let remoteChanged;
  const remote = { hosts: () => [host], snapshot: () => ({ selection: { kind: 'local' } }), machineStatuses: () => [],
    subscribeDirectory: fn => { remoteChanged = fn; return () => {}; },
    removeMachineHost: async () => { remoteChanged(); return { host, index: 0 }; },
    restoreMachineHost: async value => { events.push(value); remoteChanged(); },
  };
  const machines = new MachineApplication({ snapshot: () => ({ phase: 'ready' }), subscribe: () => () => {} }, remote, { hasOpenedMachine: true, error: null }, () => {});
  machines.attach(1); machines.attach(2);
  const one = await machines.remove(1, 'dev', false);
  await assert.rejects(machines.undoRemove(2, one.undoToken), /no longer/);
  machines.dismissRemoval(2, one.undoToken); await machines.undoRemove(1, one.undoToken);
  assert.deepEqual(events, [host]); await assert.rejects(machines.undoRemove(1, one.undoToken), /no longer/);
  const removed = []; for (let i = 0; i < 4; i++) removed.push(await machines.remove(1, 'dev', false));
  await assert.rejects(machines.undoRemove(1, removed[0].undoToken), /no longer/);
  machines.detach(1); await assert.rejects(machines.undoRemove(1, removed[3].undoToken), /no longer/);
  machines.dispose();
});
