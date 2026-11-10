const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');
const { URLSearchParams } = require('node:url');
const { createServer } = require('node:http');
const { BackendClient } = require('../dist/backend-client/client');
const { TerminalLifetime } = require('../dist/backend-client/terminal-lifetime');
const { parseTaskTerminal, parseTerminalList, parseTerminalOutput } = require('../dist/backend-client/task-terminal');
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const terminal = { id: 2, taskId: 1, title: 'bash', cwd: '/task/worktree', branch: 'work', generation, sequence: 4, alive: true, status: 'idle', command: '', exitCode: 0, port: null, canRerun: false };

test('local echo prompt grants are bounded, caught up and require a live integrated process', () => {
  const output = { terminal: { ...terminal, shellIntegration: 'active' }, generation, from: 0, next: 4, data: 'test', gap: false, more: false, inputPreview: { prompt: 2 } };
  assert.deepEqual(parseTerminalOutput(output, 1, 2), output);
  for (const inputPreview of [null, {}, { prompt: 0 }, { prompt: -1 }, { prompt: 5 }, { prompt: '2' }, { prompt: 1.5 }])
    assert.throws(() => parseTerminalOutput({ ...output, inputPreview }, 1, 2));
  for (const overrides of [{ alive: false }, { shellIntegration: undefined }, { shellIntegration: 'disabled' }, { sequence: 8 }])
    assert.throws(() => parseTerminalOutput({ ...output, terminal: { ...output.terminal, ...overrides }, ...(overrides.sequence ? { more: true } : {}) }, 1, 2));
});

test('terminal replies validate task, generation, ordered offsets and bounds', () => {
  assert.deepEqual(parseTaskTerminal(terminal, 1, 2), terminal);
  const output = { terminal, generation, from: 0, next: 4, data: 'test', gap: false, more: false };
  assert.deepEqual(parseTerminalOutput(output, 1, 2), output);
  const sized = { ...output, size: { cols: 80, rows: 24 } };
  assert.deepEqual(parseTerminalOutput(sized, 1, 2), sized);
  for (const size of [null, {}, { cols: 0, rows: 24 }, { cols: 501, rows: 24 }, { cols: 80, rows: 301 }, { cols: 80, rows: 1.5 }, { cols: '80', rows: 24 }])
    assert.throws(() => parseTerminalOutput({ ...output, size }, 1, 2));
  for (const raw of [{ ...output, terminal: { ...terminal, taskId: 9 } }, { ...output, next: 5 }, { ...output, generation: null }, { ...output, from: -1 }, { ...output, more: true }, { ...output, data: 'a'.repeat(32769) }]) assert.throws(() => parseTerminalOutput(raw, 1, 2));
  assert.throws(() => parseTerminalList({ taskId: 1, terminals: [terminal, terminal], scripts: [], limit: 16 }, 1));
  assert.throws(() => parseTaskTerminal({ ...terminal, status: 'serving' }, 1));
  assert.throws(() => parseTaskTerminal({ ...terminal, protocol: 'file' }, 1));
  for (const shellIntegration of ['pending', 'active', 'disabled', 'unsupported', 'unavailable'])
    assert.equal(parseTaskTerminal({ ...terminal, shellIntegration }, 1).shellIntegration, shellIntegration);
  assert.throws(() => parseTaskTerminal({ ...terminal, shellIntegration: 'ready' }, 1));
  assert.equal(parseTerminalList({ taskId: 1, terminals: [], scripts: [], limit: 16, shellIntegrationControl: true }, 1).shellIntegrationControl, true);
  assert.throws(() => parseTerminalList({ taskId: 1, terminals: [], scripts: [], limit: 16, shellIntegrationControl: 'yes' }, 1));
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
    requests.at(-1).body = body;
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/commands')) res.end(JSON.stringify({ taskId: 1, terminalId: 2, generation, commands: [], current: null, next: 0, gap: false, more: false }));
    else if (req.url.includes('/output')) res.end(JSON.stringify({ terminal, generation, from: 0, next: 4, data: 'test', gap: true, more: false }));
    else if (req.method === 'POST' && body.type === 'input') { res.destroy(); }
    else if (req.method === 'POST') res.end(JSON.stringify(terminal));
    else res.end(JSON.stringify({ taskId: 1, terminals: [terminal], scripts: [], limit: 16 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  let target = { identity: 'one', url, version: 'a'.repeat(40), headers: { 'x-capability': 'private' }, environment: { kind: 'local' } };
  const client = new BackendClient(() => target, () => {}); client.attach(11); client.attach(12); context.after(() => client.dispose());
  const lifetime = new TerminalLifetime();
  const stop = module.registerTaskTerminalIpc(client, (frame, sender) => frame === 'main' && sender.id === 11, lifetime);
  const event = { senderFrame: 'main', sender: { id: 11 } }, scope = client.state(11).scope.id;
  const list = handlers.get('task-terminal:list'), read = handlers.get('task-terminal:read'), input = handlers.get('task-terminal:input');
  assert.throws(() => list({ senderFrame: 'sub', sender: { id: 11 } }, scope, 1), /Untrusted/);
  for (const bad of [0, -1, 1.5, '1', Infinity]) assert.throws(() => list(event, scope, bad));
  assert.throws(() => input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'x'.repeat(32769) }));
  assert.throws(() => input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'hi', path: '/evil' }));
  assert.equal((await list(event, client.state(12).scope.id, 1)).error.code, 'stale-scope'); assert.equal(requests.length, 0);
  assert.equal((await list(event, scope, 1)).value.terminals[0].cwd, '/task/worktree');
  assert.equal((await read(event, scope, { taskId: 1, terminalId: 2, generation: null, after: 0 })).value.next, 4);
  const commands = handlers.get('task-terminal:commands');
  assert.throws(() => commands(event, scope, { taskId: 1, terminalId: 2, generation, after: -1 }));
  assert.throws(() => commands(event, scope, { taskId: 1, terminalId: 2, generation, after: 0, command: 'injected' }));
  const commandPage = await commands(event, scope, { taskId: 1, terminalId: 2, generation, after: 0 });
  assert.equal(commandPage.ok, true);
  assert.equal(commandPage.value.next, 0);
  assert.equal((await commands(event, scope, { taskId: 1, terminalId: 2, generation, after: 1 })).error.code, 'invalid-response');
  const create = handlers.get('task-terminal:create');
  assert.throws(() => create(event, scope, { taskId: 1, owner: generation }));
  assert.equal((await create(event, scope, { taskId: 1 })).value.id, terminal.id);
  assert.deepEqual(requests.at(-1).body, { owner: lifetime.owner });
  assert.throws(() => create(event, scope, { taskId: 1, shellIntegration: 'off' }));
  assert.equal((await create(event, scope, { taskId: 1, shellIntegration: false })).value.id, terminal.id);
  assert.deepEqual(requests.at(-1).body, { owner: lifetime.owner, shellIntegration: false });
  assert.equal((await input(event, scope, { taskId: 1, terminalId: 2, generation, data: 'hello\r' })).error.code, 'outcome-unknown');
  assert.equal(requests.filter(req => req.method === 'POST').length, 3);
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
  let forwards = [], subscriptions = 0, added = 0, retried = 0, copyFails = false;
  const opened = [], copied = [], controller = new AbortController();
  const remote = { snapshot: () => ({ forwards }), addForward: async (_window, input, host) => { added++; assert.equal(input.remotePort, 3000); assert.equal(input.localPort, 0); assert.equal(host, '127.0.0.1'); forwards = [{ id: 'saved', remotePort: 3000, phase: 'listening', boundPort: 49321 }]; }, targetForward: async () => false, retryForward: async (_window, id) => { assert.equal(id, 'saved'); retried++; forwards = [{ id, remotePort: 3000, phase: 'listening', boundPort: 49322 }]; }, subscribe: () => { subscriptions++; return () => { subscriptions--; }; } };
  const client = { state: () => ({ scope: { id: generation, environment: { kind: 'remote', hostId: 'remote' } } }), execute: async (_window, _scope, _key, _mutation, operation) => operation(endpoint, controller.signal) };
  const stop = module.registerTerminalPorts(client, remote, () => true, async url => { opened.push(url); }, url => { if (copyFails) throw new Error('Clipboard denied'); copied.push(url); });
  const handler = handlers.get('task-terminal:open-port'), event = { senderFrame: {}, sender: { id: 11 } };
  const resolve = handlers.get('task-terminal:copy-port');
  const resolved = await resolve(event, generation, { taskId: 1, terminalId: 2, port: 3000 });
  assert.equal(resolved.url, 'https://127.0.0.1:49321/');
  assert.deepEqual(opened, [], 'Resolving for Copy must not open the browser');
  assert.deepEqual(copied, ['https://127.0.0.1:49321/']);
  assert.equal(added, 1); assert.equal(subscriptions, 0);
  await assert.rejects(resolve(event, generation, { taskId: 1, terminalId: 2, port: 0 }));
  await assert.rejects(resolve(event, generation, { taskId: 1, terminalId: 2, port: 3000, url: 'https://example.com' }));
  await assert.rejects(resolve(event, generation, { taskId: 1, terminalId: 2, port: 9999 }));
  assert.equal(copied.length, 1, 'Invalid services must never overwrite the clipboard');
  copyFails = true;
  await assert.rejects(resolve(event, generation, { taskId: 1, terminalId: 2, port: 3000 }), /Clipboard denied/);
  assert.equal(copied.length, 1); assert.equal(opened.length, 0);
  copyFails = false;
  const openedService = await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 });
  assert.equal(openedService.url, 'https://127.0.0.1:49321/');
  assert.deepEqual(opened, ['https://127.0.0.1:49321/']); assert.equal(added, 1); assert.equal(subscriptions, 0);
  await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 }); assert.equal(added, 1);
  forwards = [{ id: 'saved', remotePort: 3000, phase: 'unavailable', boundPort: null }];
  await handler(event, generation, { taskId: 1, terminalId: 2, port: 3000 });
  assert.equal(retried, 1); assert.equal(opened.at(-1), 'https://127.0.0.1:49322/'); assert.equal(subscriptions, 0);
  await assert.rejects(handler(event, generation, { taskId: 1, terminalId: 2, port: 9999 })); assert.equal(opened.length, 3);
  stop(); assert.equal(handlers.size, 0);
});

test('app cleanup uses its private launch owner and latest engine endpoint exactly once', async context => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, auth: req.headers['x-capability'] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const lifetime = new TerminalLifetime();
  const endpoint = { url: `http://127.0.0.1:${server.address().port}`, version: 'a'.repeat(40), headers: { 'x-capability': 'private' } };
  lifetime.track({ ...endpoint, url: 'http://127.0.0.1:1' }, 'remote:machine');
  lifetime.track(endpoint, 'remote:machine');
  const cleanup = lifetime.close();
  assert.equal(lifetime.close(), cleanup);
  assert.throws(() => lifetime.track(endpoint), /closing/);
  await cleanup;
  assert.deepEqual(requests, [{ method: 'DELETE', path: `/api/desktop-workspace/terminal-owners/${lifetime.owner}`, auth: 'private' }]);
  assert.notEqual(new TerminalLifetime().owner, lifetime.owner);
});

test('command tracking is additive, bounded and validates immutable page identities', () => {
  const { parseTerminalCommands } = require('../dist/backend-client/task-terminal');
  const completed = { id: 1, command: 'false', confidence: 'exact', cwd: '/task', state: 'completed', startedAt: 100, finishedAt: 200,
    durationMs: 100, outputStart: 10, outputEnd: 30, exitCode: 1 };
  const page = { taskId: 1, terminalId: 2, generation, commands: [completed], current: null, next: 1, gap: false, more: false };
  assert.deepEqual(parseTerminalCommands(page, 1, 2), page);
  for (const bad of [
    { ...page, taskId: 3 }, { ...page, terminalId: 9 }, { ...page, generation: null }, { ...page, next: 0 },
    { ...page, more: true }, { ...page, commands: Array(21).fill(completed) }, { ...page, commands: [completed, completed] },
    ...[{ command: 'x'.repeat(4097) }, { confidence: 'guessed' }, { command: null }, { state: 'running' },
      { outputEnd: 9 }, { durationMs: -1 }, { exitCode: 999 }, { cwd: '/'.repeat(8193) }, { finishedAt: null }]
      .map(patch => ({ ...page, commands: [{ ...completed, ...patch }] })),
    { ...page, current: completed },
  ]) assert.throws(() => parseTerminalCommands(bad, 1, 2));
  const active = { ...completed, id: 2, state: 'running', finishedAt: null, outputEnd: null, durationMs: null, exitCode: null };
  assert.equal(parseTerminalCommands({ ...page, current: active }, 1, 2).current.id, 2);
  assert.throws(() => parseTaskTerminal({ ...terminal, commandTracking: false }, 1));
  assert.equal(parseTaskTerminal({ ...terminal, currentCwd: '/other', commandTracking: true }, 1).currentCwd, '/other');
  const output = { terminal, generation, from: 0, next: 4, data: 'test', gap: false, more: false, commandStarts: [{ id: 1, at: 2 }] };
  assert.deepEqual(parseTerminalOutput(output, 1, 2), output);
  for (const commandStarts of [null, [{ id: 1, at: 0 }], [{ id: 1, at: 5 }], [{ id: 1, at: 2 }, { id: 1, at: 3 }],
    [{ id: 1, at: 3 }, { id: 2, at: 2 }], Array(202).fill({ id: 1, at: 2 })])
    assert.throws(() => parseTerminalOutput({ ...output, commandStarts }, 1, 2));
});


test('activity titles remain bounded display-only optional metadata', () => {
  for (const activityTitle of [null, 'node', 'file — editor', '🙂'])
    assert.equal(parseTaskTerminal({ ...terminal, activityTitle }, 1).activityTitle, activityTitle);
  for (const activityTitle of ['', '   ', 3, 'x'.repeat(121), 'bad\nline', '\u202etitle', '\ud800'])
    assert.throws(() => parseTaskTerminal({ ...terminal, activityTitle }, 1));
  assert.equal(Object.hasOwn(parseTaskTerminal(terminal, 1), 'activityTitle'), false);
});

test('owned service addresses are additive, bounded and confined to loopback paths', () => {
  const address = { port: 4200, host: '::1', protocol: 'https', path: '/app/' };
  const row = { ...terminal, status: 'serving', port: 4200, protocol: 'https', services: [address], portDiscovery: 'process' };
  assert.deepEqual(parseTaskTerminal(row, 1), row);
  for (const patch of [
    { services: Array(17).fill(address) }, { services: [address, address] }, { services: [] },
    { services: undefined }, { status: 'idle' }, { alive: false }, { portDiscovery: 'output' }, { portDiscovery: 'unavailable' },
    ...[{ host: 'example.com' }, { host: '192.168.1.2' }, { host: '127.0.0.999' }, { protocol: 'file' },
      { path: '//example.com' }, { path: '/\\example.com' }, { path: '/?private' }, { path: '/#fragment' },
      { path: '/bad\nline' }, { path: '/a/../b' }, { port: 65536 }]
      .map(value => ({ services: [{ ...address, ...value }] })),
  ]) assert.throws(() => parseTaskTerminal({ ...row, ...patch }, 1));
  assert.equal(parseTaskTerminal({ ...terminal, services: [], portDiscovery: 'unavailable' }, 1).port, null);
});

test('browser handoff freshly verifies owned sockets, IPv6, path confinement and generation', async context => {
  const handlers = new Map(), ipc = {}, module = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/terminal-ports'), 'utf8'), { exports: module, setTimeout, clearTimeout, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name) });
  const address = { port: 4200, host: '::1', protocol: 'https', path: '/app/' };
  const row = { ...terminal, status: 'serving', port: 4200, protocol: 'https', services: [address], portDiscovery: 'process' };
  let checked = { generation, service: address }, closed = false, calls = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/service?')) {
      calls++;
      assert.equal(req.url, `/api/desktop-workspace/tasks/1/terminals/2/service?generation=${generation}&port=4200`);
      res.statusCode = closed ? 409 : 200;
      res.end(JSON.stringify(checked));
    } else res.end(JSON.stringify({ terminal: row, generation, from: 0, next: 4, data: 'test', gap: true, more: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const endpoint = { url: `http://127.0.0.1:${server.address().port}`, version: 'a'.repeat(40), headers: {} };
  const opened = [], controller = new AbortController();
  let environment = { kind: 'local' }, forwards = [];
  const client = { state: () => ({ scope: { id: generation, environment } }), execute: async (_window, _scope, _key, _mutation, operation) => operation(endpoint, controller.signal) };
  const remote = {
    snapshot: () => ({ forwards }), subscribe: () => () => {},
    addForward: async (_window, input, host) => {
      assert.equal(host, '::1');
      forwards = [{ remotePort: input.remotePort, phase: 'listening', boundPort: 49321 }];
      checked = { generation, service: { ...address, host: '127.0.0.1' } };
    },
  };
  const stop = module.registerTerminalPorts(client, remote, () => true, async url => { opened.push(url); }, () => { assert.fail('Opening must never copy'); });
  context.after(stop);
  const handler = handlers.get('task-terminal:open-port'), event = { senderFrame: {}, sender: { id: 11 } };
  const open = () => handler(event, generation, { taskId: 1, terminalId: 2, port: 4200 });
  assert.equal((await open()).url, 'https://[::1]:4200/app/');
  assert.deepEqual(opened, ['https://[::1]:4200/app/']);
  assert.equal(calls, 1);
  closed = true;
  await assert.rejects(open());
  closed = false;
  checked = { ...checked, generation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
  await assert.rejects(open());
  checked = { generation, service: { ...address, path: '//example.com' } };
  await assert.rejects(open());
  checked = { generation, service: address };
  environment = { kind: 'remote', hostId: 'remote' };
  await assert.rejects(open(), /service address changed/);
  assert.equal(opened.length, 1);
});
