// The SSH relay transport, with sshd played by in-process TCP forwards so the
// whole pairing path runs without an SSH server.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { after, describe, it } = require('node:test');

const { createLinkManager } = require('../link-manager.cjs');
const { decodePairingCode } = require('../link-pairing.cjs');
const {
  buildSshTunnelArgs,
  formatSshEndpoint,
  openSshTunnel,
  parseSshEndpoint,
} = require('../link-ssh.cjs');

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
  const server = http.createServer((_request, response) => response.end(body));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return port;
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

function forwardPort(listenPort, targetPort) {
  const server = net.createServer((socket) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    // Like sshd: accept, then drop the connection when nothing listens behind it.
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

// One "SSH server" whose loopback is this machine's: -R binds the relay port,
// -L binds the client's port and dials the relay port.
function fakeSshServer() {
  const opened = [];
  const openTunnel = ({ mode, relayPort, targetPort, listenPort, host, user, identityFile }) => {
    const tunnel = new EventEmitter();
    opened.push({ mode, host, user, identityFile });
    tunnel.stderr = [];
    tunnel.closed = false;
    tunnel.error = null;
    let server = null;
    tunnel.whenClosed = new Promise((resolve) => tunnel.once('close', resolve));
    tunnel.ready = (mode === 'remote' ? forwardPort(relayPort, targetPort) : forwardPort(listenPort, relayPort))
      .then((bound) => {
        server = bound;
        if (tunnel.closed) server.close();
      });
    tunnel.close = () => {
      if (!tunnel.closed) {
        tunnel.closed = true;
        tunnel.error = new Error('closed');
        if (server) server.close();
        tunnel.emit('close', tunnel.error);
      }
      return tunnel.whenClosed;
    };
    return tunnel;
  };
  return { openTunnel, opened };
}

function makeManager(name, backendPort, openTunnel) {
  const manager = createLinkManager({
    userDataPath: tempUserData(name),
    getLocalBackendPort: () => backendPort,
    openTunnel,
  });
  cleanups.push(() => manager.stopAll());
  return manager;
}

async function freePort() {
  const server = await forwardPort(0, 1);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('ssh relay endpoints', () => {
  it('round-trips user, host, ports and IPv6 literals', () => {
    const endpoint = formatSshEndpoint({ host: 'bastion.corp', port: 2222, user: 'dev', relayPort: 41000 });
    assert.equal(endpoint, 'ssh://dev@bastion.corp:2222/41000');
    assert.deepEqual(parseSshEndpoint(endpoint), { host: 'bastion.corp', port: 2222, user: 'dev', relayPort: 41000 });
    assert.deepEqual(
      parseSshEndpoint(formatSshEndpoint({ host: '::1', relayPort: 40000 })),
      { host: '::1', port: 22, user: '', relayPort: 40000 },
    );
    assert.throws(() => formatSshEndpoint({ host: '', relayPort: 1 }));
    assert.throws(() => parseSshEndpoint('ssh://host:22/0'));
  });

  it('builds a non-interactive tunnel with the requested forward', () => {
    const args = buildSshTunnelArgs({
      host: 'bastion', port: 2222, user: 'dev', identityFile: '/k', forward: ['-R', '127.0.0.1:1:127.0.0.1:2'],
    });
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('ControlPath=none'));
    assert.deepEqual(args.slice(-3), ['-R', '127.0.0.1:1:127.0.0.1:2', 'bastion']);
    assert.ok(args.join(' ').includes('-p 2222 -l dev -i /k -o IdentitiesOnly=yes'));
  });
});

describe('ssh tunnel process', () => {
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('close', null, 'SIGTERM'); };
    return { child, spawnProcess: () => child };
  }

  it('is ready once ssh confirms the reverse forward', async () => {
    const { child, spawnProcess } = fakeSpawn();
    const tunnel = openSshTunnel({ host: 'h', mode: 'remote', relayPort: 40000, targetPort: 5, spawnProcess });
    child.stderr.write('debug1: remote forward success for: listen 127.0.0.1:40000, connect 127.0.0.1:5\n');
    await tunnel.ready;
    await tunnel.close();
    assert.equal(tunnel.closed, true);
  });

  it('explains a refused login and a taken relay port', async () => {
    const refused = fakeSpawn();
    const login = openSshTunnel({ host: 'h', mode: 'local', listenPort: 1, relayPort: 40000, spawnProcess: refused.spawnProcess });
    refused.child.stderr.write('debug1: Next authentication method: publickey\nuser@h: Permission denied (publickey).\n');
    refused.child.emit('close', 255, null);
    await assert.rejects(login.ready, /refused the SSH login/);

    const taken = fakeSpawn();
    const busy = openSshTunnel({ host: 'h', mode: 'remote', relayPort: 40000, targetPort: 5, spawnProcess: taken.spawnProcess });
    taken.child.stderr.write('Warning: remote port forwarding failed for listen port 40000\n');
    await assert.rejects(busy.ready, /Port 40000 is already in use on h/);
  });
});

describe('link manager: ssh relay', () => {
  it('pairs two machines through an SSH server and forwards traffic', async () => {
    const sshd = fakeSshServer();
    const relayPort = await freePort();

    const machineA = makeManager('ssh-a', await startBackend('hello over ssh'), sshd.openTunnel);
    const sharing = await machineA.enableSharing({
      transport: 'ssh',
      ssh: { host: 'bastion', user: 'alice', relayPort, identityFile: '/keys/alice' },
    });
    assert.equal(sharing.transport, 'ssh');
    assert.equal(sharing.endpoint, `ssh://alice@bastion:22/${relayPort}`);

    const code = machineA.getSharingCode();
    assert.ok(!code.includes('alice'), 'the code is encoded, not plain text');
    assert.equal(decodePairingCode(code).endpoint, sharing.endpoint);

    const machineB = makeManager('ssh-b', 1, sshd.openTunnel);
    const device = machineB.addLink({ code, name: 'A', ssh: { user: 'bob' } });
    const connected = await machineB.connect(device.id);
    assert.equal(connected.status, 'connected');
    assert.equal(connected.path, 'relay');
    assert.equal(await fetchThrough(connected.localPort), 'hello over ssh');

    assert.deepEqual(sshd.opened.map(({ mode, user, identityFile }) => ({ mode, user, identityFile })), [
      { mode: 'remote', user: 'alice', identityFile: '/keys/alice' },
      { mode: 'local', user: 'bob', identityFile: '' },
    ]);
  });

  it('keeps the relay port when sharing through the same login again', async () => {
    const sshd = fakeSshServer();
    const machineA = makeManager('ssh-reuse', await startBackend('x'), sshd.openTunnel);
    const first = await machineA.enableSharing({ transport: 'ssh', ssh: { host: 'bastion' } });
    const code = machineA.getSharingCode();
    await machineA.disableSharing();
    const second = await machineA.enableSharing({ transport: 'ssh', ssh: { host: 'bastion' } });
    assert.equal(second.endpoint, first.endpoint);
    assert.equal(machineA.getSharingCode(), code);
  });
});
