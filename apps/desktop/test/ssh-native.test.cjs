const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { userInfo } = require('node:os');
const { spawnSsh } = require('../dist/remote/ssh');
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

test('native SSH verifies trust, encrypted keys, jumps, custom agent sockets and conflicting forwards', { timeout: 30000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX SSH server fixture');
  try { await access('/usr/sbin/sshd'); } catch { return t.skip('The host has no sshd executable'); }
  const root = await mkdtemp('/tmp/ex-native-ssh-');
  const blocker = createServer(); await new Promise(done => blocker.listen(0, '127.0.0.1', done)); const conflictPort = blocker.address().port;
  const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done)); const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const sessions = []; const transports = []; let server; let agent; let serverLog = '';
  const remoteRoot = join(root, 'home/.elevenex/desktop-remote');
  const stopServer = async () => { if (!server || server.exitCode !== null || server.signalCode !== null) return; const exited = new Promise(done => server.once('close', done)); server.kill('SIGTERM'); await exited; };
  t.after(async () => {
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
  await writeFile(join(root, 'sshd'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding yes\nAllowAgentForwarding yes\nSetEnv HOME=${root}/home\n`);
  async function startServer() {
    serverLog = ''; server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd')], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((done, failed) => { server.once('error', failed); server.once('exit', () => failed(new Error(serverLog))); server.stderr.on('data', bytes => { serverLog += bytes; if (serverLog.includes('Server listening')) done(); }); });
  }
  try { await startServer(); }
  catch (error) { if (/privilege separation|requires.*root|Operation not permitted/.test(error.message)) return t.skip(`Non-root sshd unavailable: ${error.message.slice(0, 160)}`); throw error; }
  const config = join(root, 'client % config'); const knownHosts = join(root, 'known_hosts');
  async function writeConfig(agentPath = 'none', identity = 'key') {
    await writeFile(config, `Host target jump\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${root}/${identity}\n IdentitiesOnly yes\n IdentityAgent ${agentPath}\n UserKnownHostsFile ${knownHosts}\n StrictHostKeyChecking no\n LocalForward ${conflictPort} 127.0.0.1:1\n ForwardAgent ${agentPath === 'none' ? 'yes' : agentPath}\nHost target\n ProxyJump jump\n`);
  }
  await writeConfig(); const challenges = [];
  async function connect(command, interactive = true, answer = challenge => challenge.kind === 'trust' ? 'yes' : 'fixture-passphrase', forwardAgent = false) {
    const session = await spawnSsh({ id: 'fixture', name: 'fixture', host: 'target', configFile: config, forwardAgent }, command,
      async challenge => { challenges.push(challenge); return answer(challenge); }, interactive, AbortSignal.timeout(10000), require.resolve('../dist/remote/askpass-helper.js'));
    sessions.push(session); let output = ''; session.child.stdout.on('data', bytes => { output += bytes; }); await session.exited; await session.stop(); return { output, diagnostics: session.diagnostics() };
  }
  assert.equal((await connect('printf SSH_FIXTURE_OK')).output, 'SSH_FIXTURE_OK');
  assert.equal(challenges.filter(value => value.kind === 'trust').length, 1); assert.ok(challenges[0].prompt.includes('SHA256:'));
  assert.equal(challenges.filter(value => value.kind === 'credential').length, 2); assert.ok((await readFile(knownHosts, 'utf8')).length > 0);
  assert.equal((await connect('printf %s "$HOME"')).output, join(root, 'home'), 'the runtime fixture must never use the personal home directory');
  const version = 'a'.repeat(40); const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
  const installation = join(remoteRoot, 'runtimes', `${release.tag}-${release.target}`);
  await mkdir(join(installation, 'backend/node/bin'), { recursive: true }); await symlink(process.execPath, join(installation, 'backend/node/bin/node'));
  await writeFile(join(installation, 'installation.sha256'), 'verified-fixture');
  await writeFile(join(installation, 'backend/main.cjs'), `const http=require('http');const server=http.createServer((req,res)=>{if(req.url==='/agent')require('child_process').execFile('ssh-add',['-l'],{env:process.env},(error,stdout,stderr)=>res.end(stdout+stderr));else res.end(JSON.stringify({backendSha:${JSON.stringify(version)}}));});server.listen(process.env.ELEVENEX_DESKTOP_SOCKET);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const options = { host: { id: 'fixture', name: 'fixture', host: 'target', configFile: config, forwardAgent: false }, root, helper: require.resolve('../dist/remote/askpass-helper.js'),
    release, interactive: true, ask: async value => value.kind === 'trust' ? 'yes' : 'fixture-passphrase', progress: () => undefined };
  const coldStart = performance.now(); const initialRuntime = await connectRemote({ ...options, signal: AbortSignal.timeout(10000) }); transports.push(initialRuntime);
  const coldMilliseconds = performance.now() - coldStart;
  const backend = await initialRuntime.forward(0, 0); assert.equal(backend.reachable, true);
  assert.equal((await fetch(`http://127.0.0.1:${backend.port}/api/info`, { headers: { Authorization: backend.authorization } }).then(res => res.json())).backendSha, version);
  await initialRuntime.close();
  const warmStart = performance.now(); const warmRuntime = await connectRemote({ ...options, signal: AbortSignal.timeout(10000) }); transports.push(warmRuntime);
  assert.equal(warmRuntime.instance, initialRuntime.instance); await warmRuntime.close();
  t.diagnostic(`Real loopback SSH, one jump and encrypted keys: ${Math.round(coldMilliseconds)} ms new daemon; ${Math.round(performance.now() - warmStart)} ms warm reconnect (fixture backend, programmatic passphrase).`);
  challenges.length = 0;
  const badKey = await connect('true', true, () => 'wrong-fixture-passphrase'); assert.equal(sshFailure(badKey.diagnostics, 'authentication').failure.code, 'authentication'); assert.equal(challenges.length, 1);
  challenges.length = 0;
  const background = await connect('true', false); assert.equal(challenges.length, 0); assert.equal(sshFailure(background.diagnostics, 'authentication').failure.code, 'authentication');
  const agentPath = join(root, 'agent.sock'); agent = spawn('ssh-agent', ['-D', '-a', agentPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, failed) => { agent.once('error', failed); agent.stdout.once('data', done); }); await writeConfig(agentPath);
  const forwarded = await connect('ssh-add -l 2>&1; true', true, challenge => challenge.kind === 'trust' ? 'yes' : 'fixture-passphrase', true);
  assert.match(forwarded.output, /agent has no identities/i, 'forwarding preserves the custom socket from ssh_config');
  assert.equal((await connect('test -z "$SSH_AUTH_SOCK" && printf AGENT_DISABLED')).output, 'AGENT_DISABLED');
  const fixtureAskpass = join(root, 'load-fixture-key');
  await writeFile(fixtureAskpass, '#!/bin/sh\nprintf "%s\\n" fixture-passphrase\n', { mode: 0o700 });
  await run('ssh-add', [join(root, 'key')], { ...process.env, SSH_AUTH_SOCK: agentPath, SSH_ASKPASS: fixtureAskpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'fixture:0' });
  await writeConfig(agentPath, 'key.pub'); challenges.length = 0;
  assert.equal((await connect('printf AGENT_AUTH_OK', false)).output, 'AGENT_AUTH_OK'); assert.equal(challenges.length, 0);
  const forwardedRuntime = await connectRemote({ ...options, interactive: false, host: { ...options.host, forwardAgent: true }, signal: AbortSignal.timeout(10000) }); transports.push(forwardedRuntime);
  const forwardedBackend = await forwardedRuntime.forward(0, 0);
  assert.match(await fetch(`http://127.0.0.1:${forwardedBackend.port}/agent`, { headers: { Authorization: forwardedBackend.authorization } }).then(res => res.text()), /ED25519/);
  await forwardedRuntime.close();
  const unforwardedRuntime = await connectRemote({ ...options, interactive: false, signal: AbortSignal.timeout(10000) }); transports.push(unforwardedRuntime);
  const unforwardedBackend = await unforwardedRuntime.forward(0, 0);
  assert.doesNotMatch(await fetch(`http://127.0.0.1:${unforwardedBackend.port}/agent`, { headers: { Authorization: unforwardedBackend.authorization } }).then(res => res.text()), /ED25519/);
  await unforwardedRuntime.close();
  await stopServer(); await rm(join(root, 'host')); await rm(join(root, 'host.pub'));
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')]); await startServer();
  challenges.length = 0; const changedKey = await connect('true');
  assert.equal(challenges.length, 0); assert.equal(sshFailure(changedKey.diagnostics, 'authentication').failure.code, 'host-trust');
});
