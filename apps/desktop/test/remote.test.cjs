const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { createServer: tcpServer, connect } = require('node:net');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { RemoteManager } = require('../dist/remote/manager');
const { backendRelease } = require('../dist/backend/release');
const { failure, sshFailure } = require('../dist/remote/failure');
const { connectRemote } = require('../dist/remote/bootstrap');
const { bootstrapScript } = require('../dist/remote/runtime-install');
const { Wire, SocketChannels } = require('../dist/remote/wire');
const { createAskpass } = require('../dist/remote/askpass');
const { spawnSsh } = require('../dist/remote/ssh');
const validate = require('../dist/remote/validation');

const version = 'a'.repeat(40);
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
const host = { name: 'Development', host: 'dev-alias' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(work, predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = work(); if (predicate(value)) return value; await delay(10); }
  assert.fail('Remote condition did not become true');
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ex-remote-'));
  const server = createServer((_req, res) => res.end(JSON.stringify({ backendSha: version })));
  const port = await listen(server);
  let starts = 0; let stops = 0; let health = true;
  const transports = [];
  const connector = async options => {
    starts++;
    options.progress('discovery'); options.progress('runtime');
    const exited = deferred();
    const transport = { instance: 'instance-1', exited: exited.promise,
      health: async () => ({ ready: health, instance: 'instance-1' }),
      forward: async (remotePort, localPort) => {
        if (remotePort === 0) return { port, reachable: true, close: async () => undefined };
        const listener = tcpServer(socket => socket.end());
        const bound = await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(localPort, '127.0.0.1', () => resolve(listener.address().port)); });
        return { port: bound, reachable: true, close: async () => new Promise(resolve => listener.close(resolve)) };
      },
      close: async () => { stops++; exited.resolve(); },
    };
    transports.push(transport); return transport;
  };
  const options = { root, settingsPath: join(root, 'settings.json'), helper: '', release: async () => release,
    connect: connector, healthInterval: 20, backoff: 5, random: () => 0.5, ...overrides };
  const manager = new RemoteManager(options); await manager.load(); manager.attach(1); manager.attach(2);
  const savedHost = await manager.saveHost(host, null);
  const remote = { kind: 'remote', hostId: savedHost.id };
  t.after(async () => { await manager.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { manager, remote, root, options, transports, starts: () => starts, stops: () => stops, setHealth: value => { health = value; } };
}
const ready = (manager, window = 1) => until(() => manager.snapshot(window), value => value.connection?.phase === 'ready');

test('remote inputs reject shell syntax, extra properties, credentials and unsafe forwarding addresses', () => {
  for (const input of [ { ...host, host: '-oProxyCommand=evil' }, { ...host, host: 'x;id' }, { ...host, password: 'secret' }, { ...host, port: 0 }, { ...host, identityFile: '../key' }, { ...host, user: 'me$(id)' } ]) assert.throws(() => validate.hostInput(input));
  assert.deepEqual(validate.hostInput({ ...host, host: '::1' }), { ...host, host: '::1' });
  assert.throws(() => validate.forward({ remotePort: 8000, localPort: 3000, label: 'dev', bind: '0.0.0.0' }));
  assert.throws(() => validate.forward({ remotePort: 8000, localPort: 22, label: 'dev' }));
  assert.throws(() => validate.context({ projectId: null, taskId: null, sessionId: null, draft: 'x'.repeat(100001), cursor: null }));
  assert.equal(sshFailure('REMOTE HOST IDENTIFICATION HAS CHANGED', 'transport').failure.transient, false);
  assert.equal(sshFailure('Permission denied (publickey,password)', 'authentication').failure.action, 'authenticate');
  assert.throws(() => validate.hostInput({ ...host, forwardAgent: false }), /Invalid remote operation arguments/);
});

test('permanent SSH negotiation, account and configuration failures pause recovery', () => {
  for (const stderr of [
    'Unable to negotiate with 127.0.0.1 port 22: no matching key exchange method found. Their offer: obsolete',
    'Unable to negotiate with 127.0.0.1 port 22: no matching host key type found. Their offer: obsolete',
    'Unable to negotiate with 127.0.0.1 port 22: no matching cipher found. Their offer: obsolete',
    'Unable to negotiate with 127.0.0.1 port 22: no matching MAC found. Their offer: obsolete',
    'Bad server host key: Invalid key length',
  ]) {
    const problem = sshFailure(stderr, 'authentication').failure;
    assert.equal(problem.code, 'compatibility', stderr); assert.equal(problem.transient, false, stderr);
  }
  for (const stderr of [
    'Received disconnect from 127.0.0.1 port 22:2: Your account has expired; please contact your system administrator',
    'You are required to change your password immediately (administrator enforced).',
    'shell request failed on channel 0',
    'exec request failed on channel 0',
    'Invalid IdentityAgent environment variable name $broken-name',
    'vdollar_percent_expand: env var ${MISSING_SSH_VAR} has no value',
  ]) assert.equal(sshFailure(stderr, 'authentication').failure.transient, false, stderr);
  for (const stderr of ['Connection refused', 'Connection reset by peer', 'Connection timed out', 'No route to host', 'Could not resolve hostname host: Temporary failure in name resolution']) {
    assert.equal(sshFailure(stderr, 'authentication').failure.transient, true, stderr);
  }
});

test('windows coalesce startup and disconnect/pause only their own leases; context survives outages', async t => {
  const { manager, remote, starts, stops, setHealth } = await setup(t);
  await Promise.all([manager.select(1, remote), manager.select(2, remote)]);
  await ready(manager); await ready(manager, 2); assert.equal(starts(), 1);
  const context = { projectId: 1, taskId: 2, sessionId: 3, draft: 'unsent\nmessage', cursor: 'event-25' };
  await manager.saveContext(1, context, remote);
  await manager.disconnect(1, true);
  assert.equal(manager.snapshot(1).connection.phase, 'paused');
  assert.equal(manager.snapshot(2).connection.phase, 'ready'); assert.equal(stops(), 0);
  setHealth(false); manager.networkChanged();
  await until(() => starts(), value => value > 1);
  setHealth(true); await ready(manager, 2);
  assert.deepEqual(manager.snapshot(1).context, context);
  await manager.retry(1); await ready(manager);
  await manager.select(1, { kind: 'local' });
  assert.equal(manager.snapshot(1).context.draft, '');
  await manager.select(1, remote); await ready(manager);
  assert.deepEqual(manager.snapshot(1).context, context);
  const before = starts(); await manager.disconnect(1); await manager.disconnect(2); manager.networkChanged(); await delay(50);
  assert.equal(starts(), before); assert.equal(manager.snapshot(1).connection.phase, 'disconnected');
});

test('only native-picker grants or previously saved grants authorize custom SSH config and identity files', async t => {
  const { manager } = await setup(t);
  await assert.rejects(manager.saveHost({ ...host, configFile: '/untrusted/repository/ssh-config' }, null), /file picker/);
  manager.grantFile('config', '/chosen/config');
  const saved = await manager.saveHost({ ...host, configFile: '/chosen/config' }, null);
  assert.equal(saved.configFile, '/chosen/config');
  await assert.rejects(manager.saveHost({ ...host, identityFile: '/chosen/config' }, null), /file picker/);
});

test('credential and host-trust failures pause background recovery, manual retry is explicit, diagnostics redact unexpected errors', async t => {
  let attempts = 0; const interactive = [];
  const { manager, remote } = await setup(t, { connect: async options => {
    attempts++; interactive.push(options.interactive);
    if (attempts === 1) throw failure('authentication', 'authentication', 'Check SSH authentication.', 'authenticate');
    if (attempts === 2) throw failure('authentication', 'host-trust', 'Verify the host fingerprint.', 'verify-host');
    throw new Error('secret-password=do-not-log https://token@example.test');
  } });
  await manager.select(1, remote);
  await until(() => manager.snapshot(1).connection, value => value.phase === 'paused');
  manager.networkChanged(); await delay(40); assert.equal(attempts, 1);
  await manager.retry(1); await until(() => manager.snapshot(1).connection, value => value.failure?.code === 'host-trust');
  await delay(40); assert.equal(attempts, 2);
  await manager.retry(1); await until(() => attempts, value => value >= 3);
  await manager.disconnect(1);
  assert.deepEqual(interactive.slice(0, 3), [true, true, true]);
  assert.equal(JSON.stringify(manager.diagnostics(1)).includes('do-not-log'), false);
});

test('a hanging attempt is cancellable and a late completion cannot resurrect a disconnected window', async t => {
  const entered = deferred(); const finish = deferred(); let stopped = 0; let suppliedSignal;
  const { manager, remote } = await setup(t, { connect: async options => {
    suppliedSignal = options.signal; entered.resolve(); await finish.promise;
    return { instance: 'old', exited: new Promise(() => undefined), close: async () => { stopped++; }, forward: async () => assert.fail('stale forward'), health: async () => assert.fail('stale health') };
  } });
  await manager.select(1, remote); await entered.promise;
  const disconnecting = manager.disconnect(1); await until(() => suppliedSignal.aborted, Boolean);
  finish.resolve(); await disconnecting;
  assert.equal(stopped, 1); assert.equal(manager.snapshot(1).connection.phase, 'disconnected');
});

test('challenge ownership is enforced and transferred when its window closes', async t => {
  const entered = deferred(); const lifetime = new AbortController();
  const challenge = { id: 'challenge-1', kind: 'credential', prompt: 'Password:', expiresAt: Date.now() + 10000 };
  const { manager, remote } = await setup(t, { connect: async options => {
    entered.resolve(); const reply = await options.ask(challenge, AbortSignal.any([options.signal, lifetime.signal]));
    assert.equal(reply, 'one-secret'); throw failure('authentication', 'authentication', 'Authentication finished.', 'authenticate');
  } });
  await manager.select(1, remote); await entered.promise; await manager.select(2, remote);
  await until(() => manager.snapshot(1).challenge, Boolean);
  assert.equal(manager.snapshot(2).challenge, null);
  assert.throws(() => manager.answer(2, 'challenge-1', 'stolen'));
  await manager.detach(1);
  assert.equal(manager.snapshot(2).challenge.id, 'challenge-1');
  manager.answer(2, 'challenge-1', 'one-secret');
  await until(() => manager.snapshot(2).connection, value => value.phase === 'paused');
  assert.throws(() => manager.answer(2, 'challenge-1', 'stale'));
});

test('forward bind conflicts are visible and retryable, and removing one window leaves another connected', async t => {
  const { manager, remote } = await setup(t); await manager.select(1, remote); await manager.select(2, remote); await ready(manager);
  const blocker = tcpServer(); const port = await listen(blocker);
  t.after(() => blocker.close());
  await manager.addForward(1, { remotePort: 8000, localPort: port, label: 'web' });
  const conflict = await until(() => manager.snapshot(1).forwards[0], value => value?.phase === 'conflict');
  assert.equal(conflict.boundPort, null);
  await new Promise(resolve => blocker.close(resolve));
  await manager.retryForward(1, conflict.id);
  await until(() => manager.snapshot(1).forwards[0], value => value?.phase === 'listening');
  await manager.disconnect(1);
  assert.equal(manager.snapshot(2).connection.phase, 'ready');
  const replacement = tcpServer(); await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); }); replacement.close();
});

test('settings restore connections without interactive authentication and retain disconnected intent and drafts', async t => {
  const { manager, remote, root, options } = await setup(t); await manager.select(1, remote); await ready(manager);
  await manager.saveContext(1, { projectId: null, taskId: 4, sessionId: 5, draft: 'offline draft', cursor: 'delta' }, remote);
  await manager.disconnect(1); await manager.dispose();
  const calls = [];
  const restored = new RemoteManager({ ...options, connect: async input => { calls.push(input.interactive); throw failure('authentication', 'authentication', 'Unlock the key.', 'authenticate'); } });
  t.after(() => restored.dispose()); await restored.load(); restored.attach(8);
  assert.equal(restored.snapshot(8).context.draft, 'offline draft'); assert.equal(calls.length, 0);
  await restored.select(8, remote); await until(() => restored.snapshot(8).connection, value => value.phase === 'paused');
  await restored.dispose();
  const again = new RemoteManager({ ...options, connect: async input => { calls.push(input.interactive); throw failure('authentication', 'authentication', 'Unlock the key.', 'authenticate'); } });
  t.after(() => again.dispose()); await again.load(); again.attach(9);
  await until(() => again.snapshot(9).connection, value => value.phase === 'paused'); assert.equal(calls.at(-1), false);
  const bytes = await readFile(join(root, 'settings.json'), 'utf8'); assert.equal(bytes.includes('one-secret'), false);
});

test('askpass broker authenticates callers, returns transient credentials and denies all background prompts', async t => {
  const controller = new AbortController(); let prompts = 0;
  const broker = await createAskpass(async prompt => { prompts++; assert.equal(prompt.kind, 'credential'); return 'secret-value'; }, true, controller.signal);
  t.after(() => broker.close());
  const url = `http://127.0.0.1:${broker.env.ELEVENEX_ASKPASS_PORT}/`;
  assert.equal((await fetch(url, { method: 'POST', body: 'Password:' })).status, 403);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${broker.env.ELEVENEX_ASKPASS_TOKEN}` }, body: 'Password:' });
  assert.equal(await response.text(), 'secret-value'); assert.equal(prompts, 1);
  const background = await createAskpass(async () => assert.fail('background prompt'), false, controller.signal); t.after(() => background.close());
  assert.equal((await fetch(`http://127.0.0.1:${background.env.ELEVENEX_ASKPASS_PORT}/`, { method: 'POST', headers: { Authorization: `Bearer ${background.env.ELEVENEX_ASKPASS_TOKEN}` }, body: 'Password:' })).status, 403);
});

test('askpass supports configured fingerprint hashes, confirmations and cancellable hardware notifications', async t => {
  const controller = new AbortController(); const prompts = []; let answer = 'yes'; let notificationSignal;
  const broker = await createAskpass(async (challenge, signal) => {
    prompts.push(challenge);
    if (challenge.kind !== 'notification') return answer;
    notificationSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
  }, true, controller.signal);
  t.after(() => broker.close());
  const headers = { Authorization: `Bearer ${broker.env.ELEVENEX_ASKPASS_TOKEN}` };
  const url = `http://127.0.0.1:${broker.env.ELEVENEX_ASKPASS_PORT}/`;
  const fingerprint = Array.from({ length: 16 }, () => 'ab').join(':');
  assert.equal((await fetch(url, { method: 'POST', headers, body: `MD5:${fingerprint}\nAre you sure you want to continue connecting?` })).status, 200);
  assert.equal(prompts.at(-1).kind, 'trust');
  answer = 'no';
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Elevenex-Askpass-Prompt': 'confirm' }, body: 'Add key to agent?' })).status, 403);
  assert.equal(prompts.at(-1).kind, 'confirmation');
  answer = 'yes';
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Elevenex-Askpass-Prompt': 'confirm' }, body: 'Add key to agent?' })).status, 200);
  const pending = new AbortController();
  const notification = fetch(url, { method: 'POST', headers: { ...headers, 'X-Elevenex-Askpass-Prompt': 'none' }, body: 'Touch your security key', signal: pending.signal });
  const cancelled = assert.rejects(notification, /abort/i);
  await until(() => notificationSignal, Boolean);
  assert.equal(prompts.at(-1).kind, 'notification');
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'Security key PIN:' })).status, 200, 'PIN requests coexist with informational prompts');
  pending.abort(); await cancelled;
  await until(() => notificationSignal.aborted, Boolean);
});

test('default SSH config discovery and the real display environment are delegated to the native client', async t => {
  if (process.platform === 'win32') return t.skip('POSIX launcher fixture');
  const root = await mkdtemp(join(tmpdir(), 'ex-ssh-native-defaults-'));
  const previousPath = process.env.PATH; const previousDisplay = process.env.DISPLAY;
  await writeFile(join(root, 'ssh'), '#!/bin/sh\nprintf "%s" "$DISPLAY"\n', { mode: 0o700 });
  process.env.PATH = `${root}:${previousPath}`; process.env.DISPLAY = 'fixture-real-display';
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
    await rm(root, { recursive: true, force: true });
  });
  const session = await spawnSsh({ ...host, id: 'defaults' }, 'true', async () => null, true, new AbortController().signal, '');
  let output = ''; session.child.stdout.on('data', bytes => { output += bytes; }); await session.exited; await session.stop();
  assert.equal(session.child.spawnargs.includes('-F'), false, 'OpenSSH selects its own user and system configuration');
  assert.equal(session.child.spawnargs.some(value => value.startsWith('BatchMode=')), false, 'interactive connections retain configured BatchMode');
  assert.equal(output, 'fixture-real-display');
});

test('bridge forwards binary data with backpressure and closes accepted sockets on disposal', async t => {
  const toRemote = new PassThrough(); const toLocal = new PassThrough();
  const local = new Wire(toLocal, toRemote); const remote = new Wire(toRemote, toLocal);
  const localChannels = new SocketChannels(local); const remoteChannels = new SocketChannels(remote);
  const echo = tcpServer(socket => socket.pipe(socket)); const echoPort = await listen(echo);
  remote.on('message', frame => { if (frame.type === 'open') remoteChannels.accept(frame.id, frame.port, ''); });
  const forward = tcpServer(socket => localChannels.open(socket, echoPort)); const port = await listen(forward);
  t.after(async () => { localChannels.dispose(); remoteChannels.dispose(); local.close(); remote.close(); await Promise.all([new Promise(resolve => echo.close(resolve)), new Promise(resolve => forward.close(resolve))]); });
  const socket = connect(port, '127.0.0.1'); socket.on('error', () => undefined);
  const bytes = Buffer.alloc(1024 * 1024, 0xaf); let received = 0;
  const finished = new Promise(resolve => socket.on('data', chunk => { received += chunk.length; if (received === bytes.length) resolve(); }));
  socket.write(bytes); await Promise.race([finished, delay(3000).then(() => assert.fail('binary tunnel stalled'))]);
  assert.equal(received, bytes.length); socket.destroy();
  let closed = false; const bounded = new Wire(new PassThrough(), new PassThrough()); bounded.once('closed', () => { closed = true; });
  // A malformed or oversized peer frame fails closed without retaining data.
  toRemote.write(`${'x'.repeat(100000)}\n`); assert.equal(remote.listenerCount('message'), 0); bounded.close(); assert.equal(closed, true);
});

test('native OpenSSH configuration owns connection policy while the app reserves its command session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ex-ssh-config-')); const config = join(root, 'config');
  const clients = new Set();
  const blackhole = tcpServer(socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
  const jumpPort = await listen(blackhole);
  t.after(async () => { for (const socket of clients) socket.destroy(); await new Promise(resolve => blackhole.close(resolve)); });
  await writeFile(config, 'Host dev-alias\n HostName 127.0.0.1\n User nobody\n Port 1\n ProxyJump jump-alias\n ForwardAgent yes\n StrictHostKeyChecking no\n VerifyHostKeyDNS yes\n UpdateHostKeys yes\n FingerprintHash md5\n ForwardX11 yes\n Tunnel yes\n PermitLocalCommand yes\n LocalCommand true\n ConnectTimeout 42\n ConnectionAttempts 3\n ServerAliveInterval 17\n ServerAliveCountMax 8\n NumberOfPasswordPrompts 4\n LogLevel QUIET\n ControlMaster auto\n ControlPath /chosen/control.sock\n ControlPersist 90\n RequestTTY force\n RemoteCommand false\n StdinNull yes\n ForkAfterAuthentication yes\n SessionType none\n LocalForward 9999 localhost:80\n RemoteForward 9998 localhost:81\n DynamicForward 9997\nHost jump-alias\n HostName 127.0.0.1\n Port 1\n');
  await writeFile(config, (await readFile(config, 'utf8')).replace('Host jump-alias\n HostName 127.0.0.1\n Port 1', `Host jump-alias\n HostName 127.0.0.1\n Port ${jumpPort}\n IdentityAgent none\n IdentityFile none`));
  const controller = new AbortController();
  const ssh = await spawnSsh({ ...host, id: 'host', configFile: config }, 'true', async () => null, false, controller.signal, '');
  ssh.child.stdout.resume(); ssh.child.stderr.resume();
  t.after(async () => { controller.abort(); await ssh.stop(); await rm(root, { recursive: true, force: true }); });
  const output = await new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-G', ...ssh.child.spawnargs.slice(1, -1)], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = '';
    child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  for (const line of ['hostname 127.0.0.1', 'user nobody', 'port 1', 'proxyjump jump-alias', 'forwardagent yes',
    'stricthostkeychecking false', 'verifyhostkeydns true', 'updatehostkeys true', 'fingerprinthash MD5',
    'forwardx11 yes', 'tunnel point-to-point', 'permitlocalcommand yes', 'localcommand true', 'connecttimeout 42',
    'connectionattempts 3', 'serveraliveinterval 17', 'serveralivecountmax 8', 'numberofpasswordprompts 4', 'loglevel QUIET',
    'clearallforwardings no', 'controlmaster false', 'controlpath /chosen/control.sock', 'controlpersist 90', 'requesttty false',
    'stdinnull no', 'forkafterauthentication no', 'sessiontype default',
    'localforward 9999 [localhost]:80', 'remoteforward 9998 [localhost]:81', 'dynamicforward 9997']) assert.ok(output.includes(line), `${line}\n${output}`);
  assert.equal(output.includes('remotecommand false'), false);
});

test('a real SSH connection hanging before its server banner is cancelled and its local resources are removed', async t => {
  const sockets = new Set();
  const blackhole = tcpServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const port = await listen(blackhole);
  const root = await mkdtemp(join(tmpdir(), 'ex-ssh-hang-')); const config = join(root, 'config'); await writeFile(config, '');
  const started = Date.now();
  const ssh = await spawnSsh({ ...host, id: 'blackhole', host: '127.0.0.1', configFile: config, port }, 'true', async () => assert.fail('unexpected authentication'), false, AbortSignal.timeout(500), '');
  ssh.child.stdout.resume(); ssh.child.stderr.resume();
  const privateConfig = ssh.child.spawnargs[ssh.child.spawnargs.indexOf('-F') + 1];
  t.after(async () => { await ssh.stop(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => blackhole.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await ssh.exited; await ssh.stop(); assert.ok(Date.now() - started < 5000);
  await assert.rejects(readFile(privateConfig), { code: 'ENOENT' });
});

test('real bootstrap reuses a healthy runtime and daemon across dropped transports without scanning repositories', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote runtime');
  const home = await mkdtemp('/tmp/ex-remote-home-'); const root = join(home, '.elevenex/desktop-remote');
  const installation = join(root, 'runtimes', `${release.tag}-${release.target}`);
  await mkdir(join(installation, 'backend/node/bin'), { recursive: true });
  await symlink(process.execPath, join(installation, 'backend/node/bin/node'));
  await writeFile(join(installation, 'installation.sha256'), 'verified-fixture');
  await writeFile(join(installation, 'backend/main.cjs'), `const http=require('http'),fs=require('fs');fs.appendFileSync(${JSON.stringify(join(home, 'starts'))},'1');const ignoreTerm=fs.readFileSync(${JSON.stringify(join(home, 'starts'))},'utf8').length===1;const server=http.createServer((req,res)=>res.end(JSON.stringify({backendSha:${JSON.stringify(version)},pid:process.pid})));server.listen(process.env.ELEVENEX_DESKTOP_SOCKET);process.on('SIGTERM',()=>{if(!ignoreTerm)server.close(()=>process.exit(0));});`);
  // A conflicting TCP service must neither block initialization nor be killed.
  const controlPort = 20000 + createHash('sha256').update(`${home}:${process.getuid?.() ?? ''}:elevenex-desktop`).digest().readUInt32BE(0) % 20000;
  const occupied = createServer((_req, res) => res.writeHead(403).end());
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(controlPort, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const children = [];
  const spawnFixture = async (_host, command, _ask, _interactive, signal) => {
    const child = spawn('sh', ['-c', command], { cwd: home, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let diagnostics = ''; child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-16384); });
    const exited = new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
    const stop = async () => { child.stdin.end(); child.kill('SIGTERM'); await exited; };
    signal.addEventListener('abort', () => { void stop(); }, { once: true });
    return { child, exited, diagnostics: () => diagnostics, stop };
  };
  const daemonPids = async () => {
    const processes = await new Promise(resolve => { const child = spawn('ps', ['-axo', 'pid=,command=']); let body = ''; child.stdout.on('data', bytes => { body += bytes; }); child.on('close', () => resolve(body)); });
    return processes.split('\n').filter(line => line.includes(` daemon ${root} `)).map(line => Number(line.trim().split(/\s+/)[0])).filter(Boolean);
  };
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    // The daemon is intentionally persistent; this fixture owns and terminates it.
    const token = await readFile(join(root, 'control-token'), 'utf8').catch(() => '');
    assert.equal(token.length, 64);
    for (const pid of await daemonPids()) process.kill(pid, 'SIGTERM');
    await delay(1500); await rm(home, { recursive: true, force: true });
  });
  const options = { host: { ...host, id: 'host' }, root: home, helper: '', release, signal: AbortSignal.timeout(15000), interactive: false, ask: async () => null, progress: () => undefined, spawn: spawnFixture };
  const coldStarted = performance.now();
  const first = await connectRemote(options); const initial = await first.health(AbortSignal.timeout(3000)); assert.equal(initial.ready, true);
  const coldMilliseconds = performance.now() - coldStarted;
  const backend = await first.forward(0, 0); assert.equal(backend.reachable, true);
  assert.equal((await fetch(`http://127.0.0.1:${backend.port}/api/info`)).status, 403);
  const initialInfo = await fetch(`http://127.0.0.1:${backend.port}/api/info`, { headers: { Authorization: backend.authorization } }).then(res => res.json());
  assert.equal(initialInfo.backendSha, version);
  const serviceStatus = [];
  const absent = await first.forward(1, 0, available => serviceStatus.push(available)); assert.equal(absent.reachable, false);
  await new Promise(resolve => { const socket = connect(absent.port, '127.0.0.1'); socket.on('error', () => undefined); socket.once('close', resolve); });
  assert.deepEqual(serviceStatus, [false]); await absent.close();
  await first.close();
  const warmStarted = performance.now(); const second = await connectRemote({ ...options, signal: AbortSignal.timeout(15000) });
  t.diagnostic(`Cached runtime, new daemon: ${Math.round(coldMilliseconds)} ms; warm daemon reconnect: ${Math.round(performance.now() - warmStarted)} ms (subprocess fixture, no SSH/network latency).`);
  assert.equal(second.instance, first.instance); assert.equal(await readFile(join(home, 'starts'), 'utf8'), '1'); await second.close();
  const pids = await daemonPids(); assert.equal(pids.length, 1); process.kill(pids[0], 'SIGKILL');
  const third = await connectRemote({ ...options, signal: AbortSignal.timeout(15000) });
  assert.notEqual(third.instance, second.instance); assert.equal(await readFile(join(home, 'starts'), 'utf8'), '11');
  assert.throws(() => process.kill(initialInfo.pid, 0), { code: 'ESRCH' }); await third.close();
  assert.equal(occupied.listening, true);
  const script = await bootstrapScript(release, 'abc123'); assert.ok(script.includes('base64')); assert.ok(Buffer.byteLength(script) < 30000);
});

test('an interrupted runtime transfer removes only its staging files and preserves older installations', async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote runtime');
  const home = await mkdtemp('/tmp/ex-remote-interrupt-'); const root = join(home, '.elevenex/desktop-remote');
  const old = join(root, 'runtimes/older-working-release'); await mkdir(old, { recursive: true }); await writeFile(join(old, 'keep'), 'working');
  const command = await bootstrapScript(release, 'transfer-test');
  const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGTERM'); await rm(home, { recursive: true, force: true }); });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume();
  await until(() => output, value => value.includes('cache:no'));
  // Closing the SSH input in the middle of a declared archive is an interrupted
  // upload. It must never produce a completed cache or harm an older version.
  child.stdin.end(`1000000 ${'0'.repeat(64)}\npartial archive`);
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 1);
  assert.equal(await readFile(join(old, 'keep'), 'utf8'), 'working');
  const entries = await require('node:fs/promises').readdir(join(root, 'runtimes'));
  assert.deepEqual(entries, ['older-working-release']);
});
