const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { URL, URLSearchParams } = require('node:url');
const { BackendClient } = require('../dist/backend-client/client');
const { TerminalPreferences } = require('../dist/backend-client/terminal-preferences');
const { terminalProfile } = require('../dist/backend-client/terminal-launch-validation');
const { parseTerminalStreamPacket } = require('../dist/backend-client/terminal-stream-validation');
const vm = require('node:vm');
const { WebSocketServer } = require('ws');
const { createServer } = require('node:http');

const until = async predicate => {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Terminal IPC condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test('trusted IPC pipelines over a private socket, validates cursors and isolates windows/scopes', async context => {
  const handlers = new Map(), ipc = {}, events = [];
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { id: 11, isDestroyed: () => false, send: (channel, event) => events.push({ channel, event }) } }] },
  }) });
  const module = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/terminal-stream'), 'utf8'), {
    exports: module, URL, URLSearchParams, Buffer, setTimeout, clearTimeout,
    require: name => name === '../ipc' ? ipc : name === 'ws' ? require('ws') : require('../dist/backend-client/' + name),
  });
  const server = createServer(), wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); return new Promise(resolve => server.close(resolve)); });
  const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const terminal = { id: 2, taskId: 1, title: 'bash', cwd: '/task', branch: 'work', generation, sequence: 4, alive: true, status: 'idle', command: '', exitCode: 0, port: null, canRerun: false };
  let socket, connections = 0; const input = [];
  wss.on('connection', (peer, request) => {
    socket = peer; connections++;
    assert.equal(request.headers['x-private-capability'], 'private');
    peer.on('message', data => input.push(JSON.parse(data.toString())));
    peer.send(JSON.stringify({ type: 'metadata', list: { taskId: 1, terminals: [terminal], scripts: [], limit: 16, streamVersion: 1 } }));
    peer.send(JSON.stringify({ type: 'output', delivery: 1, output: { terminal, generation, from: 0, next: 4, data: 'test', gap: false, more: false } }));
  });
  const target = { identity: 'one', url: `http://127.0.0.1:${server.address().port}`, version: 'a'.repeat(40), headers: { 'x-private-capability': 'private' }, environment: { kind: 'local' } };
  const client = new BackendClient(() => target, () => {}); client.attach(11); client.attach(12);
  const stop = module.registerTerminalStreamIpc(client, (frame, sender) => frame === 'main' && sender.id === 11);
  context.after(() => { stop(); client.dispose(); });
  const scope = client.state(11).scope.id, attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const request = { taskId: 1, terminalId: 2, attachmentId, generation, after: 0 };
  const writeTarget = { taskId: 1, terminalId: 2, attachmentId, generation };
  const invoke = (channel, value, id = 11, selectedScope = scope) => handlers.get(channel)({ senderFrame: 'main', sender: { id } }, selectedScope, value);
  assert.throws(() => invoke('task-terminal:attach', request, 12), /Untrusted/);
  assert.equal((await invoke('task-terminal:attach', request)).ok, true);
  assert.equal((await invoke('task-terminal:attach', request, 11, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).ok, false);
  await until(() => events.some(entry => entry.event.packet.type === 'output'));
  assert.equal(events.every(entry => entry.event.scopeId === scope && !JSON.stringify(entry).includes('private')), true);
  for (const sequence of [1, 2]) assert.equal((await invoke('task-terminal:stream-write', { ...writeTarget, sequence, kind: 'text', data: 'x' })).ok, true);
  await until(() => input.filter(frame => frame.type === 'input').length === 2);
  assert.deepEqual(input.filter(frame => frame.type === 'input').map(frame => frame.sequence), [1, 2]);
  // A duplicate output frame invalidates the connection, even when it looks
  // superficially well-formed, and outstanding input becomes explicitly unknown.
  socket.send(JSON.stringify({ type: 'output', delivery: 2, output: { terminal, generation, from: 0, next: 4, data: 'test', gap: false, more: false } }));
  await until(() => events.some(entry => entry.event.packet.type === 'closed'));
  assert.equal(events.at(-1).event.packet.uncertain, true);
  assert.equal((await invoke('task-terminal:stream-write', { ...writeTarget, sequence: 3, kind: 'text', data: 'never' })).ok, false);
  assert.equal(connections, 1, 'transport never reconnects or replays input itself');
  assert.equal(handlers.size, 7); stop(); assert.equal(handlers.size, 0);
});

test('stream leases follow scope invalidation, document reset and window cleanup', () => {
  let target = { identity: 'one', url: 'http://127.0.0.1:1', version: 'a'.repeat(40), headers: {}, environment: { kind: 'local' } };
  const client = new BackendClient(() => target, () => {});
  client.attach(1); client.attach(2);
  const first = client.lease(1, client.state(1).scope.id), second = client.lease(2, client.state(2).scope.id);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  client.reset(1); assert.equal(first.value.signal.aborted, true); assert.equal(second.value.signal.aborted, false);
  const old = client.state(2).scope.id;
  target = { ...target, identity: 'two' }; client.refreshAll();
  assert.equal(second.value.signal.aborted, true); assert.equal(client.lease(2, old).ok, false);
  const third = client.lease(2, client.state(2).scope.id);
  client.detach(2); assert.equal(third.value.signal.aborted, true); client.dispose();
});

test('profiles preserve literal arguments/removals and reject malformed or capability environment data', () => {
  const profile = { executable: '/bin/zsh', args: ['-f', 'literal $(text)'], login: false, env: { PATH: '/tools', REMOVE_ME: null } };
  assert.deepEqual(terminalProfile(profile), profile);
  for (const change of [{ args: 'shell command' }, { executable: '' }, { executable: 'bad\0shell' }, { login: 'yes' },
    { args: ['x'.repeat(4097)] }, { env: { ELEVENEX_CODE_ACCESS: 'secret' } }, { env: { 'BAD=NAME': 'value' } }])
    assert.throws(() => terminalProfile({ ...profile, ...change }));
});

test('per-machine terminal preferences save privately/atomically and preserve corrupt files', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-preferences-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'preferences.json'), store = new TerminalPreferences(file);
  const value = { prediction: 'off', profile: { executable: 'pwsh', args: [], env: { EMPTY: '' }, login: false } };
  await store.save('machine-one', value);
  assert.deepEqual(await new TerminalPreferences(file).get('machine-one'), value);
  assert.deepEqual(await store.get('machine-two'), { profile: null, prediction: 'auto' });
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes('machine-one'), false);
  await writeFile(file, 'broken');
  await assert.rejects(new TerminalPreferences(file).save('machine-one', value));
  assert.equal(await readFile(file, 'utf8'), 'broken');
});

test('stream packets validate terminal identity, bounded snapshots, geometry and metadata capabilities', () => {
  const terminal = { id: 2, taskId: 1, title: 'bash', cwd: '/task', branch: 'work', generation: 'a'.repeat(36), sequence: 10,
    alive: true, status: 'idle', command: '', exitCode: null, port: null, canRerun: false };
  const packet = { type: 'snapshot', terminal, sequence: 5, size: { cols: 80, rows: 24 }, data: 'hello', first: true, last: true, delivery: 1 };
  assert.deepEqual(parseTerminalStreamPacket(packet, 1, 2), packet);
  for (const value of [{ sequence: 11 }, { data: 'x'.repeat(32769) }, { first: 'true' }, { size: { cols: 0, rows: 24 } }, { terminal: { ...terminal, taskId: 9 } }])
    assert.throws(() => parseTerminalStreamPacket({ ...packet, ...value }, 1, 2));
  assert.throws(() => parseTerminalStreamPacket({ type: 'unknown' }, 1, 2));
});
