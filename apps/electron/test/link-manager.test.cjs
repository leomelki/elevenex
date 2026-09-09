// Two link managers with separate on-disk state, a relay between them, and a
// backend behind one of them: the same shape as two desktop apps pairing. This
// is the test that says "another desktop client can connect to this one".

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');

const { createLinkManager } = require('../link-manager.cjs');
const { createRelayServer } = require('../../relay/server.cjs');

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => {});
  }
});

function tempUserData(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `elevenex-${name}-`));
  cleanups.push(async () => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function startBackend(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(body);
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
}

async function startRelay() {
  const relay = createRelayServer({ port: 0, host: '127.0.0.1', quiet: true });
  const port = await relay.listen();
  cleanups.push(() => relay.close());
  return `ws://127.0.0.1:${port}/link`;
}

function makeManager(name, backendPort) {
  const manager = createLinkManager({
    userDataPath: tempUserData(name),
    getLocalBackendPort: () => backendPort,
  });
  cleanups.push(() => manager.stopAll());
  return manager;
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function fetchThrough(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

describe('link manager: desktop to desktop', () => {
  it('pairs two machines with a code and forwards traffic', async () => {
    const relayUrl = await startRelay();
    const backendPort = await startBackend('hello from machine A');

    // Machine A shares its backend.
    const machineA = makeManager('machine-a', backendPort);
    const sharing = await machineA.enableSharing({ transport: 'relay', relayUrl });
    assert.equal(sharing.enabled, true);

    const code = machineA.getSharingCode();
    assert.ok(code.startsWith('EX1-'), 'a pairing code should be produced');

    // Machine B has its own state and only ever sees the code.
    const machineB = makeManager('machine-b', 1);
    const device = machineB.addLink({ code, name: 'Machine A' });
    assert.equal(device.name, 'Machine A');
    assert.equal(device.status, 'stopped');

    const connected = await machineB.connect(device.id);
    assert.equal(connected.status, 'connected');
    assert.ok(connected.localPort > 0);

    assert.equal(await fetchThrough(connected.localPort), 'hello from machine A');
  });

  it('never exposes the pairing key through the list view', async () => {
    const relayUrl = await startRelay();
    const machineA = makeManager('redact-a', await startBackend('x'));
    await machineA.enableSharing({ transport: 'relay', relayUrl });

    const machineB = makeManager('redact-b', 1);
    machineB.addLink({ code: machineA.getSharingCode(), name: 'A' });

    const serialized = JSON.stringify(machineB.listLinks());
    assert.ok(!serialized.includes('pairingKey'), 'listLinks must not carry the key');
    assert.ok(!/"k":/.test(serialized), 'listLinks must not carry the code payload');

    const sharingSerialized = JSON.stringify(machineA.sharingView());
    assert.ok(!sharingSerialized.includes('pairingKey'));
    assert.ok(!sharingSerialized.includes('EX1-'), 'the status view must not embed the code');
  });

  it('restores sharing across a restart and keeps the code valid', async () => {
    const relayUrl = await startRelay();
    const backendPort = await startBackend('survived a restart');
    const userDataPath = tempUserData('restart');

    const first = createLinkManager({ userDataPath, getLocalBackendPort: () => backendPort });
    await first.enableSharing({ transport: 'relay', relayUrl });
    const code = first.getSharingCode();
    // Simulate quitting the app: the process goes, the file stays.
    await first.stopAll();

    const second = createLinkManager({ userDataPath, getLocalBackendPort: () => backendPort });
    cleanups.push(() => second.stopAll());
    assert.equal(second.getSharingCode(), code, 'the saved code must survive a restart');
    await second.restoreSharing();

    const machineB = makeManager('restart-client', 1);
    const device = machineB.addLink({ code });
    const connected = await machineB.connect(device.id);

    assert.equal(await fetchThrough(connected.localPort), 'survived a restart');
  });

  it('revokes the old code when it is regenerated', async () => {
    const relayUrl = await startRelay();
    const machineA = makeManager('revoke-a', await startBackend('secret'));
    await machineA.enableSharing({ transport: 'relay', relayUrl });

    const oldCode = machineA.getSharingCode();
    const newCode = await machineA.regenerateSharingCode();
    assert.notEqual(oldCode, newCode);

    const machineB = makeManager('revoke-b', 1);
    const stale = machineB.addLink({ code: oldCode, name: 'Stale' });
    // The old pairing id no longer has a host waiting on the relay, so this must
    // fail rather than quietly reaching the machine.
    await assert.rejects(machineB.connect(stale.id));
  });

  it('does not report a link that never came back as connected', async () => {
    const relayUrl = await startRelay();
    const machineA = makeManager('down-a', await startBackend('x'));
    await machineA.enableSharing({ transport: 'relay', relayUrl });

    const machineB = makeManager('down-b', 1);
    const device = machineB.addLink({ code: machineA.getSharingCode() });
    await machineB.connect(device.id);

    // The sharing side goes away. The client keeps its loopback port and
    // retries in the background, so connect() lands on the cached client.
    await machineA.stopAll();
    await waitFor(() => machineB.getLinkState(device.id).status !== 'connected');

    // Reporting success here would point a window at a port with no session
    // behind it: an empty workspace under the device's name, and no error.
    await assert.rejects(machineB.connect(device.id));
  });

  it('refuses to save the same device twice', async () => {
    const relayUrl = await startRelay();
    const machineA = makeManager('dupe-a', await startBackend('x'));
    await machineA.enableSharing({ transport: 'relay', relayUrl });
    const code = machineA.getSharingCode();

    const machineB = makeManager('dupe-b', 1);
    machineB.addLink({ code, name: 'First' });
    assert.throws(() => machineB.addLink({ code, name: 'Second' }), /already saved/i);
  });

  it('reports a helpful error when nobody is sharing that code', async () => {
    const relayUrl = await startRelay();
    const machineA = makeManager('offline-a', await startBackend('x'));
    await machineA.enableSharing({ transport: 'relay', relayUrl });
    const code = machineA.getSharingCode();
    // A sharing side that was configured and then went away entirely.
    await machineA.stopAll();

    const machineB = makeManager('offline-b', 1);
    const device = machineB.addLink({ code });
    await assert.rejects(machineB.connect(device.id));
  });
});
