const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { createSocket } = require('node:dgram');
const { EventEmitter } = require('node:events');
const { mkdir, mkdtemp, readFile, rm, symlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const processes = require('node:child_process');
const control = require('../dist/remote/runtime-control');
const { ensureDaemon } = require('../dist/remote/runtime-start');
const { connectRemote } = require('../dist/remote/bootstrap');
const { backendRelease } = require('../dist/backend/release');
const { prepareReplacement, publishReplacement } = require('../dist/remote/runtime-handoff');

const version = 'a'.repeat(40); const target = 'b'.repeat(40); const other = 'c'.repeat(40);
const token = randomBytes(32).toString('hex');
const old = { version, instance: 'old-instance', ready: true, handoff: 1 };
const current = { version: target, instance: 'new-instance', ready: true, handoff: 1 };
const startup = { root: '/fixture', installation: '/fixture/runtime', version: target, port: 22222, token,
  lease: { id: 'lease', agent: null }, runtime: '/fixture/runtime.js', allowUpdate: true };

function startupFixture(t, replies, handoff = async () => ({ ...old, ready: false, replacement: target })) {
  let reads = 0; let stops = 0; let starts = 0;
  t.mock.method(control, 'queryDaemon', async () => {
    const value = replies[Math.min(reads++, replies.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  });
  t.mock.method(control, 'requestHandoff', async (...args) => { stops++; return handoff(...args); });
  t.mock.method(processes, 'spawn', () => { starts++; return Object.assign(new EventEmitter(), { unref() {} }); });
  return { reads: () => reads, stops: () => stops, starts: () => starts };
}

test('handoff proofs bind method, path, time, instance and both revisions without sending the token', () => {
  const time = String(Date.now()); const nonce = randomBytes(32).toString('hex');
  const headers = { 'x-elevenex-time': time, 'x-elevenex-nonce': nonce, 'x-elevenex-instance': old.instance,
    'x-elevenex-version': version, 'x-elevenex-target': target,
    'x-elevenex-proof': createHmac('sha256', token).update(`handoff:${time}:${nonce}:${old.instance}:${version}:${target}`).digest('hex') };
  const req = { method: 'POST', url: '/handoff', headers };
  assert.deepEqual(control.verifyHandoffRequest(req, token, old), { nonce, target });
  assert.equal(JSON.stringify(req).includes(token), false);
  for (const changed of [{ method: 'GET' }, { url: '/health' }, { url: '/handoff?target=other' }]) {
    assert.equal(control.verifyHandoffRequest({ ...req, ...changed }, token, old), null);
  }
  for (const [name, value] of Object.entries({ 'x-elevenex-time': String(Date.now() - 20000), 'x-elevenex-nonce': randomBytes(32).toString('hex'),
    'x-elevenex-instance': 'replaced-instance', 'x-elevenex-version': other, 'x-elevenex-target': other, 'x-elevenex-proof': '0'.repeat(64) })) {
    assert.equal(control.verifyHandoffRequest({ ...req, headers: { ...headers, [name]: value } }, token, old), null, name);
  }
  assert.equal(control.verifyHandoffRequest(req, token, current), null);
  assert.equal(control.verifyHealthRequest(req, token), null);
});

test('warm startup joins the current revision without shutdown or another process', async t => {
  const fixture = startupFixture(t, [{ ...current, ready: false }, current]);
  assert.deepEqual(await ensureDaemon(startup), current);
  assert.equal(fixture.stops(), 0); assert.equal(fixture.starts(), 0);
});

test('background reconnect and legacy daemons never authorize destructive replacement', async t => {
  const fixture = startupFixture(t, [old]);
  await assert.rejects(ensureDaemon({ ...startup, allowUpdate: false }), /explicit connection required/);
  control.queryDaemon.mock.mockImplementation(async () => ({ version, instance: old.instance, ready: true }));
  await assert.rejects(ensureDaemon(startup), /legacy daemon requires one manual stop/);
  assert.equal(fixture.stops(), 0); assert.equal(fixture.starts(), 0);
});

test('lost handoff replies are reconciled without replay, and startup waits for the old listener to leave', async t => {
  const fixture = startupFixture(t, [old, { ...old, ready: false, replacement: target }, new Error('closed'), current], async () => { throw new Error('reply lost'); });
  assert.deepEqual(await ensureDaemon(startup), current);
  assert.equal(fixture.stops(), 1); assert.equal(fixture.starts(), 0);
});

test('background recovery can finish an already accepted update to its expected revision', async t => {
  const fixture = startupFixture(t, [{ ...old, ready: false, replacement: target }, new Error('closed'), current]);
  assert.deepEqual(await ensureDaemon({ ...startup, allowUpdate: false }), current);
  assert.equal(fixture.stops(), 0); assert.equal(fixture.starts(), 0);
});

test('a signed handoff rejection reports preparation failure without retrying shutdown', async t => {
  const fixture = startupFixture(t, [old], async () => old);
  await assert.rejects(ensureDaemon(startup), /handoff rejected/);
  assert.equal(fixture.stops(), 1); assert.equal(fixture.starts(), 0);
});

test('replacement descriptors confine the revision, runtime cache and uploaded shim', async t => {
  const root = await mkdtemp('/tmp/ex-handoff-plan-'); t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'runtimes', `runtime-${target}-linux-x64`);
  const client = 'd'.repeat(64); const runtime = join(root, 'clients', client, 'runtime.js');
  await mkdir(join(installation, 'backend/node/bin'), { recursive: true }); await mkdir(join(root, 'clients', client), { recursive: true });
  for (const path of [runtime, join(installation, 'backend/node/bin/node'), join(installation, 'backend/main.cjs'), join(installation, 'installation.sha256')]) await writeFile(path, 'fixture');
  await publishReplacement(root, installation, runtime, target);
  assert.deepEqual(await prepareReplacement(root, target), { installation, runtime, executable: join(installation, 'backend/node/bin/node'), version: target });
  const path = join(root, `handoff-${target}.json`);
  for (const value of [{ client: '../outside', installation: `runtime-${target}-linux-x64` }, { client, installation: '../../outside' },
    { client, installation: `runtime-${version}-linux-x64` }, { client, installation: `runtime-${target}-windows-x64` }]) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(prepareReplacement(root, target), /Invalid replacement descriptor/);
  }
  await assert.rejects(prepareReplacement(root, '../outside'), /Invalid replacement revision/);
  await writeFile(path, 'x'.repeat(1025)); await assert.rejects(prepareReplacement(root, target), /Invalid replacement descriptor/);
  await publishReplacement(root, installation, runtime, target);
  await rm(join(installation, 'installation.sha256')); await assert.rejects(prepareReplacement(root, target), /ENOENT/);
});

for (const situation of ['pending', 'reply', 'replacement', 'startup']) test(`competing revisions cannot steal a ${situation} handoff`, async t => {
  const competing = { ...old, replacement: other, ready: false };
  const replies = situation === 'pending' ? [competing] : situation === 'replacement' ? [old, { ...competing, instance: 'another-instance' }]
    : situation === 'startup' ? [new Error('vacant'), { ...competing, replacement: undefined }] : [old];
  const fixture = startupFixture(t, replies, async () => situation === 'reply' ? competing : { ...old, replacement: target, ready: false });
  await assert.rejects(ensureDaemon(startup), /competing revision/);
  assert.equal(fixture.stops(), situation === 'reply' || situation === 'replacement' ? 1 : 0);
  assert.equal(fixture.starts(), situation === 'startup' ? 1 : 0);
});

test('a timed-out shutdown never retries its mutation or launches over a live daemon', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const fixture = startupFixture(t, [old], async () => { now = 45001; throw new Error('unknown outcome'); });
  await assert.rejects(ensureDaemon(startup), /handoff timed out/);
  assert.equal(fixture.stops(), 1); assert.equal(fixture.starts(), 0);
});

async function until(read, accepts, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (accepts(value)) return value; await delay(20); }
  assert.fail('Remote update condition did not arrive');
}

test('real remote handoff preserves data, coalesces clients, fences old bridges and recovers interrupted startup', { timeout: 45000 }, async t => {
  if (process.platform === 'win32') return t.skip('POSIX remote daemon');
  const home = await mkdtemp('/tmp/ex-update-'); const root = join(home, '.elevenex/desktop-remote');
  const bin = join(home, 'bin'); await mkdir(bin); await mkdir(join(root, 'data'), { recursive: true });
  // Skip optional server downloads, keeping this lifecycle test fully offline.
  await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await writeFile(join(root, 'data/keep'), 'durable user data');
  const children = []; const transports = [];
  const spawnFixture = async (_host, command, _ask, _interactive, signal) => {
    const child = processes.spawn('sh', ['-c', command], { cwd: home, detached: true, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); let diagnostics = '';
    child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-16384); });
    const exited = new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
    const stop = async () => { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM'); await exited; };
    const aborted = () => { void stop(); };
    signal.addEventListener('abort', aborted, { once: true });
    void exited.then(() => signal.removeEventListener('abort', aborted));
    return { child, exited, diagnostics: () => diagnostics, stop };
  };
  const runtimeToken = () => readFile(join(root, 'control-token'), 'utf8');
  t.after(async () => {
    for (const transport of transports) await transport.close();
    for (const child of children) child.kill('SIGTERM');
    const secret = await runtimeToken().catch(() => '');
    // The fixture owns these persistent daemons, including transferred ones.
    const listing = await new Promise(resolve => {
      const child = processes.spawn('ps', ['-axo', 'pid=,command=']); let body = '';
      child.stdout.on('data', bytes => { body += bytes; }); child.once('close', () => resolve(body));
    });
    for (const line of listing.split('\n')) {
      if (line.includes(`runtime.js daemon ${root} `) || line.includes(`runtime.js handoff ${root} `)) process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM');
    }
    await until(() => control.queryDaemon(root, 1, secret).catch(() => null), value => value === null);
    await rm(home, { recursive: true, force: true });
  });
  const releaseFor = value => backendRelease({ version: value, tag: `runtime-${value}` }, process.platform, process.arch);
  const install = async (value, ignoreTerm = false, gated = false) => {
    const release = releaseFor(value); const directory = join(root, 'runtimes', `${release.tag}-${release.target}`);
    await mkdir(join(directory, 'backend/node/bin'), { recursive: true });
    await symlink(process.execPath, join(directory, 'backend/node/bin/node'));
    await writeFile(join(directory, 'installation.sha256'), 'fixture');
    await writeFile(join(directory, 'backend/main.cjs'), `
      const fs=require('fs'),http=require('http'),path=require('path');
      const data=process.env.ELEVENEX_DATA_ROOT,owner=path.join(data,'owner'),events=path.join(data,'events');
      const event=kind=>fs.appendFileSync(events,JSON.stringify({kind,version:${JSON.stringify(value)},pid:process.pid})+'\\n');
      if(fs.existsSync(owner)){const pid=Number(fs.readFileSync(owner,'utf8'));let live=false;try{process.kill(pid,0);live=true;}catch{}if(live){event('overlap');process.exit(2);}}
      fs.writeFileSync(owner,String(process.pid));event('start');
      const server=http.createServer((req,res)=>res.end(JSON.stringify({backendSha:${gated ? `(fs.existsSync(path.join(data,'ready'))?${JSON.stringify(value)}:'0'.repeat(40))` : JSON.stringify(value)},pid:process.pid,keep:fs.readFileSync(path.join(data,'keep'),'utf8')})));
      server.listen(process.env.ELEVENEX_DESKTOP_SOCKET);
      process.on('SIGTERM',()=>{event('term');if(${ignoreTerm})return;server.close(()=>process.exit(0));});
    `);
    return release;
  };
  const options = { host: { id: 'fixture', name: 'Fixture', host: 'fixture' }, root: home, helper: '', interactive: true,
    ask: async () => null, progress: () => undefined, spawn: spawnFixture };
  const connect = async (release, overrides = {}) => {
    const transport = await connectRemote({ ...options, release, signal: AbortSignal.timeout(15000), ...overrides });
    transports.push(transport); return transport;
  };
  const info = async transport => {
    const forward = await transport.forward(0, 0);
    try { return await fetch(`http://127.0.0.1:${forward.port}/api/info`, { headers: { Authorization: forward.authorization }, signal: AbortSignal.timeout(3000) }).then(res => res.json()); }
    finally { await forward.close(); }
  };
  const events = async () => (await readFile(join(root, 'data/events'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  t.diagnostic('Starting the original daemon.');
  const original = await connect(await install(version, true)); const before = await info(original);
  const secret = await runtimeToken(); const health = await control.queryDaemon(root, 1, secret);
  await assert.rejects(control.requestHandoff(root, 1, '0'.repeat(64), health, target));
  await assert.rejects(control.requestHandoff(root, 1, secret, { ...health, instance: 'stale-instance' }, target));
  assert.equal((await control.requestHandoff(root, 1, secret, health, 'f'.repeat(40))).replacement, undefined);
  assert.equal((await info(original)).pid, before.pid);

  t.diagnostic('Checking preparation failure.');
  await assert.rejects(connect(releaseFor('d'.repeat(40)), { prepareArchive: async () => { throw new Error('fixture download failed'); } }), /fixture download failed/);
  assert.equal((await info(original)).pid, before.pid, 'preparation failure must leave the old backend running');

  t.diagnostic('Updating with concurrent clients.');
  const nextRelease = await install(target);
  const port = 20000 + createHash('sha256').update(`${home}:${process.getuid?.() ?? ''}:elevenex-desktop`).digest().readUInt32BE(0) % 20000;
  let watching = true; let vacant = false;
  const watcher = (async () => {
    while (watching) {
      vacant ||= await new Promise(resolve => {
        const socket = createSocket('udp4');
        socket.once('error', () => { socket.close(); resolve(false); });
        socket.bind({ port, address: '127.0.0.1', exclusive: true }, () => { socket.close(); resolve(true); });
      });
      await delay(5);
    }
  })();
  let first; let second;
  try { [first, second] = await Promise.all([connect(nextRelease), connect(nextRelease)]); }
  finally { watching = false; await watcher; }
  assert.equal(vacant, false, 'ownership must remain reserved throughout shutdown and daemon replacement');
  const after = await info(first);
  assert.equal(after.backendSha, target); assert.equal(after.keep, 'durable user data');
  assert.equal(second.instance, first.instance); assert.notEqual(first.instance, original.instance);
  assert.equal((await info(second)).pid, after.pid);
  assert.throws(() => process.kill(before.pid, 0), { code: 'ESRCH' }, 'forced shutdown must finish before replacement startup');
  const retired = await original.forward(0, 0); assert.equal(retired.reachable, false); await retired.close();
  assert.equal((await original.health(AbortSignal.timeout(3000))).ready, false);
  await assert.rejects(connect(releaseFor(version), { interactive: false }), error => error.failure?.code === 'compatibility' && /Choose Retry/.test(error.message));
  assert.equal((await info(first)).pid, after.pid, 'an older desktop recovery must not replace the new backend');

  t.diagnostic('Interrupting replacement startup.');
  const gated = await install(other, false, true);
  await assert.rejects(connect(gated, { signal: AbortSignal.timeout(2500) }), /abort|timeout/i);
  assert.throws(() => process.kill(after.pid, 0), { code: 'ESRCH' });
  const unready = await control.queryDaemon(root, 1, secret);
  assert.equal(unready.version, other); assert.equal(unready.ready, false);
  await writeFile(join(root, 'data/ready'), 'ready');
  const recovered = await connect(gated, { interactive: false });
  assert.equal((await info(recovered)).backendSha, other);
  const log = await events();
  assert.equal(log.filter(event => event.kind === 'start').length, 3);
  assert.equal(log.some(event => event.kind === 'overlap'), false);
  assert.equal(await readFile(join(root, 'data/keep'), 'utf8'), 'durable user data');
});
