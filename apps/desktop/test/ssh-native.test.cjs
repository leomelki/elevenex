const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { createServer, connect: connectSocket } = require('node:net');
const { join } = require('node:path');
const { userInfo } = require('node:os');
const { spawnSsh, shellQuote } = require('../dist/remote/ssh');
const { sshFailure } = require('../dist/remote/failure');
const { connectRemote } = require('../dist/remote/bootstrap');
const { backendRelease } = require('../dist/backend/release');

async function run(executable, args, env = process.env) {
  return new Promise((done, failed) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', failed); child.once('close', code => code === 0 ? done(output) : failed(new Error(output)));
  });
}
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Native SSH condition did not arrive');
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function roundTrip(port, value) {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1'); let output = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Forward timed out')));
    socket.on('error', reject); socket.on('data', bytes => { output += bytes; }); socket.once('end', () => resolve(output));
    socket.once('connect', () => socket.end(value));
  });
}

test('native SSH follows config for trust, keys, jumps, agents, forwards and multiplexing', { timeout: 60000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX SSH server fixture');
  try { await access('/usr/sbin/sshd'); } catch { return t.skip('The host has no sshd executable'); }
  const root = await mkdtemp('/tmp/ex-native-ssh-');
  const blocker = createServer(); await new Promise(done => blocker.listen(0, '127.0.0.1', done)); const conflictPort = blocker.address().port;
  const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done)); const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const sessions = []; const transports = []; let server; let agent; let master; let serverLog = '';
  const remoteRoot = join(root, 'home/.elevenex/desktop-remote');
  const stopServer = async () => { if (!server || server.exitCode !== null || server.signalCode !== null) return; const exited = new Promise(done => server.once('close', done)); server.kill('SIGTERM'); await exited; };
  t.after(async () => {
    if (master && master.exitCode === null && master.signalCode === null) { const exited = new Promise(resolve => master.once('close', resolve)); master.kill('SIGTERM'); await exited; }
    for (const transport of transports) await transport.close();
    for (const session of sessions) await session.stop(); await stopServer(); agent?.kill('SIGTERM');
    const processes = await run('ps', ['-axo', 'pid=,command=']);
    for (const line of processes.split('\n')) if (line.includes(` daemon ${remoteRoot} `)) process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM');
    await new Promise(done => setTimeout(done, 200)); await new Promise(done => blocker.close(done)); await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'home'));
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')]);
  // A low KDF count keeps fixture generation fast; this key is disposable.
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-a', '1', '-N', 'fixture-passphrase', '-f', join(root, 'key')]);
  await copyFile(join(root, 'key.pub'), join(root, 'authorized_keys'));
  await writeFile(join(root, 'sshd'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding yes\nAllowAgentForwarding yes\nCiphers aes256-ctr\nSetEnv HOME=${root}/home\n`);
  async function startServer() {
    serverLog = ''; server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd')], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((done, failed) => { server.once('error', failed); server.once('exit', () => failed(new Error(serverLog))); server.stderr.on('data', bytes => { serverLog += bytes; if (serverLog.includes('Server listening')) done(); }); });
  }
  try { await startServer(); }
  catch (error) { if (/privilege separation|requires.*root|Operation not permitted/.test(error.message)) return t.skip(`Non-root sshd unavailable: ${error.message.slice(0, 160)}`); throw error; }
  const config = join(root, 'client % [custom] ${literal} "quote" \\ config'); const knownHosts = join(root, 'known_hosts');
  async function writeConfig(agentPath = 'none', identity = 'key', forwarding = 'no', prefix = '') {
    await writeFile(config, `${prefix}Host target jump\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${root}/${identity}\n IdentitiesOnly yes\n IdentityAgent ${agentPath}\n UserKnownHostsFile ${knownHosts}\n StrictHostKeyChecking ask\n FingerprintHash md5\n NumberOfPasswordPrompts 2\n ExitOnForwardFailure yes\n${forwarding === null ? '' : ` ForwardAgent ${forwarding}\n`}Host target\n ProxyJump jump\n`);
  }
  await writeConfig(); const challenges = [];
  async function connect(command, interactive = true, answer = challenge => challenge.kind === 'credential' ? 'fixture-passphrase' : 'yes', overrides = {}) {
    const session = await spawnSsh({ id: 'fixture', name: 'fixture', host: 'target', configFile: config, ...overrides }, command,
      async challenge => { challenges.push(challenge); return answer(challenge); }, interactive, AbortSignal.timeout(10000), require.resolve('../dist/remote/askpass-helper.js'));
    sessions.push(session); let output = ''; session.child.stdout.on('data', bytes => { output += bytes; }); await session.exited; await session.stop(); return { output, diagnostics: session.diagnostics(), code: session.child.exitCode, signal: session.child.signalCode };
  }
  assert.equal((await connect('printf SSH_FIXTURE_OK')).output, 'SSH_FIXTURE_OK');
  assert.equal(challenges.filter(value => value.kind === 'trust').length, 1); assert.ok(challenges[0].prompt.includes('MD5:'));
  assert.equal(challenges.filter(value => value.kind === 'credential').length, 2); assert.ok((await readFile(knownHosts, 'utf8')).length > 0);
  await writeFile(config, (await readFile(config, 'utf8')).replace('StrictHostKeyChecking ask', 'StrictHostKeyChecking no').replace(knownHosts, join(root, 'native-trust-policy')));
  challenges.length = 0;
  assert.equal((await connect('printf CONFIG_TRUST_OK')).output, 'CONFIG_TRUST_OK');
  assert.equal(challenges.some(value => value.kind === 'trust'), false, 'OpenSSH applies the configured host trust policy');
  await writeConfig();
  assert.equal((await connect('printf %s "$HOME"')).output, join(root, 'home'), 'the runtime fixture must never use the personal home directory');
  const pickedIdentity = join(root, 'picked % [identity] ${literal}');
  await copyFile(join(root, 'key'), pickedIdentity);
  await writeConfig('none', 'missing-key');
  await writeFile(config, (await readFile(config, 'utf8')).replace(` Port ${port}`, ' Port 1').replace(` User ${userInfo().username}`, ' User nonexistent-fixture-user'));
  // Use a direct connection so neither a configured key nor a jump's key can
  // accidentally hide a broken explicit identity override.
  assert.equal((await connect('printf PICKED_KEY_OK', true, () => 'fixture-passphrase',
    { identityFile: pickedIdentity, host: 'jump', user: userInfo().username, port })).output, 'PICKED_KEY_OK');
  await writeConfig();
  const version = 'a'.repeat(40); const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
  const installation = join(remoteRoot, 'runtimes', `${release.tag}-${release.target}`);
  await mkdir(join(installation, 'backend/node/bin'), { recursive: true }); await symlink(process.execPath, join(installation, 'backend/node/bin/node'));
  await writeFile(join(installation, 'installation.sha256'), 'verified-fixture');
  await writeFile(join(installation, 'backend/main.cjs'), `const http=require('http');const server=http.createServer((req,res)=>{if(req.url==='/agent')require('child_process').execFile('ssh-add',['-l'],{env:process.env},(error,stdout,stderr)=>res.end(stdout+stderr));else res.end(JSON.stringify({backendSha:${JSON.stringify(version)}}));});server.listen(process.env.ELEVENEX_DESKTOP_SOCKET);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const options = { host: { id: 'fixture', name: 'fixture', host: 'target', configFile: config }, root, helper: require.resolve('../dist/remote/askpass-helper.js'),
    release, interactive: true, ask: async value => value.kind === 'credential' ? 'fixture-passphrase' : 'yes', progress: () => undefined };
  const coldStart = performance.now(); const initialRuntime = await connectRemote({ ...options, signal: AbortSignal.timeout(10000) }); transports.push(initialRuntime);
  const coldMilliseconds = performance.now() - coldStart;
  const backend = await initialRuntime.forward(0, 0); assert.equal(backend.reachable, true);
  assert.equal((await fetch(`http://127.0.0.1:${backend.port}/api/info`, { headers: { Authorization: backend.authorization } }).then(res => res.json())).backendSha, version);
  await initialRuntime.close();
  const warmStart = performance.now(); const warmRuntime = await connectRemote({ ...options, signal: AbortSignal.timeout(10000) }); transports.push(warmRuntime);
  assert.equal(warmRuntime.instance, initialRuntime.instance); await warmRuntime.close();
  t.diagnostic(`Real loopback SSH, one jump and encrypted keys: ${Math.round(coldMilliseconds)} ms new daemon; ${Math.round(performance.now() - warmStart)} ms warm reconnect (fixture backend, programmatic passphrase).`);
  challenges.length = 0;
  const badKey = await connect('true', true, () => 'wrong-fixture-passphrase'); assert.equal(sshFailure(badKey.diagnostics, 'authentication').failure.code, 'authentication'); assert.equal(challenges.length, 2, 'configured password prompt count is retained');
  await writeFile(config, (await readFile(config, 'utf8')) + 'Host *\n BatchMode yes\n'); challenges.length = 0;
  const batch = await connect('true'); assert.equal(sshFailure(batch.diagnostics, 'authentication').failure.code, 'authentication'); assert.equal(challenges.length, 0, 'interactive connect honors configured BatchMode');
  await writeConfig();
  challenges.length = 0;
  const background = await connect('true', false); assert.equal(challenges.length, 0); assert.equal(sshFailure(background.diagnostics, 'authentication').failure.code, 'authentication');
  const agentPath = join(root, 'agent.sock'); agent = spawn('ssh-agent', ['-D', '-a', agentPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, failed) => { agent.once('error', failed); agent.stdout.once('data', done); }); await writeConfig(agentPath, 'key', agentPath);
  const forwarded = await connect('ssh-add -l 2>&1; true');
  assert.match(forwarded.output, /agent has no identities/i, 'forwarding preserves the custom socket from ssh_config');
  await writeConfig(agentPath);
  assert.equal((await connect('test -z "$SSH_AUTH_SOCK" && printf AGENT_DISABLED')).output, 'AGENT_DISABLED');
  const fixtureAskpass = join(root, 'load-fixture-key');
  await writeFile(fixtureAskpass, '#!/bin/sh\nprintf "%s\\n" fixture-passphrase\n', { mode: 0o700 });
  await run('ssh-add', [join(root, 'key')], { ...process.env, SSH_AUTH_SOCK: agentPath, SSH_ASKPASS: fixtureAskpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'fixture:0' });
  await writeConfig(agentPath, 'key.pub'); challenges.length = 0;
  assert.equal((await connect('printf AGENT_AUTH_OK', false)).output, 'AGENT_AUTH_OK'); assert.equal(challenges.length, 0);
  // Local, remote and dynamic forwards remain ordinary OpenSSH configuration.
  const sockets = new Set();
  const echo = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => echo.close(resolve)); });
  const servicePort = echo.address().port; const localPort = await freePort(); const remotePort = await freePort(); const socksPort = await freePort();
  const localCommand = join(root, 'local-command');
  await writeConfig(agentPath, 'key.pub', 'no', `Host target\n LocalForward ${localPort} 127.0.0.1:${servicePort}\n RemoteForward ${remotePort} 127.0.0.1:${servicePort}\n DynamicForward ${socksPort}\n PermitLocalCommand yes\n LocalCommand printf USER_LOCAL_COMMAND > ${shellQuote(localCommand)}\n`);
  const configured = await connectRemote({ ...options, interactive: false, signal: AbortSignal.timeout(10000) }); transports.push(configured);
  assert.equal(await roundTrip(localPort, 'local-config-forward'), 'local-config-forward');
  assert.equal(await roundTrip(remotePort, 'remote-config-forward'), 'remote-config-forward');
  assert.equal(await readFile(localCommand, 'utf8'), 'USER_LOCAL_COMMAND');
  const socks = connectSocket(socksPort, '127.0.0.1'); socks.on('error', () => undefined);
  const greeting = new Promise(resolve => socks.once('data', resolve)); socks.write(Buffer.from([5, 1, 0]));
  assert.deepEqual(await greeting, Buffer.from([5, 0])); socks.destroy();
  await configured.close();
  for (const kind of ['LocalForward', 'RemoteForward']) {
    await writeConfig(agentPath, 'key.pub', 'no', `Host target\n ${kind} 127.0.0.1:${conflictPort} 127.0.0.1:${servicePort}\n`);
    const failed = await connect('true', false);
    assert.equal(sshFailure(failed.diagnostics, 'authentication').failure.code, 'configuration', failed.diagnostics);
  }
  // Existing user-owned masters can be reused and must survive app cleanup.
  const controlPath = join(root, 'master.sock');
  await writeConfig(agentPath, 'key.pub', 'no', `Host jump\n ControlMaster auto\n ControlPath ${controlPath}\n ControlPersist 90\n LogLevel DEBUG1\n`);
  assert.equal((await connect('printf DIRECT_OK', false, undefined, { host: 'jump' })).output, 'DIRECT_OK');
  await assert.rejects(access(controlPath), { code: 'ENOENT' });
  master = spawn('ssh', ['-F', config, '-M', '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-N', 'jump'], { stdio: 'ignore' });
  master.on('error', () => undefined);
  await until(() => access(controlPath).then(() => true, () => false));
  const multiplexed = await connect('printf MUX_OK', false, undefined, { host: 'jump' });
  assert.equal(multiplexed.output, 'MUX_OK'); assert.match(multiplexed.diagnostics, /mux_client_request_session|multiplexing/);
  assert.equal(master.exitCode, null); await run('ssh', ['-F', config, '-S', controlPath, '-O', 'check', 'jump']);
  const masterExited = new Promise(resolve => master.once('close', resolve)); master.kill('SIGTERM'); await masterExited;
  // Configured AddKeysToAgent ask is a confirmation, not a password prompt.
  await run('ssh-add', ['-D'], { ...process.env, SSH_AUTH_SOCK: agentPath });
  await writeConfig(agentPath, 'key', 'no', 'Host *\n AddKeysToAgent ask\n'); challenges.length = 0;
  assert.equal((await connect('printf CONFIRM_DECLINED', true, challenge => challenge.kind === 'credential' ? 'fixture-passphrase' : null)).output, 'CONFIRM_DECLINED');
  assert.ok(challenges.some(value => value.kind === 'confirmation'));
  assert.match(await run('ssh-add', ['-l'], { ...process.env, SSH_AUTH_SOCK: agentPath }).catch(error => error.message), /no identities/i);
  challenges.length = 0;
  assert.equal((await connect('printf CONFIRM_ACCEPTED')).output, 'CONFIRM_ACCEPTED');
  assert.ok(challenges.some(value => value.kind === 'confirmation'));
  assert.match(await run('ssh-add', ['-l'], { ...process.env, SSH_AUTH_SOCK: agentPath }), /ED25519/);
  await writeConfig(agentPath, 'key.pub', agentPath);
  const forwardedRuntime = await connectRemote({ ...options, interactive: false, signal: AbortSignal.timeout(10000) }); transports.push(forwardedRuntime);
  const forwardedBackend = await forwardedRuntime.forward(0, 0);
  assert.match(await fetch(`http://127.0.0.1:${forwardedBackend.port}/agent`, { headers: { Authorization: forwardedBackend.authorization } }).then(res => res.text()), /ED25519/);
  await forwardedRuntime.close();
  await writeConfig(agentPath, 'key.pub', 'yes');
  assert.match((await connect('ssh-add -l', false)).output, /ED25519/, 'ForwardAgent yes uses the configured identity agent');
  const agentVariable = 'ELEVENEX_FIXTURE_FORWARD_AGENT';
  process.env[agentVariable] = agentPath;
  try {
    await writeConfig(agentPath, 'key.pub', '${' + agentVariable + '}');
    const variableAgent = await connect('ssh-add -l', false);
    assert.match(variableAgent.output, /ED25519/, `ForwardAgent resolves configured environment variables: ${JSON.stringify(variableAgent)}`);
  } finally { delete process.env[agentVariable]; }
  await writeConfig(agentPath, 'key.pub', null, `Match final originalhost target\n ForwardAgent ${agentPath}\n`);
  assert.match((await connect('ssh-add -l', false)).output, /ED25519/, 'Match final can select forwarding without an earlier app override');
  await writeConfig(agentPath, 'key.pub', null);
  assert.equal((await connect('test -z "$SSH_AUTH_SOCK" && printf AGENT_DEFAULT')).output, 'AGENT_DEFAULT');
  await writeConfig(agentPath, 'key.pub', 'no', `Host jump\n ForwardAgent ${agentPath}\n`);
  assert.match((await connect('ssh-add -l', false, undefined, { host: 'jump' })).output, /ED25519/, 'jump hosts retain their own ForwardAgent setting');
  assert.equal((await connect('test -z "$SSH_AUTH_SOCK" && printf TARGET_AGENT_DISABLED', false)).output, 'TARGET_AGENT_DISABLED');
  await writeConfig(agentPath, 'key.pub', 'no');
  const unforwardedRuntime = await connectRemote({ ...options, interactive: false, signal: AbortSignal.timeout(10000) }); transports.push(unforwardedRuntime);
  const unforwardedBackend = await unforwardedRuntime.forward(0, 0);
  assert.doesNotMatch(await fetch(`http://127.0.0.1:${unforwardedBackend.port}/agent`, { headers: { Authorization: unforwardedBackend.authorization } }).then(res => res.text()), /ED25519/);
  await unforwardedRuntime.close();
  // A shell startup file (or server environment) may set its own agent socket.
  // Preserve the account environment as normal SSH does, without an app veto.
  const shellAgentRuntime = await connectRemote({ ...options, interactive: false, signal: AbortSignal.timeout(10000),
    spawn: (host, command, ...args) => spawnSsh(host, `SSH_AUTH_SOCK=${shellQuote(agentPath)} ${command}`, ...args),
  }); transports.push(shellAgentRuntime);
  const shellAgentBackend = await shellAgentRuntime.forward(0, 0);
  assert.match(await fetch(`http://127.0.0.1:${shellAgentBackend.port}/agent`, { headers: { Authorization: shellAgentBackend.authorization } }).then(res => res.text()), /ED25519/);
  await shellAgentRuntime.close();
  await writeFile(config, (await readFile(config, 'utf8')) + 'Host *\n Ciphers aes128-ctr\n');
  challenges.length = 0;
  const incompatibleConnection = await connect('printf UNEXPECTED_CIPHER_SUCCESS', false);
  const incompatible = sshFailure(incompatibleConnection.diagnostics, 'authentication').failure;
  assert.equal(incompatible.code, 'compatibility', JSON.stringify(incompatibleConnection)); assert.equal(incompatible.transient, false); assert.equal(challenges.length, 0);
  await writeConfig(agentPath, 'key.pub');
  // The stdio bridge must work when the server forbids SSH TCP forwarding.
  await stopServer();
  const serverConfig = await readFile(join(root, 'sshd'), 'utf8');
  await writeFile(join(root, 'sshd'), serverConfig.replace('AllowTcpForwarding yes', 'AllowTcpForwarding no').replace('AllowAgentForwarding yes', 'AllowAgentForwarding no')); await startServer();
  await writeConfig(agentPath, 'key.pub', 'yes');
  const restricted = await connectRemote({ ...options, interactive: false, host: { ...options.host, host: 'jump' }, signal: AbortSignal.timeout(10000) }); transports.push(restricted);
  const restrictedBackend = await restricted.forward(0, 0);
  assert.equal((await fetch(`http://127.0.0.1:${restrictedBackend.port}/api/info`, { headers: { Authorization: restrictedBackend.authorization } }).then(res => res.json())).backendSha, version);
  assert.doesNotMatch(await fetch(`http://127.0.0.1:${restrictedBackend.port}/agent`, { headers: { Authorization: restrictedBackend.authorization } }).then(res => res.text()), /ED25519/, 'server forwarding restrictions do not prevent SSH/backend readiness');
  await restricted.close();
  await stopServer(); await rm(join(root, 'host')); await rm(join(root, 'host.pub'));
  await writeFile(join(root, 'sshd'), serverConfig);
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')]); await startServer();
  challenges.length = 0; const changedKey = await connect('true');
  assert.equal(challenges.length, 0); assert.equal(sshFailure(changedKey.diagnostics, 'authentication').failure.code, 'host-trust');
});
