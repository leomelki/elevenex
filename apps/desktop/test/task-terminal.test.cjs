const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');
const { URLSearchParams } = require('node:url');
const { createServer } = require('node:http');
const { BackendClient } = require('../dist/backend-client/client');
const { parseTaskTerminal, parseTerminalList, parseTerminalOutput } = require('../dist/backend-client/task-terminal');
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const terminal = { id: 2, taskId: 1, title: 'bash', cwd: '/task/worktree', branch: 'work', generation, sequence: 4, alive: true, status: 'idle', command: '', exitCode: 0, port: null, canRerun: false };

test('terminal replies validate task, generation, ordered offsets and bounds', () => {
  assert.deepEqual(parseTaskTerminal(terminal, 1, 2), terminal);
  const output = { terminal, generation, from: 0, next: 4, data: 'test', gap: false, more: false };
  assert.deepEqual(parseTerminalOutput(output, 1, 2), output);
  for (const raw of [{ ...output, terminal: { ...terminal, taskId: 9 } }, { ...output, next: 5 }, { ...output, generation: null }, { ...output, from: -1 }, { ...output, more: true }, { ...output, data: 'a'.repeat(32769) }]) assert.throws(() => parseTerminalOutput(raw, 1, 2));
  assert.throws(() => parseTerminalList({ taskId: 1, terminals: [terminal, terminal], scripts: [], limit: 16 }, 1));
  assert.throws(() => parseTaskTerminal({ ...terminal, status: 'serving' }, 1));
  assert.throws(() => parseTaskTerminal({ ...terminal, protocol: 'file' }, 1));
});

test('named terminal IPC keeps credentials/main scope, validates inputs and never replays mutations', async context => {
  const handlers = new Map(), ipc = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) } }) });
  const module = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/task-terminal'), 'utf8'), { exports: module, URLSearchParams, Buffer, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name) });
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, method: req.method, auth: req.headers['x-capability'] });
    const chunks = []; for await (const data of req) chunks.push(data);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/output')) res.end(JSON.stringify({ terminal, generation, from: 0, next: 4, data: 'test', gap: true, more: false }));
    else if (req.method === 'POST' && body.type === 'input') { res.destroy(); }
    else res.end(JSON.stringify({ taskId: 1, terminals: [terminal], scripts: [], limit: 16 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let target = { identity: 'one', url, version: 'a'.repeat(40), headers: { 'x-capability': 'private' }, environment: { kind: 'local' } };
  const client = new BackendClient(() => target, () => {}); client.attach(11); client.attach(12); context.after(() => client.dispose());
  const stop = module.registerTaskTerminalIpc(client, (frame, sender) => frame === 'main' && sender.id === 11);
  const event = { senderFrame: 'main', sender: { id: 11 } }, scope = client.state(11).scope.id;
  const list = handlers.get('task-terminal:list'), read = handlers.get('task-terminal:read'), input = handlers.get('task-terminal:input');
  assert.throws(() => list({ senderFrame: 'sub', sender: { id: 11 } }, scope, 1), /Untrusted/);
  for (const bad of [0, -1, 1.5, '1', Infinity]) assert.throws(() => list(event, scope, bad));
  assert.throws(() => input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'x'.repeat(32769) }));
  assert.throws(() => input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'hi', path: '/evil' }));
  assert.equal((await list(event, client.state(12).scope.id, 1)).error.code, 'stale-scope'); assert.equal(requests.length, 0);
  assert.equal((await list(event, scope, 1)).value.terminals[0].cwd, '/task/worktree');
  assert.equal((await read(event, scope, { taskId: 1, terminalId: 2, generation: null, after: 0 })).value.next, 4);
  assert.equal((await input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'hello\r' })).error.code, 'outcome-unknown');
  assert.equal(requests.filter(req => req.method === 'POST').length, 1);
  assert.ok(requests.every(req => req.auth === 'private'));
  target = { ...target, identity: 'two' }; client.refresh(11);
  assert.equal((await list(event, scope, 1)).error.code, 'stale-scope');
  stop(); assert.equal(handlers.size, 0);
});

test('serving port handoff uses the actual managed remote forward and cleans its observer', async context => {
  const handlers = new Map(), ipc = {}, module = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/terminal-ports'), 'utf8'), { exports: module, setTimeout, clearTimeout, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name) });
  const row = { ...terminal, status: 'serving', port: 3000, protocol: 'https' };
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ terminal: row, generation, from: 0, next: 4, data: 'test', gap: true, more: false })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = { url: `http://127.0.0.1:${server.address().port}`, version: 'a'.repeat(40), headers: {} };
  let forwards = [], subscriptions = 0, added = 0, retried = 0;
  const opened = [], controller = new AbortController();
  const remote = { snapshot: () => ({ forwards }), addForward: async (_window, input) => { added++; assert.equal(input.remotePort, 3000); assert.equal(input.localPort, 0); forwards = [{ id: 'saved', remotePort: 3000, phase: 'listening', boundPort: 49321 }]; }, retryForward: async (_window, id) => { assert.equal(id, 'saved'); retried++; forwards = [{ id, remotePort: 3000, phase: 'listening', boundPort: 49322 }]; }, subscribe: () => { subscriptions++; return () => { subscriptions--; }; } };
  const client = { state: () => ({ scope: { id: generation, environment: { kind: 'remote', hostId: 'remote' } } }), execute: async (_window, _scope, _key, _mutation, operation) => operation(endpoint, controller.signal) };
  const stop = module.registerTerminalPorts(client, remote, () => true, async url => { opened.push(url); });
  const handler = handlers.get('task-terminal:open-port'), event = { senderFrame: {}, sender: { id: 11 } };
  await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 });
  assert.deepEqual(opened, ['https://127.0.0.1:49321/']); assert.equal(added, 1); assert.equal(subscriptions, 0);
  await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 }); assert.equal(added, 1);
  forwards = [{ id: 'saved', remotePort: 3000, phase: 'unavailable', boundPort: null }];
  await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 });
  assert.equal(retried, 1); assert.equal(opened.at(-1), 'https://127.0.0.1:49322/'); assert.equal(subscriptions, 0);
  await assert.rejects(handler(event, generation, { taskId: 1, terminalId: 2, port: 9999 })); assert.equal(opened.length, 3);
  stop(); assert.equal(handlers.size, 0);
});
