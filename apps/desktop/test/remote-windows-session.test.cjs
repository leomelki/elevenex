const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { RemoteConnection } = require('../dist/remote/connection');
const { backendRelease } = require('../dist/backend/release');
const { failure } = require('../dist/remote/failure');
const { healthResponseProof, queryDaemon, requestDesktopSession, verifyHealthRequest, verifySessionRequest } = require('../dist/remote/runtime-control');
const { Wire } = require('../dist/remote/wire');
const { listsProcesses } = require('../dist/remote/windows-runtime');
const version = 'a'.repeat(40);
const release = backendRelease({ version, tag: `runtime-${version}` }, process.platform, process.arch);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await delay(10); }
  assert.fail('Connection condition did not become true');
}

test('a Windows connect without a desktop sign-in asks, starts without apps on request, and switches back to the desktop', async t => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ backendSha: version })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const attempts = []; let signedIn = false; let outcome = 'signed-out'; let lose;
  const connection = new RemoteConnection({ root: '', helper: '', host: { id: 'pc', name: 'pc', host: 'pc' }, release: async () => release,
    changed: () => undefined, healthInterval: 60000, backoff: 1, random: () => 0.5,
    connect: async options => {
      attempts.push(options.allowBackgroundSession === true);
      options.progress('runtime');
      if (!signedIn && !options.allowBackgroundSession) throw failure('runtime', 'compatibility', 'Nobody is signed in to Windows on this server.', 'choose-session');
      const windowsSession = signedIn ? 'desktop' : 'background';
      const exit = deferred(); lose = exit.resolve;
      return { instance: windowsSession, remoteShell: 'windows', windowsSession, exited: exit.promise, health: async () => ({ ready: true, instance: windowsSession }),
        ...(windowsSession === 'background' ? { useDesktopSession: async () => outcome } : {}),
        forward: async () => ({ port: server.address().port, reachable: true, authorization: null, close: async () => undefined }),
        close: async () => exit.resolve() };
    },
  });
  t.after(async () => { await connection.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

  assert.throws(() => connection.allowBackgroundSession(), /no longer waiting/);
  connection.acquire(1, true);
  await until(() => connection.snapshot().phase === 'paused');
  assert.equal(connection.snapshot().failure.action, 'choose-session');
  assert.deepEqual(attempts, [false]);

  connection.allowBackgroundSession(); connection.retry(1);
  await until(() => connection.snapshot().phase === 'ready');
  assert.deepEqual(attempts, [false, true]);
  assert.equal(connection.snapshot().windowsSession, 'background');

  await assert.rejects(connection.useDesktopSession(2), /not connected/);
  assert.equal(await connection.useDesktopSession(1), 'signed-out');
  assert.equal(connection.snapshot().phase, 'ready');

  // The bridge closes after a confirmed switch; recovery must not keep the background choice.
  signedIn = true; outcome = 'switching';
  assert.equal(await connection.useDesktopSession(1), 'switching');
  lose();
  await until(() => connection.snapshot().phase === 'ready' && connection.snapshot().windowsSession === 'desktop');
  assert.equal(attempts.at(-1), false);
  await assert.rejects(connection.useDesktopSession(1), /already available/);

  // A new connect asks again rather than reusing an earlier choice.
  signedIn = false;
  await connection.release(1);
  connection.acquire(1, true);
  await until(() => connection.snapshot().phase === 'paused');
  assert.equal(attempts.at(-1), false);
});

test('only a signed, instance-bound request reaches a background daemon, and replies keep the session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'elevenex-session-'));
  const token = 'b'.repeat(64);
  const current = { version, instance: '11111111-1111-4111-8111-111111111111', ready: true, handoff: 1, session: 'background' };
  let stopped = 0;
  const daemon = createServer((req, res) => {
    const nonce = verifySessionRequest(req, token, current) ?? verifyHealthRequest(req, token);
    if (nonce === null) { res.writeHead(403).end(); return; }
    if (req.url === '/session') stopped++;
    const body = JSON.stringify(req.url === '/session' ? { ...current, ready: false } : current);
    res.setHeader('X-Elevenex-Proof', healthResponseProof(token, nonce, body)); res.end(body);
  });
  await new Promise(resolve => daemon.listen(0, '127.0.0.1', resolve));
  t.after(async () => { daemon.closeAllConnections(); await new Promise(resolve => daemon.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const port = daemon.address().port;

  assert.equal((await queryDaemon(root, port, token)).session, 'background');
  const reply = await requestDesktopSession(root, port, token, current);
  assert.equal(reply.ready, false); assert.equal(reply.session, 'background'); assert.equal(stopped, 1);
  await assert.rejects(requestDesktopSession(root, port, token, { ...current, instance: '22222222-2222-4222-8222-222222222222' }));
  await assert.rejects(requestDesktopSession(root, port, 'c'.repeat(64), current));
  assert.equal(stopped, 1);
});

test('the wire accepts the Windows session greeting and switch replies and rejects unknown values', () => {
  const frames = [
    { type: 'hello', version, instance: 'x', ready: true, agentForwarding: false, session: 'background' },
    { type: 'desktop-session', id: 1 },
    { type: 'desktop-session-result', id: 1, outcome: 'signed-out' },
  ];
  const input = new PassThrough(), output = new PassThrough(), wire = new Wire(input, output);
  const received = []; wire.on('message', frame => received.push(frame));
  for (const frame of frames) input.write(JSON.stringify(frame) + '\n');
  assert.deepEqual(received.map(frame => frame.type), frames.map(frame => frame.type));
  wire.close(); input.destroy(); output.destroy();
  for (const frame of [{ ...frames[0], session: 'service' }, { ...frames[2], outcome: 'done' }]) {
    const input = new PassThrough(), output = new PassThrough(), wire = new Wire(input, output);
    let closed = false; wire.on('closed', () => { closed = true; });
    input.write(JSON.stringify(frame) + '\n');
    assert.equal(closed, true);
    wire.close(); input.destroy(); output.destroy();
  }
});

test('desktop session detection reads tasklist CSV rows, not its localized empty notice', () => {
  assert.equal(listsProcesses('Informations : aucune tâche en service ne correspond aux critères spécifiés.\r\n'), false);
  assert.equal(listsProcesses(''), false);
  assert.equal(listsProcesses('"explorer.exe","5412","Console","1","98 304 Ko"\r\n'), true);
});
