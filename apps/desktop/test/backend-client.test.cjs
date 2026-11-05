const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { BackendClient } = require('../dist/backend-client/client');
const { createBackendClient } = require('../dist/backend-client/application');
const { readBackendInfo } = require('../dist/backend-client/transport');

const version = 'a'.repeat(40);
const json = { 'content-type': 'application/json' };

async function server(context, handle) {
  const http = createServer(handle);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return `http://127.0.0.1:${http.address().port}`;
}

function local(url, identity = url) {
  return { identity, url, version, headers: {}, environment: { kind: 'local' } };
}

test('named info adapter coalesces reads within a window and isolates scopes across windows', async context => {
  let calls = 0;
  let respond;
  const arrived = new Promise(resolve => { respond = resolve; });
  const url = await server(context, (request, response) => {
    calls++;
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/api/info');
    respond(() => { response.writeHead(200, json); response.end(JSON.stringify({ backendSha: version, private: 'discard me' })); });
  });
  const events = [];
  const client = new BackendClient(() => local(url), (...event) => events.push(event));
  context.after(() => client.dispose());
  client.attach(1); client.attach(2);
  const first = client.state(1); const second = client.state(2);
  assert.notEqual(first.scope.id, second.scope.id);
  assert.equal((await client.info(2, first.scope.id)).error.code, 'stale-scope');
  const pending = client.info(1, first.scope.id);
  assert.equal(client.info(1, first.scope.id), pending);
  (await arrived)();
  assert.deepEqual(await pending, { ok: true, value: { backendSha: version } });
  assert.equal(calls, 1);
  assert.equal(events.length, 2);
  assert.ok(!JSON.stringify(first).includes(url));
});

test('environment changes, document resets and closure abort old work without affecting another window', async context => {
  const arrivals = [];
  let notify;
  const url = await server(context, (_request, response) => {
    arrivals.push(response); notify();
  });
  let target = local(url);
  const client = new BackendClient(id => id === 1 ? target : local(url), () => {});
  context.after(() => client.dispose());
  client.attach(1); client.attach(2);
  for (const change of [() => { target = null; client.refresh(1); }, () => client.reset(1), () => client.detach(1)]) {
    target = local(url); client.attach(1); client.refresh(1);
    const scope = client.state(1).scope.id;
    const received = new Promise(resolve => { notify = resolve; });
    const pending = client.info(1, scope);
    await received;
    change();
    assert.equal((await pending).error.code, 'stale-scope');
    assert.equal(client.state(2).scope.environment.kind, 'local');
  }
  target = local(url); client.attach(1);
  const received = new Promise(resolve => { notify = resolve; });
  const pending = client.info(1, client.state(1).scope.id);
  await received;
  client.dispose();
  assert.equal((await pending).error.code, 'stale-scope');
  client.attach(1);
  assert.equal(client.state(1).scope, null, 'disposed clients cannot create new window leases');
});

test('a backend restart at the same origin rotates the scope and rejects stale requests before transport', async context => {
  let calls = 0;
  const url = await server(context, (_request, response) => { calls++; response.writeHead(200, json); response.end(JSON.stringify({ backendSha: version })); });
  let target = local(url);
  const client = new BackendClient(() => target, () => {});
  client.attach(1);
  const original = client.state(1);
  target = null; client.refreshAll();
  assert.equal((await client.info(1, original.scope.id)).error.code, 'unavailable');
  target = local(url); client.refreshAll();
  const restarted = client.state(1);
  assert.ok(restarted.revision > original.revision);
  assert.notEqual(restarted.scope.id, original.scope.id);
  assert.equal((await client.info(1, original.scope.id)).error.code, 'stale-scope');
  assert.equal(calls, 0);
  client.dispose();
});

test('late replies from cancelled scopes cannot replace or clear the current read', async context => {
  const requests = [];
  // Model a transport completing despite cancellation: scope checks must still
  // reject its reply, and its cleanup must not release another request's lease.
  context.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => {
    requests.push({ signal: options.signal, respond: () => resolve(new globalThis.Response(JSON.stringify({ backendSha: version }), { headers: json })) });
  }));
  let target = local('http://127.0.0.1:12345', 'first');
  const client = new BackendClient(() => target, () => {});
  context.after(() => client.dispose()); client.attach(1);
  const previous = client.info(1, client.state(1).scope.id);
  target = local(target.url, 'second'); client.refresh(1);
  assert.equal(requests[0].signal.aborted, true);
  const currentScope = client.state(1).scope.id;
  const current = client.info(1, currentScope);
  requests[0].respond();
  assert.equal((await previous).error.code, 'stale-scope');
  assert.equal(client.info(1, currentScope), current);
  assert.equal(requests.length, 2);
  requests[1].respond();
  assert.deepEqual(await current, { ok: true, value: { backendSha: version } });
});

test('concurrent windows own separate reads and closing one leaves the other running', async context => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => {
    requests.push({ signal: options.signal, respond: () => resolve(new globalThis.Response(JSON.stringify({ backendSha: version }), { headers: json })) });
  }));
  const client = new BackendClient(() => local('http://127.0.0.1:12345'), () => {});
  context.after(() => client.dispose()); client.attach(1); client.attach(2);
  const first = client.info(1, client.state(1).scope.id);
  const second = client.info(2, client.state(2).scope.id);
  assert.equal(requests.length, 2);
  client.detach(1);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  requests[1].respond();
  assert.deepEqual(await second, { ok: true, value: { backendSha: version } });
  requests[0].respond();
  assert.equal((await first).error.code, 'stale-scope');
});

test('info responses are bounded and runtime validated without exposing backend error bodies', async context => {
  const cases = [
    { status: 403, body: 'private backend text', expected: 'http' },
    { body: '{', expected: 'invalid-response' },
    { body: '{}', expected: 'invalid-response' },
    { body: JSON.stringify({ backendSha: 'b'.repeat(40) }), expected: 'invalid-response' },
    { body: JSON.stringify({ backendSha: 42 }), expected: 'invalid-response' },
    { body: JSON.stringify({ backendSha: version }), type: 'text/html', expected: 'invalid-response' },
    { body: 'x'.repeat(16385), declared: true, expected: 'invalid-response' },
    { body: 'x'.repeat(16385), expected: 'invalid-response' },
  ];
  let scenario;
  const url = await server(context, (_request, response) => {
    response.writeHead(scenario.status ?? 200, {
      'content-type': scenario.type ?? 'application/json',
      ...(scenario.declared ? { 'content-length': Buffer.byteLength(scenario.body) } : {}),
    });
    response.write(scenario.body); response.end();
  });
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(1);
  for (scenario of cases) {
    const result = await client.info(1, client.state(1).scope.id);
    assert.equal(result.error.code, scenario.expected);
    assert.ok(!JSON.stringify(result).includes('private backend text'));
  }
});

test('main adapter only contacts the owned loopback origin and never follows redirects with a credential', async context => {
  let leaked = false;
  const other = await server(context, (_request, response) => { leaked = true; response.end(); });
  const url = await server(context, (request, response) => {
    assert.equal(request.headers['x-private-capability'], 'secret');
    response.writeHead(302, { location: other }); response.end();
  });
  const endpoint = { url, version, headers: { 'x-private-capability': 'secret' } };
  await assert.rejects(readBackendInfo(endpoint, new AbortController().signal));
  assert.equal(leaked, false);
  for (const forbidden of ['https://example.com', 'http://127.0.0.1:80/api', 'http://user@127.0.0.1:1234', `${url}?x=1`, 'http://localhost:1234']) {
    await assert.rejects(readBackendInfo({ ...endpoint, url: forbidden }, new AbortController().signal), /endpoint/);
  }
});

test('a stalled response body times out and the next read can recover', async context => {
  let stalled = true;
  const url = await server(context, (_request, response) => {
    response.writeHead(200, json); response.write('{');
    if (!stalled) response.end(`"backendSha":"${version}"}`);
  });
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(1);
  const scope = client.state(1).scope.id;
  assert.equal((await client.info(1, scope)).error.code, 'timeout');
  stalled = false;
  assert.deepEqual(await client.info(1, scope), { ok: true, value: { backendSha: version } });
});

test('application resolves the selected remote capability and rotates scopes on reconnect; disposal removes listeners', async context => {
  const url = await server(context, (request, response) => {
    assert.equal(request.headers['x-private-capability'], 'secret');
    response.writeHead(200, json); response.end(JSON.stringify({ backendSha: version }));
  });
  let localListener; let remoteListener;
  let generation = 1;
  let selection = { kind: 'remote', hostId: 'host' };
  const backend = {
    snapshot: () => ({ phase: 'ready', version, url }),
    subscribe: listener => { localListener = listener; return () => { localListener = null; }; },
  };
  const remote = {
    snapshot: () => ({ selection, connection: { phase: 'ready', generation, instanceId: 'daemon' } }),
    backendStatus: (_window, status) => status,
    backendAccess: () => ({ url, headers: { 'x-private-capability': 'secret' } }),
    subscribe: listener => { remoteListener = listener; return () => { remoteListener = null; }; },
  };
  const { client, dispose } = createBackendClient(backend, remote, () => {});
  context.after(dispose); client.attach(1);
  const original = client.state(1);
  assert.equal((await client.info(1, original.scope.id)).ok, true);
  assert.ok(!JSON.stringify(original).includes('secret'));
  generation++; remoteListener(1);
  assert.notEqual(client.state(1).scope.id, original.scope.id);
  selection = { kind: 'local' }; remoteListener(1);
  assert.equal(client.state(1).scope.environment.kind, 'local');
  const localScope = client.state(1).scope.id;
  generation++; remoteListener(1);
  assert.equal(client.state(1).scope.id, localScope, 'unrelated remote changes do not invalidate local work');
  dispose(); assert.equal(localListener, null); assert.equal(remoteListener, null);
  assert.equal((await client.info(1, localScope)).error.code, 'unavailable');
});

test('domain reads coalesce by resource while writes execute individually and report uncertain outcomes', async context => {
  const client = new BackendClient(() => local('http://127.0.0.1:3000'), () => {});
  context.after(() => client.dispose()); client.attach(1);
  const scope = client.state(1).scope.id;
  let finish; let calls = 0;
  const operation = (_endpoint, signal) => { calls++; assert.equal(signal.aborted, false); return new Promise(resolve => { finish = resolve; }); };
  const first = client.execute(1, scope, 'task:1', false, operation);
  assert.equal(client.execute(1, scope, 'task:1', false, operation), first);
  finish({ id: 1 });
  assert.deepEqual(await first, { ok: true, value: { id: 1 } });
  assert.equal(calls, 1);
  const fail = async () => { calls++; throw new Error('private backend credential'); };
  for (const result of await Promise.all([client.execute(1, scope, null, true, fail), client.execute(1, scope, null, true, fail)])) {
    assert.equal(result.error.code, 'outcome-unknown');
    assert.ok(!result.error.message.includes('credential'));
  }
  assert.equal(calls, 3, 'writes are never coalesced or automatically replayed');
});

test('domain request lifetime rejects stale dispatch and aborts pending reads on window closure', async context => {
  const client = new BackendClient(() => local('http://127.0.0.1:3000'), () => {});
  context.after(() => client.dispose()); client.attach(1);
  const scope = client.state(1).scope.id;
  let calls = 0; let signal; let complete;
  const pending = client.execute(1, scope, 'sessions:1', false, (_endpoint, abort) => { calls++; signal = abort; return new Promise(resolve => { complete = resolve; }); });
  client.reset(1);
  assert.equal(signal.aborted, true);
  complete([]);
  assert.equal((await pending).error.code, 'stale-scope');
  assert.equal((await client.execute(1, scope, null, true, async () => { calls++; })).error.code, 'stale-scope');
  assert.equal(calls, 1);
});

test('workspace response mapping strips unknown fields and rejects malformed or oversized resource windows', () => {
  const { parseWorkspaceTask, parseWorkspacePage } = require('../dist/backend-client/workspace');
  const task = { id: 1, repoId: 2, projectId: 3, name: 'Task', branchName: 'task', state: 'ready', stage: 'active', archivedAt: null, updatedAt: '2026-10-26', token: 'secret' };
  assert.ok(!JSON.stringify(parseWorkspaceTask(task)).includes('secret'));
  assert.equal(parseWorkspaceTask(task).projectRepositoryCount, undefined);
  assert.equal(parseWorkspaceTask({ ...task, projectRepositoryCount: 1 }).projectRepositoryCount, 1);
  assert.equal(parseWorkspaceTask({ ...task, projectRepositoryCount: 2 }).projectRepositoryCount, 2);
  for (const projectRepositoryCount of [0, -1, 1.5, '2', null]) assert.throws(() => parseWorkspaceTask({ ...task, projectRepositoryCount }));
  for (const value of [{ ...task, state: 'unknown' }, { ...task, stage: 'done' }, { ...task, id: -1 }, { ...task, name: 'x'.repeat(161) }]) assert.throws(() => parseWorkspaceTask(value));
  const setupIssue = { code: 'external-checkout', message: 'Already checked out.', workspacePath: '/work/existing', canUseSnapshot: true, secret: 'private' };
  assert.deepEqual(parseWorkspaceTask({ ...task, state: 'failed', setupIssue }).setupIssue, { code: setupIssue.code, message: setupIssue.message, workspacePath: setupIssue.workspacePath, canUseSnapshot: true });
  const quotaIssue = { code: 'other', message: 'Workspace limit reached.', canUseSnapshot: false, canExceedWorktreeLimit: true };
  assert.deepEqual(parseWorkspaceTask({ ...task, state: 'failed', setupIssue: quotaIssue }).setupIssue, quotaIssue);
  for (const canExceedWorktreeLimit of [null, 'yes', 1]) assert.throws(() => parseWorkspaceTask({ ...task, setupIssue: { ...quotaIssue, canExceedWorktreeLimit } }));
  for (const value of [{ ...setupIssue, code: 'arbitrary' }, { ...setupIssue, canUseSnapshot: 'yes' }, { ...setupIssue, message: 'x'.repeat(501) }, { ...setupIssue, workspacePath: 'bad\npath' }]) assert.throws(() => parseWorkspaceTask({ ...task, setupIssue: value }));
  assert.throws(() => parseWorkspacePage({ items: Array(101).fill(task), nextCursor: null }, parseWorkspaceTask));
  assert.throws(() => parseWorkspacePage({ items: [], nextCursor: '-1' }, parseWorkspaceTask));
  assert.deepEqual(parseWorkspacePage({ items: [task], nextCursor: '1' }, parseWorkspaceTask).items[0].id, 1);
});

test('server failures after a mutation retain an unknown outcome while read and rejected-input errors remain ordinary failures', async context => {
  const { BackendRequestError } = require('../dist/backend-client/transport');
  const client = new BackendClient(() => local('http://127.0.0.1:3000'), () => {});
  context.after(() => client.dispose()); client.attach(1);
  const scope = client.state(1).scope.id;
  for (const status of [500, 502, 503]) {
    const operation = async () => { throw new BackendRequestError({ code: 'http', status, message: 'Backend request failed.' }); };
    assert.equal((await client.execute(1, scope, null, true, operation)).error.code, 'outcome-unknown');
    assert.equal((await client.execute(1, scope, 'read', false, operation)).error.code, 'http');
  }
  const rejected = async () => { throw new BackendRequestError({ code: 'http', status: 409, message: 'Conflict.' }); };
  assert.equal((await client.execute(1, scope, null, true, rejected)).error.code, 'http');
});

test('project deletion explains cleanup failures using bounded known codes without forwarding backend diagnostics', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  let scenario;
  let calls = 0;
  const url = await server(context, (request, response) => {
    calls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/desktop-workspace/projects/1/delete');
    response.writeHead(scenario.status ?? 409, {
      'content-type': scenario.type ?? 'application/json',
      ...(scenario.declared ? { 'content-length': Buffer.byteLength(scenario.body) } : {}),
    });
    response.write(scenario.body); response.end();
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  const blocked = JSON.stringify({ code: 'active_tasks', message: 'private backend text', taskId: 123, diagnostic: 'secret' });
  const generic = 'The operation conflicts with the current workspace state.';
  const cases = [
    { body: blocked, expected: 'A task opened while this project was being deleted. Try deleting the project again.' },
    { body: JSON.stringify({ code: 'project_cleanup_failed', message: 'private backend text' }), expected: 'Could not stop all project processes. The project was kept. Try deleting it again.' },
    { body: JSON.stringify({ code: 'unknown', message: 'private backend text' }), expected: generic },
    { body: JSON.stringify({ code: 'toString' }), expected: generic },
    { body: '{', expected: generic },
    { body: 'null', expected: generic },
    { body: blocked, type: 'text/html', expected: generic },
    { body: ' '.repeat(4096) + blocked, expected: generic },
    { body: ' '.repeat(4096) + blocked, declared: true, expected: generic },
    { body: blocked, status: 404, expected: 'The selected resource no longer exists.' },
  ];
  for (scenario of cases) {
    const result = await handlers.get('workspace:delete-project')(event, scope, 1);
    assert.deepEqual(result, { ok: false, error: { code: 'http', status: scenario.status ?? 409, message: scenario.expected } });
  }
  scenario = { status: 201, body: JSON.stringify({ accepted: true }) };
  const deleted = await handlers.get('workspace:delete-project')(event, scope, 1);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.accepted, true);
  assert.equal(calls, cases.length + 1, 'rejected deletions are never automatically replayed');
});

test('project name availability IPC validates names, replies, scope and sender', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  const requests = [];
  let reply = { available: false };
  const url = await server(context, (request, response) => {
    requests.push(request.url);
    assert.equal(request.method, 'GET');
    response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  context.after(workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender));
  const check = handlers.get('workspace:project-name-availability');
  assert.equal((await check(event, scope, '  Taken & archived  ')).value.available, false);
  assert.deepEqual(requests, ['/api/desktop-workspace/projects/name-availability?name=Taken+%26+archived']);
  for (const name of ['', ' ', 'x'.repeat(101), {}, 12]) assert.throws(() => check(event, scope, name));
  assert.throws(() => check({ senderFrame: {}, sender }, scope, 'Other'));
  assert.throws(() => check(event, scope, 'Other', 'extra'));
  reply = { available: 'yes' };
  assert.equal((await check(event, scope, 'Invalid reply')).error.code, 'invalid-response');
  client.reset(42);
  assert.equal((await check(event, scope, 'Stale')).error.code, 'stale-scope');
  assert.equal(requests.length, 2);
});

test('task recovery IPC preserves default retries and sends only named consent through scoped HTTP', async context => {
  let responseId = 1;
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  const requests = [];
  const task = { id: 1, repoId: 2, projectId: 3, name: 'Saved task', branchName: 'existing', state: 'preparing', stage: 'active', archivedAt: null, updatedAt: '' };
  const url = await server(context, (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
      response.writeHead(200, json); response.end(JSON.stringify({ ...task, id: responseId }));
    });
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  for (const recovery of [undefined, 'use-existing', 'snapshot', 'exceed-worktree-limit']) {
    const args = recovery === undefined ? [scope, 1] : [scope, 1, recovery];
    assert.equal((await handlers.get('workspace:retry-task')(event, ...args)).ok, true);
  }
  assert.deepEqual(requests, [
    { method: 'POST', path: '/api/desktop-workspace/tasks/1/retry', body: null },
    { method: 'POST', path: '/api/desktop-workspace/tasks/1/retry', body: { recovery: 'use-existing' } },
    { method: 'POST', path: '/api/desktop-workspace/tasks/1/retry', body: { recovery: 'snapshot' } },
    { method: 'POST', path: '/api/desktop-workspace/tasks/1/retry', body: { recovery: 'exceed-worktree-limit' } },
  ]);
  for (const recovery of ['arbitrary', { confirmOverLimit: true }, true]) {
    assert.throws(() => handlers.get('workspace:retry-task')(event, scope, 1, recovery));
  }
  responseId = 2;
  assert.equal((await handlers.get('workspace:retry-task')(event, scope, 1, 'snapshot')).error.code, 'outcome-unknown');
  client.reset(42);
  assert.equal((await handlers.get('workspace:retry-task')(event, scope, 1, 'use-existing')).error.code, 'stale-scope');
  assert.equal(requests.length, 5);
});

test('commit preview is scoped, bounded and validated; optional-message commits retain explicit selection', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  const requests = [];
  const file = { path: ' spaced file.txt ', status: 'M', add: 3, del: 1, staged: true };
  const preview = { taskId: 1, revision: 'a'.repeat(64), items: [file], nextCursor: null, matches: 1, total: 1, unstaged: 0, selected: { files: 1, add: 3, del: 1, staged: 1, unstaged: 0 }, running: [], private: 'discard' };
  const summary = { taskId: 1, branch: 'work', upstream: null, ahead: 1, behind: 0, files: 0, additions: 0, deletions: 0, conflicted: false };
  let reply = preview;
  const url = await server(context, (request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
      response.writeHead(200, json); response.end(JSON.stringify(reply));
    });
  });
  const client = new BackendClient(() => local(url), () => {}); context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  context.after(workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender));
  const selection = { includeUnstaged: true, excluded: [file.path], includedSecrets: [] };
  const read = () => handlers.get('workspace:commit-preview')(event, scope, { taskId: 1, ...selection });
  const result = await read(); assert.equal(result.ok, true); assert.equal(result.value.items[0].path, file.path); assert.equal(result.value.private, undefined);
  assert.deepEqual(requests[0], { method: 'POST', path: '/api/desktop-workspace/tasks/1/commit-preview', body: { ...selection, query: '' } });
  for (const malformed of [{ ...preview, taskId: 2 }, { ...preview, items: Array(101).fill(file) }, { ...preview, revision: 'bad' }, { ...preview, selected: { ...preview.selected, files: -1 } }, { ...preview, items: [{ ...file, flag: 'unknown' }] }]) {
    reply = malformed; assert.equal((await read()).error.code, 'invalid-response');
  }
  reply = summary;
  const committed = await handlers.get('workspace:git-action')(event, scope, { taskId: 1, type: 'commit', message: '', selection, revision: preview.revision, push: true });
  assert.equal(committed.ok, true);
  assert.deepEqual(requests.at(-1).body, { type: 'commit', message: '', selection, revision: preview.revision, push: true });
  reply = { ...summary, changesRevision: 'b'.repeat(64) };
  assert.equal((await handlers.get('workspace:git')(event, scope, 1)).value.changesRevision, reply.changesRevision);
  for (const changesRevision of ['', 'x'.repeat(64), 123, 'a'.repeat(65)]) {
    reply = { ...summary, changesRevision };
    assert.equal((await handlers.get('workspace:git')(event, scope, 1)).error.code, 'invalid-response');
  }
  const count = requests.length; client.reset(42); assert.equal((await read()).error.code, 'stale-scope'); assert.equal(requests.length, count);
});

test('session archive and Undo validate task ownership, consent, trusted input and stale scopes', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  const requests = [];
  let reply = { accepted: true };
  const url = await server(context, (request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({path:request.url, body:body ? JSON.parse(body) : null});
      response.writeHead(200,json); response.end(JSON.stringify(reply));
    });
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id, handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = {id:42}, event = {senderFrame:frame,sender};
  const stop = workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  const archive = (...args) => handlers.get('workspace:archive-session')(event,...args);
  const restore = (...args) => handlers.get('workspace:restore-session')(event,...args);
  for (const input of [{taskId:1,sessionId:2}, {taskId:1,sessionId:-1,confirmStop:true}, {taskId:1,sessionId:2,confirmStop:'yes'}]) assert.throws(() => archive(scope,input));
  assert.throws(() => handlers.get('workspace:archive-session')({senderFrame:{},sender},scope,{taskId:1,sessionId:2,confirmStop:true}));
  assert.equal((await archive(scope,{taskId:1,sessionId:2,confirmStop:true})).ok,true);
  assert.deepEqual(requests[0],{path:'/api/desktop-workspace/tasks/1/sessions/2/archive',body:{confirmStop:true}});
  reply = {id:2,taskId:1,repoId:3,name:'Kept',status:'done',provider:'codex',updatedAt:'',private:'discard'};
  const restored = await restore(scope,{taskId:1,sessionId:2});
  assert.equal(restored.ok,true); assert.equal(restored.value.private,undefined);
  reply = {...reply,taskId:9};
  assert.equal((await restore(scope,{taskId:1,sessionId:2})).error.code,'outcome-unknown');
  reply = {items:[{id:2,taskId:1,repoId:3,name:'Recent',status:'queued',provider:'codex',updatedAt:''}],nextCursor:null};
  assert.equal((await handlers.get('workspace:sessions')(event,scope,{taskId:1,limit:5,order:'latest'})).ok,true);
  assert.match(requests[3].path,/order=latest/);
  assert.throws(()=>handlers.get('workspace:sessions')(event,scope,{taskId:1,order:'arbitrary'}));
  assert.throws(()=>handlers.get('workspace:sessions')(event,scope,{taskId:1,state:'all'}));
  reply = {items:[{id:2,taskId:1,repoId:3,name:'Saved',status:'archived',provider:'codex',updatedAt:''}],nextCursor:'2'};
  const history = await handlers.get('workspace:sessions')(event,scope,{taskId:1,state:'archived',limit:20,order:'latest'});
  assert.equal(history.ok,true); assert.equal(history.value.items[0].status,'archived');
  assert.match(requests[4].path,/state=archived/);
  assert.equal((await handlers.get('workspace:sessions')(event,scope,{taskId:1,state:'normal'})).ok,false);
  reply = {revision:1,version:1,sessionArchive:true,sessionArchiveHistory:true};
  assert.equal((await handlers.get('workspace:revision')(event,scope)).value.sessionArchiveHistory,true);
  client.reset(42);
  assert.equal((await archive(scope,{taskId:1,sessionId:2,confirmStop:false})).error.code,'stale-scope');
  assert.equal(requests.length,7);
  stop(); assert.equal(handlers.size,0);
});

test('conversation cancellation is scoped to its owning window and request, and aborts transport', async context => {
  let arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  const url = await server(context, () => arrived());
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(1); client.attach(2);
  const scope = client.state(1).scope.id;
  const pending = client.execute(1, scope, 'session-chat:request:1:2', false, async (endpoint, signal) => {
    await fetch(endpoint.url, { signal }); return true;
  });
  await ready;
  client.cancel(2, scope, 'session-chat:request');
  client.cancel(1, client.state(2).scope.id, 'session-chat:request');
  client.cancel(1, scope, 'session-chat:request');
  assert.equal((await pending).ok, false);
});

test('conversation replies validate resource identity, bounded fields and supported action unions', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  assert.deepEqual(parseChatAction({ type: 'send', text: 'hello', queue: true, private: 'drop' }), { type: 'send', text: 'hello', queue: true });
  assert.deepEqual(parseChatAction({ type: 'send', text: 'compare', queue: false, sessionIds: [12, 13] }), { type: 'send', text: 'compare', queue: false, sessionIds: [12, 13] });
  for (const sessionIds of [[0], [-1], [1.2], ['12'], [12, 12], Array.from({ length: 9 }, (_, i) => i + 1)])
    assert.throws(() => parseChatAction({ type: 'send', text: 'compare', queue: false, sessionIds }));
  for (const invalid of [{ type: 'shell', command: 'anything' }, { type: 'send', text: '', queue: false }, { type: 'send', text: 'x'.repeat(64001), queue: false }, { type: 'permission', id: 'id', decision: 'yes' }, { type: 'answer', id: 'id', answers: { q: ['x'.repeat(4001)] } }]) assert.throws(() => parseChatAction(invalid));
  assert.throws(() => parseChatPage({ taskId: 3, sessionId: 2 }, 1, 2));
  assert.throws(() => parseChatPage({ taskId: 1, sessionId: 2, cursor: 'x'.repeat(201) }, 1, 2));
});

test('harness selection requires a known action shape and an expected current provider', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  assert.deepEqual(parseChatAction({ type: 'provider', provider: 'claude', expectedProvider: 'codex', private: 'discard' }), { type: 'provider', provider: 'claude', expectedProvider: 'codex' });
  for (const input of [{ type: 'provider', provider: 'claude' }, { type: 'provider', provider: '', expectedProvider: 'codex' }, { type: 'provider', provider: 'claude', expectedProvider: 1 }]) assert.throws(() => parseChatAction(input));
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  const message = { id: 'u', kind: 'user', text: 'Compare', timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
  const mentions = [{ sessionId: 12, title: 'Other work', snapshot: 'must not cross IPC', path: '/private/export.md' }];
  assert.deepEqual(parseChatPage({ ...page, items: [{ ...message, mentions }] }, 1, 2).items[0].mentions, [{ sessionId: 12, title: 'Other work' }]);
  for (const invalid of [[{ sessionId: 0, title: 'A' }], [{ sessionId: '12', title: 'A' }], [{ sessionId: 12, title: '' }], [{ sessionId: 12, title: 'x'.repeat(1001) }], [...mentions, ...mentions], Array(9).fill(mentions[0])])
    assert.throws(() => parseChatPage({ ...page, items: [{ ...message, mentions: invalid }] }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, items: [{ ...message, kind: 'assistant', mentions }] }, 1, 2));
  assert.equal(parseChatPage(page, 1, 2).state.providerLocked, undefined);
  const parsed = parseChatPage({ ...page, state: { ...state, providers: [{ id: 'claude', label: 'Claude Code', private: 'discard' }], providerLocked: false } }, 1, 2);
  assert.deepEqual(parsed.state.providers, [{ id: 'claude', label: 'Claude Code' }]); assert.equal(parsed.state.providerLocked, false);
  assert.throws(() => parseChatPage({ ...page, state: { ...state, providers: Array(33).fill({ id: 'x', label: 'x' }) } }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, state: { ...state, providerLocked: 'false' } }, 1, 2));
});


test('composer capability metadata is optional, bounded and validated before crossing the bridge', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: 'gpt', models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  assert.equal(parseChatPage(page, 1, 2).state.controls, undefined);
  const controls = { plan: true, reasoning: true, fast: true };
  const model = { id: 'gpt', label: 'GPT', reasoningEfforts: ['low', 'high'], supportsFastMode: true };
  const result = parseChatPage({ ...page, state: { ...state, controls: { ...controls, private: 'discard' }, fast: true, models: [{ ...model, private: 'discard' }] } }, 1, 2);
  assert.deepEqual(result.state.controls, controls);
  assert.deepEqual(result.state.models, [model]);
  assert.deepEqual(parseChatAction({ type: 'reasoning', effort: null }), { type: 'reasoning', effort: null });
  assert.deepEqual(parseChatAction({ type: 'fast', enabled: true }), { type: 'fast', enabled: true });
  for (const input of [{ type: 'reasoning', effort: 1 }, { type: 'fast', enabled: 'true' }]) assert.throws(() => parseChatAction(input));
  for (const extra of [{ controls: { ...controls, fast: 'yes' } }, { fast: 1 }, { models: [{ ...model, reasoningEfforts: Array(21).fill('high') }] }, { models: [{ ...model, supportsFastMode: 'yes' }] }]) {
    assert.throws(() => parseChatPage({ ...page, state: { ...state, ...extra } }, 1, 2));
  }
});

test('subscription usage stays optional, scoped to its provider and bounded at the bridge', () => {
  const { parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  const usage = { provider: 'codex', planName: 'Plus', status: 'warning', updatedAt: '2026-10-30T10:00:00Z', windows: [{ id: 'primary', label: '5-hour limit', remainingPercentage: 12, resetsAt: 1793368800 }] };
  const parse = planUsage => parseChatPage({ ...page, state: { ...state, planUsage } }, 1, 2).state.planUsage;
  assert.equal(parseChatPage(page, 1, 2).state.planUsage, undefined);
  assert.equal(parse(null), null);
  assert.deepEqual(parse({ ...usage, credential: 'discard' }), usage);
  for (const extra of [{ provider: 'claude' }, { status: 'unknown' }, { updatedAt: 'invalid' }, { windows: [] }, { windows: Array(9).fill(usage.windows[0]) }, { windows: [usage.windows[0], usage.windows[0]] }]) assert.throws(() => parse({ ...usage, ...extra }));
  for (const remainingPercentage of [-1, 101, NaN, Infinity, '12']) assert.throws(() => parse({ ...usage, windows: [{ ...usage.windows[0], remainingPercentage }] }));
  for (const resetsAt of [-1, Infinity, 9e12, 'tomorrow']) assert.throws(() => parse({ ...usage, windows: [{ ...usage.windows[0], resetsAt }] }));
});

test('starting presets validate bounded state and discard extra action fields', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const preset = { id: 'deep', name: 'Deep work', provider: 'codex', providerLabel: 'Codex', model: 'gpt', modelLabel: 'GPT', reasoning: 'high', fast: true };
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [], presets: [preset] };
  const page = { taskId: 1, sessionId: 2, cursor: 'x', reset: true, items: [], events: [], before: null, state };
  assert.deepEqual(parseChatPage(page, 1, 2).state.presets, [preset]);
  assert.throws(() => parseChatPage({ ...page, state: { ...state, presets: Array(25).fill(preset) } }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, state: { ...state, presets: [{ ...preset, fast: 'true' }] } }, 1, 2));
  const action = { type: 'save-preset', id: 'new', name: 'Quick', expectedProvider: 'codex', model: null, reasoning: null, fast: false };
  assert.deepEqual(parseChatAction({ ...action, shell: 'discard' }), action);
  for (const bad of [{ ...action, name: ' ' }, { ...action, name: 'x'.repeat(49) }, { ...action, fast: 'true' }, { ...action, reasoning: 1 }]) assert.throws(() => parseChatAction(bad));
});

test('default preset snapshots and writes are bounded and revision guarded', () => {
  const { parseChatAction, parsePresetDefault } = require('../dist/backend-client/session-chat-validation');
  const revision = 'a'.repeat(64);
  const snapshot = { id: 'deep', provider: 'codex', defaultIds: ['deep'], revision };
  assert.deepEqual(parsePresetDefault(snapshot), snapshot);
  for (const value of [{ ...snapshot, revision: 'bad' }, { ...snapshot, defaultIds: ['deep', 'deep'] }, { ...snapshot, id: 'missing' }]) assert.throws(() => parsePresetDefault(value));
  const action = { type: 'preset-default', id: 'deep', expectedProvider: 'codex', expectedRevision: revision };
  assert.deepEqual(parseChatAction({ ...action, private: 'discard' }), action);
  assert.throws(() => parseChatAction({ ...action, expectedRevision: undefined }));
  assert.throws(() => parseChatAction({ type: 'save-preset', id: 'new', name: 'New', model: null, reasoning: null, fast: false, expectedProvider: 'codex', makeDefault: true }));
  assert.throws(() => parseChatAction({ type: 'preset-default-restore', provider: 'codex', defaultIds: Array(25).fill('deep'), expectedRevision: revision }));
});

test('preset catalogs reject mismatched identities and unsupported configurations', () => {
  const { parseChatCatalog, parseChatAction } = require('../dist/backend-client/session-chat-validation');
  const catalog = { provider: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'Sonnet', reasoningEfforts: ['high'], supportsFastMode: false }], model: 'sonnet', reasoning: 'high', fast: false, reasoningAvailable: true, fastAvailable: false, error: null };
  assert.deepEqual(parseChatCatalog(catalog, 'claude'), catalog);
  for (const bad of [{ ...catalog, provider: 'codex' }, { ...catalog, model: 'missing' }, { ...catalog, fast: true }, { ...catalog, reasoning: 'invented' }, { ...catalog, models: Array(101).fill(catalog.models[0]) }]) assert.throws(() => parseChatCatalog(bad, 'claude'));
  const action = { type: 'save-preset', id: 'new', name: 'Claude', expectedProvider: 'codex', provider: 'claude', model: 'sonnet', reasoning: 'high', fast: false };
  assert.deepEqual(parseChatAction(action), action);
});

test('reply changes validate bounded metadata, revisions and text-only diff lines', () => {
  const { parseChangesPage, parseChangeSummary } = require('../dist/backend-client/session-chat-changes');
  const file = { path: 'new.txt', status: 'A', add: 1, del: 0 };
  const page = { turnId: 'reply', revision: 'a'.repeat(64), offset: 0, total: 1, files: [file], nextOffset: null, content: { path: 'new.txt', lines: [{ id: 'line', kind: 'add', newNumber: 1, text: '<script>inert</script>' }], nextOffset: null } };
  assert.deepEqual(parseChangesPage(page, 'reply', 'new.txt'), page);
  assert.throws(() => parseChangesPage(page, 'other', 'new.txt'));
  assert.throws(() => parseChangesPage(page, 'reply', 'other.txt'));
  for (const extra of [{ revision: 'invalid' }, { files: Array(101).fill(file), total: 101 }, { nextOffset: 0 }, { content: { ...page.content, lines: Array(401).fill(page.content.lines[0]) } }, { content: { ...page.content, lines: [{ id: 'line', kind: 'html', text: 'no' }] } }]) assert.throws(() => parseChangesPage({ ...page, ...extra }, 'reply', 'new.txt'));
  assert.deepEqual(parseChangeSummary({ total: 5000, files: [file], secret: 'discard' }), { total: 5000, files: [file] });
  assert.throws(() => parseChangeSummary({ total: 1, files: [{ ...file, add: -1 }] }));
});

test('command facts remain optional, bounded and allowlisted across the bridge', () => {
  const { parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const item = { id: 'r', kind: 'tool_result', text: 'output', timestamp: '2026-11-01T12:00:00Z', toolId: 'c', toolName: null, toolKind: null, input: '', error: false, truncated: false };
  const parse = extra => parseChatPage({ taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [{ ...item, ...extra }], events: [], state }, 1, 2).items[0];
  assert.equal(parse({}).execution, undefined);
  assert.deepEqual(parse({ execution: { cwd: '/repo', exitCode: -1, interrupted: true, private: 'discard' } }).execution, { cwd: '/repo', exitCode: -1, interrupted: true });
  for (const execution of [null, [], { exitCode: 0.5 }, { exitCode: Infinity }, { exitCode: '0' }, { cwd: 'x'.repeat(4001) }, { interrupted: 'false' }]) assert.throws(() => parse({ execution }));
});

test('chat media IPC uses scoped attachment identities, validates bytes and cleans up its handler', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  let reply = { itemId: 'image', mediaId: '0', source: 'data:image/png;base64,iVBORw0KGgo=' };
  let calls = 0;
  const url = await server(context, (request, response) => {
    calls++;
    assert.equal(request.url, '/api/desktop-workspace/tasks/1/sessions/2/chat/media?itemId=image&mediaId=0');
    response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, media = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/session-chat-media'), 'utf8'), { exports: media, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name.slice(2)) });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = media.registerSessionChatMedia(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  const read = handlers.get('session-chat:media');
  const input = { taskId: 1, sessionId: 2, requestId: 'media', itemId: 'image', mediaId: '0' };
  assert.equal((await read(event, scope, input)).value.source, reply.source);
  assert.throws(() => read({ senderFrame: {}, sender }, scope, input), /Untrusted/);
  assert.throws(() => read(event, scope, { ...input, mediaId: '../private.png' }), /incompatible|Invalid/);
  assert.equal((await read(event, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', input)).error.code, 'stale-scope');
  assert.equal(calls, 1);
  for (const bad of [{ ...reply, itemId: 'other' }, { ...reply, mediaId: '1' }, { ...reply, source: 'file:///private/secret.png' }, { ...reply, source: 'data:image/svg+xml;base64,PHN2Zz4=' }]) {
    reply = bad;
    assert.equal((await read(event, scope, input)).error.code, 'invalid-response');
  }
  stop(); assert.equal(handlers.size, 0);
});

test('file uploads are named, bounded, scoped and validate each chunk receipt', async context => {
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  const id = '11111111-1111-4111-8111-111111111111';
  let reply = { id, offset: 3, path: `/private/chat-attachments/2/${id}/notes.txt` }, calls = 0;
  const url = await server(context, async (request, response) => {
    calls++;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/desktop-workspace/tasks/1/sessions/2/chat/attachments');
    let body = ''; for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { id, name: 'notes.txt', size: 3, offset: 0, data: 'YWJj' });
    response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, adapter = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/session-chat-attachments'), 'utf8'), { exports: adapter, Buffer, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name.slice(2)) });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = adapter.registerChatAttachments(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  const upload = handlers.get('session-chat:upload');
  const input = { taskId: 1, sessionId: 2, requestId: 'upload', id, name: 'notes.txt', size: 3, offset: 0, data: 'YWJj' };
  assert.equal((await upload(event, scope, input)).value.path, reply.path);
  assert.throws(() => upload({ senderFrame: {}, sender }, scope, input), /Untrusted/);
  for (const bad of [{ ...input, size: 21 * 1024 * 1024 }, { ...input, offset: -1 }, { ...input, data: '!' }, { ...input, data: 'A'.repeat(700000) }])
    assert.throws(() => upload(event, scope, bad));
  assert.equal((await upload(event, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', input)).error.code, 'stale-scope');
  assert.equal(calls, 1);
  reply = { ...reply, offset: 2 };
  assert.equal((await upload(event, scope, input)).error.code, 'invalid-response');
  stop(); assert.equal(handlers.size, 0);
});

test('task request reconciliation is scoped, read-only and validates repository ownership', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  let reply = { task: null }, requests = 0;
  const url = await server(context, (request, response) => {
    requests++; assert.match(request.url, /^\/api\/desktop-workspace\/task-requests\?repoId=2&requestId=stable/);
    assert.equal(request.method, 'GET'); response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => undefined);
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id, handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/transport') });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender); context.after(stop);
  const read = input => handlers.get('workspace:task-request')(event, scope, input);
  assert.throws(() => read({ repoId: 0, requestId: 'stable' }));
  assert.throws(() => read({ repoId: 2, requestId: 'x'.repeat(101) }));
  assert.throws(() => handlers.get('workspace:task-request')({ senderFrame: {}, sender }, scope, { repoId: 2, requestId: 'stable' }));
  assert.equal((await read({ repoId: 2, requestId: 'stable' })).value.task, null);
  reply = { task: { id: 3, projectId: 1, repoId: 2, name: 'Task', branchName: 'task', stage: 'active', state: 'preparing', archivedAt: null, updatedAt: '', private: 'discard' } };
  const found = await read({ repoId: 2, requestId: 'stable' }); assert.equal(found.value.task.id, 3); assert.equal(found.value.task.private, undefined);
  reply.task.repoId = 9; assert.equal((await read({ repoId: 2, requestId: 'stable' })).error.code, 'invalid-response');
  client.reset(42); assert.equal((await read({ repoId: 2, requestId: 'stable' })).error.code, 'stale-scope'); assert.equal(requests, 3);
});

test('persistent channels have scope-owned cancellation without a request deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new BackendClient(() => local('http://127.0.0.1:1'), () => undefined);
  client.attach(1);
  const scope = client.state(1).scope.id;
  let signal;
  const pending = client.execute(1, scope, 'browser-stream:1', false, async (_endpoint, owned) => {
    signal = owned;
    await new Promise(resolve => owned.addEventListener('abort', resolve, { once: true }));
  }, null);
  context.mock.timers.tick(3600000);
  assert.equal(signal.aborted, false);
  client.reset(1);
  assert.equal(signal.aborted, true);
  assert.equal((await pending).error.code, 'stale-scope');
  client.dispose();
});
