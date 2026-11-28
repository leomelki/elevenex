const { createRequire } = require('node:module');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const requireWorkspace = createRequire(require.resolve('../dist/backend-client/workspace'));
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

const chatState = {
  provider: 'codex', phase: 'running', canInterrupt: true, error: null, model: null, models: [],
  reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null,
  queue: [], queuePaused: false, permission: null, question: null, activity: [],
};
const chatCursor = sequence => 'a'.repeat(36) + `:${sequence}:0`;
const chatPacket = (sequence, overrides = {}) => ({
  taskId: 1, sessionId: 2, cursor: chatCursor(sequence), reset: sequence === 1,
  items: [], events: [], before: null, next: null, state: chatState, ...overrides,
});
const sseChatFrame = (after, page) => `id: ${page.cursor}\nevent: chat\ndata: ${JSON.stringify({ after, page })}\n\n`;

test('chat stream gates IPC delivery on acknowledgements and resumes a broken connection', { timeout: 5000 }, async context => {
  const { SessionChatConnection } = require('../dist/backend-client/session-chat-stream');
  const { setTimeout: delay } = require('node:timers/promises');
  const delivered = [];
  let requests = 0;
  let remoteClosed;
  const closed = new Promise(resolve => { remoteClosed = resolve; });
  const url = await server(context, (request, response) => {
    assert.equal(request.url, '/api/desktop-workspace/tasks/1/sessions/2/chat/events?loadingMode=progressive');
    assert.equal(request.headers.accept, 'text/event-stream');
    assert.equal(request.headers.authorization, 'private test credential');
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write(': connected\n\n');
    if (++requests === 1) {
      assert.equal(request.headers['last-event-id'], undefined);
      response.write(sseChatFrame(null, chatPacket(1)));
      response.end(`id: ${chatCursor(2)}\nevent: chat\ndata: {"after":`);
    } else {
      assert.equal(request.headers['last-event-id'], chatCursor(1));
      response.once('close', remoteClosed);
      const frame = Buffer.from(sseChatFrame(chatCursor(1), chatPacket(2, { events: [{ type: 'delta', id: 'item', text: ' 🌍' }] })));
      const split = frame.indexOf(Buffer.from('🌍')) + 2;
      response.write(frame.subarray(0, split));
      setTimeout(() => {
        response.write(frame.subarray(split));
        response.write(sseChatFrame(chatCursor(2), chatPacket(3, { state: undefined, events: [{ type: 'delta', id: 'item', text: ' resumed once' }] })));
      }, 5);
    }
  });
  const lifetime = new AbortController();
  let released = 0;
  const endpoint = { ...local(url), headers: { Authorization: 'private test credential' } };
  const stream = new SessionChatConnection('scope', { taskId: 1, sessionId: 2, watchId: 'reader', loadingMode: 'progressive' }, {
    endpoint, signal: lifetime.signal, release: () => { lifetime.abort(); released++; },
  }, packet => delivered.push(packet), () => undefined);
  context.after(() => stream.close());
  const page = async delivery => {
    for (;;) {
      const packet = delivered.find(packet => packet.type === 'page' && packet.delivery === delivery);
      if (packet) return packet.page;
      await delay(10, undefined, { signal: testDeadline });
    }
  };
  const testDeadline = AbortSignal.timeout(3500);
  stream.start();
  assert.equal((await page(1)).cursor, chatCursor(1));
  stream.acknowledge(2);
  await delay(30);
  assert.equal(requests, 1);
  stream.acknowledge(1);
  assert.deepEqual((await page(2)).events, [{ type: 'delta', id: 'item', text: ' 🌍' }]);
  assert.equal(delivered.filter(packet => packet.type === 'reconnecting').length, 1);
  await delay(30);
  assert.equal(delivered.filter(packet => packet.type === 'page').length, 2);
  stream.acknowledge(2);
  const third = await page(3);
  assert.deepEqual(third.events, [{ type: 'delta', id: 'item', text: ' resumed once' }]);
  assert.equal(third.state, undefined);
  stream.close();
  await closed;
  assert.equal(released, 1);
});

test('chat stream rejects mismatched cursors, wrong-session replies and oversized frames', async () => {
  const { parseChatStreamPage, readChatEventFrames } = require('../dist/backend-client/session-chat-stream-reader');
  const watch = { taskId: 1, sessionId: 2, watchId: 'reader', loadingMode: 'progressive' };
  const parse = (after, page, expected = after) => parseChatStreamPage({
    id: page.cursor, json: JSON.stringify({ after, page }),
  }, watch, expected ?? undefined);
  const invalid = error => error.detail.code === 'invalid-response';
  assert.equal(parse(null, chatPacket(1)).cursor, chatCursor(1));
  assert.throws(() => parse(chatCursor(1), chatPacket(2), chatCursor(4)), invalid);
  assert.throws(() => parse(chatCursor(4), chatPacket(2)), invalid);
  assert.throws(() => parse(null, chatPacket(1, { sessionId: 3 })), invalid);
  assert.throws(() => parse(chatCursor(1), chatPacket(2, { events: [
    { type: 'delta', id: 'duplicate', text: 'one' }, { type: 'delta', id: 'duplicate', text: 'two' },
  ] })), invalid);
  const { SESSION_CHAT_STREAM_FRAME_BYTES } = require('@elevenex/shared');
  const frames = readChatEventFrames(new globalThis.Response(Buffer.alloc(SESSION_CHAT_STREAM_FRAME_BYTES + 1, 65)).body, () => undefined);
  await assert.rejects(frames.next(), invalid);
});

test('chat request diagnostics are opt-in, correlate HTTP outcomes and keep transcript data private', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const program = `
    const assert = require('node:assert/strict');
    const { requestBackendJson } = require(process.argv[1]);
    const privateValue = 'for-tests-only-private-data';
    const endpoint = { url: 'http://127.0.0.1:12345', headers: { Authorization: privateValue } };
    const chat = '/api/desktop-workspace/tasks/5/sessions/9/chat';
    globalThis.fetch = async (url, { signal }) => {
      signal.throwIfAborted();
      const status = url.pathname.endsWith('/tool-details') ? 409 : 200;
      const body = url.pathname.endsWith('/turn-work')
        ? { items: Array.from({ length: 105 }, () => ({ text: privateValue })), total: 105, nextOffset: null }
        : { items: [{ completedTurn: {}, text: privateValue }], events: [], reset: true, before: privateValue };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    const read = (path, signal = new AbortController().signal) => requestBackendJson(endpoint, { path }, signal);
    (async () => {
      await read(chat + '?before=' + privateValue + '&loadingMode=progressive&summarizeCompleted=1&summarizeRecent=1&deferToolDetails=1');
      await read(chat + '/turn-work?offset=0&limit=512&deferToolDetails=1&turnId=' + privateValue);
      await assert.rejects(read(chat + '/tool-details?resultId=' + privateValue), error => error.detail.status === 409);
      await assert.rejects(read(chat + '?after=' + privateValue, AbortSignal.abort()), { name: 'AbortError' });
      await read('/api/info');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const run = options => promisify(execFile)(process.execPath, ['-e', program, require.resolve('../dist/backend-client/transport')], {
    env: { ...process.env, NODE_DEBUG: options },
  });
  assert.equal((await run('')).stderr, '');
  const { stderr } = await run('elevenex-chat');
  assert.doesNotMatch(stderr, /for-tests-only-private-data|127\.0\.0\.1|Authorization/);
  const entries = stderr.trim().split('\n').map(line => {
    const entry = /^ELEVENEX-CHAT \d+: (request|response) (.*)$/.exec(line);
    assert.ok(entry, line);
    const [, phase, json] = entry;
    return { phase, ...JSON.parse(json) };
  });
  assert.equal(entries.length, 8);
  for (let index = 0; index < entries.length; index += 2) {
    const [request, response] = entries.slice(index, index + 2);
    assert.equal(request.phase, 'request');
    assert.equal(response.phase, 'response');
    assert.equal(request.id, response.id);
    assert.ok(response.elapsedMs >= 0);
    assert.equal(request.taskId, 5);
    assert.equal(request.sessionId, 9);
  }
  const [history, work, details, poll] = entries.filter(entry => entry.phase === 'response');
  assert.deepEqual([history.operation, history.direction, history.mode, history.items, history.completedTurns, history.hasOlder],
    ['history', 'before', 'progressive', 1, 1, true]);
  assert.ok(history.summarizeCompleted && history.summarizeRecent && history.deferToolDetails && history.responseBytes > 0);
  assert.deepEqual([work.operation, work.offset, work.limit, work.status, work.items, work.total, work.nextOffset],
    ['turn-work', 0, 512, 200, 105, 105, null]);
  assert.deepEqual([details.operation, details.withResult, details.outcome, details.status], ['tool-details', true, 'http', 409]);
  assert.deepEqual([poll.direction, poll.outcome, poll.status], ['poll', 'aborted', undefined]);
});

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
  for (const workspaceRecovery of ['prepare', 'restore-branch', 'new-workspace']) {
    const recoveryIssue = { code: 'other', message: 'Your conversations are saved.', canUseSnapshot: false, workspaceRecovery };
    assert.deepEqual(parseWorkspaceTask({ ...task, state: 'failed', setupIssue: recoveryIssue }).setupIssue, recoveryIssue);
  }
  for (const workspaceRecovery of [null, 'arbitrary', 1]) assert.throws(() => parseWorkspaceTask({ ...task, setupIssue: { ...quotaIssue, workspaceRecovery } }));
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
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
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

test('workspace branch IPC preserves exact refs and accepts legacy branch replies', async context => {
  const { readFile } = require('node:fs/promises');
  const { URLSearchParams } = require('node:url');
  const vm = require('node:vm');
  const requests = [];
  const legacy = { name: 'main', current: true, isDefault: true, defaultBase: 'main', heldTaskName: null };
  const remote = { ...legacy, name: 'upstream/review', ref: 'refs/remotes/upstream/review', remoteBranch: 'review', current: false, isDefault: false, heldTaskName: 'Review task' };
  let reply = [remote, legacy];
  const url = await server(context, (request, response) => {
    requests.push(request.url);
    response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(42);
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  context.after(workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender));
  const search = handlers.get('workspace:branches');
  const scope = client.state(42).scope.id;
  const input = { repoId: 1, query: 'topic review', limit: 2, includeRemote: true };
  assert.throws(() => search(event, scope, { ...input, includeRemote: 'true' }));
  assert.throws(() => search(event, scope, { ...input, query: 'x'.repeat(254) }));
  assert.equal(requests.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify((await search(event, scope, input)).value)), reply);
  assert.deepEqual(requests, ['/api/desktop-workspace/branches?repoId=1&query=topic+review&limit=2&includeRemote=true']);
  for (const invalid of [{ ...remote, ref: 'refs/heads/other' }, { ...remote, remoteBranch: 'other' }]) {
    reply = [invalid];
    assert.equal((await search(event, scope, input)).error.code, 'invalid-response');
  }
  reply = [legacy, legacy, legacy];
  assert.equal((await search(event, scope, input)).error.code, 'invalid-response');
  client.reset(42);
  assert.equal((await search(event, scope, input)).error.code, 'stale-scope');
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
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
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
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
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
  let statusCode = 200;
  const url = await server(context, (request, response) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
      response.writeHead(statusCode, json); response.end(JSON.stringify(reply));
    });
  });
  const client = new BackendClient(() => local(url), () => {}); context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id;
  const handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
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
  statusCode = 409;
  for (const [code, expected] of [
    ['commit-message-failed', 'Enter a message above'],
    ['commit-changes-moved', 'Refresh files'],
    ['commit-saved-push-failed', 'commit was saved'],
    ['commit-index-locked', 'Another Git operation'],
    ['commit-no-changes', 'selected files have no changes Git can commit'],
    ['commit-rejected', 'commit hooks'],
    ['untrusted-server-code', 'conflicts with the current workspace'],
  ]) {
    reply = { code, message: 'private backend output that must never reach the renderer' };
    const result = await handlers.get('workspace:git-action')(event, scope, { taskId: 1, type: 'commit', message: '' });
    assert.equal(result.ok, false); assert.match(result.error.message, new RegExp(expected));
    assert.doesNotMatch(result.error.message, /private backend/);
  }
  for (const [code, expected] of [
    ['git-push-authentication', 'SSH key'],
    ['git-push-behind', 'newer commits'],
    ['git-push-failed', 'pre-push hooks'],
    ['unknown-push-code', 'conflicts with the current workspace'],
  ]) {
    reply = { code, message: 'private Git output https://user:secret@example.test/repo' };
    const result = await handlers.get('workspace:git-action')(event, scope, { taskId: 1, type: 'push' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, new RegExp(expected));
    assert.doesNotMatch(result.error.message, /private Git|secret|example\.test/);
    assert.deepEqual(requests.at(-1).body, { type: 'push' });
  }
  for (const [code, expected] of [
    ['git-pull-upstream', 'no available upstream'],
    ['git-pull-fetch', 'Could not fetch the upstream branch'],
    ['git-pull-fast-forward', 'Could not fast-forward the task branch'],
  ]) {
    reply = { code, message: 'private Git output https://user:secret@example.test/repo' };
    const result = await handlers.get('workspace:git-action')(event, scope, { taskId: 1, type: 'sync' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, new RegExp(expected));
    assert.doesNotMatch(result.error.message, /private Git|secret|example\.test/);
    assert.deepEqual(requests.at(-1).body, { type: 'sync' });
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
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
  const frame = {}, sender = {id:42}, event = {senderFrame:frame,sender};
  const stop = workspace.registerWorkspaceIpc(client, (candidate, contents) => candidate === frame && contents === sender);
  context.after(stop);
  const archive = (...args) => handlers.get('workspace:archive-session')(event,...args);
  const restore = (...args) => handlers.get('workspace:restore-session')(event,...args);
  for (const input of [{taskId:1,sessionId:2}, {taskId:1,sessionId:-1,confirmStop:true}, {taskId:1,sessionId:2,confirmStop:'yes'}]) assert.throws(() => archive(scope,input));
  assert.throws(() => handlers.get('workspace:archive-session')({senderFrame:{},sender},scope,{taskId:1,sessionId:2,confirmStop:true}));
  assert.equal((await archive(scope,{taskId:1,sessionId:2,confirmStop:true})).ok,true);
  assert.deepEqual(requests[0],{path:'/api/desktop-workspace/tasks/1/sessions/2/archive',body:{confirmStop:true}});
  reply = {id:2,taskId:1,repoId:3,name:'Kept',status:'done',provider:'codex',updatedAt:'',canDelete:false,private:'discard'};
  const restored = await restore(scope,{taskId:1,sessionId:2});
  assert.equal(restored.ok,true); assert.equal(restored.value.canDelete,false); assert.equal(restored.value.private,undefined);
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
  reply = {revision:1,version:1,sessionArchive:true,sessionArchiveHistory:true,sessionArchiveChildren:true};
  const capabilities = (await handlers.get('workspace:revision')(event,scope)).value;
  assert.equal(capabilities.sessionArchiveHistory,true);
  assert.equal(capabilities.sessionArchiveChildren,true);
  const remove = input => handlers.get('workspace:delete-session')(event,scope,input);
  for (const input of [null, {taskId:1,sessionId:0}, {taskId:'1',sessionId:2}]) assert.throws(() => remove(input));
  assert.throws(() => handlers.get('workspace:delete-session')({senderFrame:{},sender},scope,{taskId:1,sessionId:2}));
  reply = {accepted:true};
  assert.equal((await remove({taskId:1,sessionId:2})).ok,true);
  assert.deepEqual(requests.at(-1),{path:'/api/desktop-workspace/tasks/1/sessions/2/delete',body:null});
  for (const stopAgents of [[], [2], [3, 3], [0], ['3'], Array.from({ length: 33 }, (_, index) => index + 3)])
    assert.throws(() => archive(scope, { taskId: 1, sessionId: 2, confirmStop: true, stopAgents }));
  assert.throws(() => archive(scope, { taskId: 1, sessionId: 2, confirmStop: true, includeChildren: 'yes' }));
  assert.equal((await archive(scope, { taskId: 1, sessionId: 2, confirmStop: true, stopAgents: [3, 4], includeChildren: true })).ok, true);
  assert.deepEqual(requests.at(-1).body, { confirmStop: true, stopAgents: [3, 4], includeChildren: true });
  reply = {accepted:false};
  assert.equal((await remove({taskId:1,sessionId:2})).error.code,'outcome-unknown');
  reply = {items:[{id:2,taskId:1,repoId:3,name:'Busy',status:'running',turnStatus:'review',commandCount:2,childStopRequired:true,provider:'codex',updatedAt:''}],nextCursor:null};
  const busy = await handlers.get('workspace:sessions')(event,scope,{taskId:1});
  assert.equal(busy.ok,true); assert.equal(busy.value.items[0].turnStatus,'review'); assert.equal(busy.value.items[0].commandCount,2);
  assert.equal(busy.value.items[0].childStopRequired,true);
  for (const invalid of [{commandCount:-1},{commandCount:1.5},{commandCount:'2'},{turnStatus:7}]) {
    reply = {items:[{id:2,taskId:1,repoId:3,name:'Busy',status:'running',provider:'codex',updatedAt:'',...invalid}],nextCursor:null};
    assert.equal((await handlers.get('workspace:sessions')(event,scope,{taskId:1})).ok,false);
  }
  reply = {items:[{id:2,taskId:1,repoId:3,name:'Invalid flag',status:'queued',provider:'codex',updatedAt:'',canDelete:'yes'}],nextCursor:null};
  assert.equal((await handlers.get('workspace:sessions')(event,scope,{taskId:1})).ok,false);
  const priority = input => handlers.get('workspace:sessions')(event,scope,{taskId:1,state:'priority',...input});
  assert.throws(() => priority({ parentSessionId: null }));
  const child = { id: 5, taskId: 1, repoId: 3, parentSessionId: 2, name: 'New reply', status: 'review', provider: 'codex', updatedAt: '' };
  const parent = { ...child, id: 2, status: 'done', parentSessionId: null, childCount: 1 };
  reply = { items: [child], parentSessions: [parent], nextCursor: '5' };
  assert.equal((await priority({ limit: 1 })).value.parentSessions[0].id, 2);
  assert.match(requests.at(-1).path, /state=priority/);
  assert.equal((await priority({ cursor: '5' })).ok, false);
  for (const invalid of [{ ...parent, taskId: 9 }, { ...parent, id: 7 }, { ...parent, status: 'archived' }]) {
    reply = { ...reply, parentSessions: [invalid] };
    assert.equal((await priority({})).ok, false);
  }
  const requestCount = requests.length;
  client.reset(42);
  assert.equal((await remove({taskId:1,sessionId:2})).error.code,'stale-scope');
  assert.equal((await archive(scope,{taskId:1,sessionId:2,confirmStop:false})).error.code,'stale-scope');
  assert.equal((await priority({})).error.code,'stale-scope');
  assert.equal(requests.length,requestCount);
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
  const completionAt = '2026-11-14T12:00:00.000Z';
  assert.deepEqual(parseChatAction({ type: 'mark-seen', completionAt, private: 'drop' }), { type: 'mark-seen', completionAt });
  for (const at of [undefined, null, '', 42, 'yesterday', '2026-99-99T00:00:00.000Z', 'x'.repeat(100)])
    assert.throws(() => parseChatAction({ type: 'mark-seen', completionAt: at }));
  assert.deepEqual(parseChatAction({ type: 'send', text: 'hello', queue: true, private: 'drop' }), { type: 'send', text: 'hello', queue: true });
  assert.deepEqual(parseChatAction({ type: 'send', text: 'compare', queue: false, sessionIds: [12, 13] }), { type: 'send', text: 'compare', queue: false, sessionIds: [12, 13] });
  for (const sessionIds of [[0], [-1], [1.2], ['12'], [12, 12], Array.from({ length: 9 }, (_, i) => i + 1)])
    assert.throws(() => parseChatAction({ type: 'send', text: 'compare', queue: false, sessionIds }));
  for (const invalid of [{ type: 'shell', command: 'anything' }, { type: 'send', text: '', queue: false }, { type: 'send', text: 'x'.repeat(64001), queue: false }, { type: 'permission', id: 'id', decision: 'yes' }, { type: 'answer', id: 'id', answers: { q: ['x'.repeat(4001)] } }]) assert.throws(() => parseChatAction(invalid));
  assert.throws(() => parseChatPage({ taskId: 3, sessionId: 2 }, 1, 2));
  assert.throws(() => parseChatPage({ taskId: 1, sessionId: 2, cursor: 'x'.repeat(201) }, 1, 2));
});

test('chat accepts bounded queued handoffs from engines using the capability', () => {
  const { parseChatState } = require('../dist/backend-client/session-chat-validation');
  const prompt = { id: 'q1', text: 'Queued follow-up', timestamp: '2026-11-14T12:00:00.000Z' };
  assert.equal(parseChatState(chatState).canSteer, undefined);
  assert.equal(parseChatState({ ...chatState, provider: 'antigravity', canSteer: false }).canSteer, false);
  assert.throws(() => parseChatState({ ...chatState, canSteer: 'false' }));
  assert.equal(parseChatState(chatState).dispatchingPrompts, undefined);
  assert.deepEqual(parseChatState({ ...chatState, dispatchingPrompts: [] }).dispatchingPrompts, []);
  assert.deepEqual(parseChatState({
    ...chatState, dispatchingPrompts: [{ ...prompt, images: ['do not expose provider data'] }],
  }).dispatchingPrompts, [prompt]);
  for (const dispatchingPrompts of [[{ ...prompt, timestamp: 'bad' }], [{ ...prompt, text: 'x'.repeat(64001) }], Array(9).fill(prompt)])
    assert.throws(() => parseChatState({ ...chatState, dispatchingPrompts }));
});

test('chat preserves bounded confirmation details and passes only the scoped elicitation answer', () => {
  const { parseChatAction, parseChatState } = require('../dist/backend-client/session-chat-validation');
  const question = { id: 'elicitation', message: 'Allow Computer Use to use "Google Chrome"?', questions: [], url: null };
  assert.deepEqual(parseChatState({ ...chatState, question }).question, question);
  const decision = { kind: 'confirm', title: 'Allow Computer Use?', source: 'Computer Use', description: '' };
  assert.deepEqual(parseChatState({ ...chatState, question: { ...question, decision: { ...decision, private: 'drop' } } }).question,
    { ...question, decision });
  assert.throws(() => parseChatState({ ...chatState, question: { ...question, decision: { ...decision, source: 'x'.repeat(1001) } } }));
  assert.deepEqual(parseChatAction({ type: 'answer', id: question.id, answers: {}, remember: true }),
    { type: 'answer', id: question.id, answers: {} });
});

test('delegation metadata validates identities, tool receipts and view bounds', () => {
  const { parseChatPage, parseChatState } = require('../dist/backend-client/session-chat-validation');
  const at = '2026-11-14T12:00:00.000Z';
  const child = { sessionId: 3, taskId: 1, title: 'Review', selection: { provider: 'codex', model: 'worker' } };
  const live = { session: child, status: 'waiting', detail: 'Choose a timeout', startedAt: at, endedAt: null };
  const state = { ...chatState, work: { running: [], recent: [], sessions: [live], totalSessionsRunning: 1 } };
  assert.equal(parseChatState(state, 2, 1).work.sessions[0].session.sessionId, 3);
  for (const sessions of [[live, live], [{ ...live, session: { ...child, taskId: 2 } }],
    [{ ...live, session: { ...child, sessionId: 2 } }], Array(29).fill(live)])
    assert.throws(() => parseChatState({ ...state, work: { ...state.work, sessions } }, 2, 1));

  const page = { taskId: 1, sessionId: 2, cursor: 'delegation', before: null, reset: true, items: [], events: [], state };
  const user = { id: 'prompt', kind: 'user', text: 'Review', timestamp: at, toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
  const sender = { session: child, purpose: 'message' };
  assert.equal(parseChatPage({ ...page, items: [{ ...user, sender }] }, 1, 2).items[0].sender.purpose, 'message');
  assert.throws(() => parseChatPage({ ...page, items: [{ ...user, sender, editable: true }] }, 1, 2));
  const call = { ...user, kind: 'tool_use', agent: { id: user.id, at, operation: { type: 'wait', sessions: [3] } } };
  assert.equal(parseChatPage({ ...page, items: [call] }, 1, 2).items[0].agent.operation.type, 'wait');
  assert.throws(() => parseChatPage({ ...page, items: [{ ...call, agent: { ...call.agent, id: 'different' } }] }, 1, 2));
  const notice = { ...user, id: 'notice', kind: 'system', agent: { id: 'notice', at, endedAt: at,
    operation: { type: 'native-wait', agents: ['ses_review'] },
    result: { agents: [{ agentId: 'ses_review', status: 'completed' }] } } };
  assert.equal(parseChatPage({ ...page, items: [notice] }, 1, 2).items[0].agent.result.agents[0].status, 'completed');
  assert.throws(() => parseChatPage({ ...page, items: [{ ...notice, kind: 'assistant' }] }, 1, 2));
});

test('harness selection requires a known action shape and an expected current provider', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  assert.deepEqual(parseChatAction({ type: 'provider', provider: 'claude', expectedProvider: 'codex', private: 'discard' }), { type: 'provider', provider: 'claude', expectedProvider: 'codex' });
  for (const input of [{ type: 'provider', provider: 'claude' }, { type: 'provider', provider: '', expectedProvider: 'codex' }, { type: 'provider', provider: 'claude', expectedProvider: 1 }]) assert.throws(() => parseChatAction(input));
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  const record = { id: 'row', kind: 'assistant', text: 'Reply', timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
  const window = { ...page, items: Array.from({ length: 320 }, (_, i) => ({ ...record, id: String(i) })) };
  assert.equal(parseChatPage(window, 1, 2, 'window').items.length, 320);
  assert.throws(() => parseChatPage(window, 1, 2));
  assert.throws(() => parseChatPage(window, 1, 2, 'progressive'));
  assert.throws(() => parseChatPage({ ...window, items: [...window.items, record] }, 1, 2, 'window'));
  assert.throws(() => parseChatPage({ ...page, events: Array(321).fill({ type: 'item', item: record }) }, 1, 2, 'window'));
  const active = { ...state, phase: 'running', activePromptId: 'prompt' };
  const phased = { ...record, assistantPhase: 'commentary' };
  const livePage = parseChatPage({ ...page, state: active, items: [phased] }, 1, 2);
  assert.equal(livePage.state.activePromptId, 'prompt');
  assert.equal(livePage.items[0].assistantPhase, 'commentary');
  for (const badId of ['', 1, 'x'.repeat(1001)])
    assert.throws(() => parseChatPage({ ...page, state: { ...active, activePromptId: badId } }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, state: { ...active, phase: 'idle' } }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, items: [{ ...phased, kind: 'user' }] }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, items: [{ ...phased, assistantPhase: 'unknown' }] }, 1, 2));
  const completionAt = '2026-11-14T12:00:00.000Z';
  assert.equal(parseChatPage(page, 1, 2).state.unseenCompletionAt, undefined);
  for (const unseenCompletionAt of [completionAt, null])
    assert.equal(parseChatPage({ ...page, state: { ...state, unseenCompletionAt } }, 1, 2).state.unseenCompletionAt, unseenCompletionAt);
  for (const unseenCompletionAt of ['', 1, 'bad', 'x'.repeat(100)])
    assert.throws(() => parseChatPage({ ...page, state: { ...state, unseenCompletionAt } }, 1, 2));
  assert.equal(parseChatPage({ ...page, next: 'forward' }, 1, 2).next, 'forward');
  assert.equal(parseChatPage({ ...page, next: null }, 1, 2).next, null);
  assert.equal(parseChatPage(page, 1, 2).next, undefined);
  assert.equal(parseChatPage(page, 1, 2).leadingPrompt, undefined);
  assert.equal(parseChatPage({ ...page, leadingPrompt: null }, 1, 2).leadingPrompt, null);
  assert.throws(() => parseChatPage({ ...page, next: 7 }, 1, 2));

  const message = { id: 'u', kind: 'user', text: 'Compare', timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
  assert.deepEqual(parseChatPage({ ...page, leadingPrompt: { ...message, private: 'discard' } }, 1, 2).leadingPrompt, message);
  assert.throws(() => parseChatPage({ ...page, leadingPrompt: { ...message, kind: 'assistant' } }, 1, 2));
  assert.throws(() => parseChatPage({ ...page, leadingPrompt: { ...message, text: 'x'.repeat(65000) } }, 1, 2));
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


test('background work is optional, bounded and validated, and stop targets only live-work keys', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'claude', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  assert.equal(parseChatPage(page, 1, 2).state.work, undefined);
  const item = { id: 'task:shell', kind: 'task', label: 'pnpm test', detail: '', startedAt: '2026-11-10T10:00:00Z', stoppable: true, orphaned: false, tokens: 10, toolUses: 2 };
  const event = { id: 'hook:1', kind: 'hook', tone: 'danger', title: 'Hook failed', detail: 'exit 2', at: null };
  const parsed = parseChatPage({ ...page, state: { ...state, work: { running: [{ ...item, private: 'drop' }], recent: [{ ...event, raw: {} }] } } }, 1, 2);
  assert.deepEqual(parsed.state.work, { running: [item], recent: [event] });
  const nativeCompletion = { ...event, kind: 'finished', agentId: 'child', agentStatus: 'completed', model: 'Sonnet', effort: 'high' };
  assert.deepEqual(parseChatPage({ ...page, state: { ...state, work: { running: [], recent: [nativeCompletion] } } }, 1, 2).state.work.recent, [nativeCompletion]);
  const agent = { ...item, id: 'subagent:a', kind: 'agent', label: 'Review · reviewer', title: 'Review', role: 'reviewer', agentName: 'James' };
  assert.deepEqual(parseChatPage({ ...page, state: { ...state, work: { running: [agent], recent: [] } } }, 1, 2).state.work.running, [agent]);
  for (const work of [
    { running: [{ ...agent, agentName: 7 }], recent: [] },
    { running: [{ ...agent, agentName: 'x'.repeat(161) }], recent: [] },
    { running: [{ ...agent, role: 7 }], recent: [] },
    { running: [{ ...agent, role: 'x'.repeat(121) }], recent: [] },
    { running: Array(17).fill(item), recent: [] },
    { running: [], recent: Array(13).fill(event) },
    { running: [{ ...item, id: 'shell' }], recent: [] },
    { running: [{ ...item, kind: 'process' }], recent: [] },
    { running: [{ ...item, startedAt: 'yesterday' }], recent: [] },
    { running: [{ ...item, stoppable: 'yes' }], recent: [] },
    { running: [], recent: [{ ...event, tone: 'loud' }] },
    { running: [], recent: [{ ...nativeCompletion, model: 'x'.repeat(161) }] },
    { running: [], recent: [{ ...event, detail: 'x'.repeat(1101) }] },
  ]) assert.throws(() => parseChatPage({ ...page, state: { ...state, work } }, 1, 2));
  assert.deepEqual(parseChatAction({ type: 'stop-background', id: 'subagent:a', extra: 1 }), { type: 'stop-background', id: 'subagent:a' });
  for (const id of ['', 'task:', 'shell', 'task:' + 'x'.repeat(400), 5]) assert.throws(() => parseChatAction({ type: 'stop-background', id }));
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

test('per-model quota stays optional, scoped to its provider and bounded at the bridge', () => {
  const { parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'antigravity', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [], events: [], state };
  const model = { id: 'claude-opus', label: 'Claude Opus', remainingPercentage: null, exhausted: true, resetsAt: 1795000000 };
  const quota = { provider: 'antigravity', tier: 'Antigravity Starter Quota', updatedAt: '2026-11-24T10:00:00Z', models: [model] };
  const parse = modelQuota => parseChatPage({ ...page, state: { ...state, modelQuota } }, 1, 2).state.modelQuota;
  assert.equal(parseChatPage(page, 1, 2).state.modelQuota, undefined);
  assert.equal(parse(null), null);
  assert.deepEqual(parse({ ...quota, credential: 'discard', models: [{ ...model, token: 'discard' }] }), quota);
  assert.deepEqual(parse({ ...quota, tier: null, models: [] }), { ...quota, tier: null, models: [] });
  for (const extra of [{ provider: 'codex' }, { updatedAt: 'invalid' }, { models: Array(33).fill(model) }, { models: [model, model] }]) assert.throws(() => parse({ ...quota, ...extra }));
  for (const patch of [{ id: '' }, { exhausted: 'yes' }, { remainingPercentage: 101 }, { remainingPercentage: '5' }, { resetsAt: -1 }, { resetsAt: 9e12 }]) assert.throws(() => parse({ ...quota, models: [{ ...model, ...patch }] }));
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

test('saved preset edits validate revision, unique order and restoration position', () => {
  const { parseChatAction } = require('../dist/backend-client/session-chat-validation');
  const expectedRevision = 'a'.repeat(64);
  const reorder = { type: 'preset-reorder', ids: ['deep', 'quick'], expectedRevision };
  const update = { type: 'preset-update', id: 'deep', name: 'Deep work', provider: 'codex', model: null, reasoning: null, fast: false, expectedRevision };
  const restore = { ...update, type: 'preset-restore', position: 0, defaultProvider: 'codex', defaultIds: ['deep'] };
  for (const action of [reorder, update, restore, { type: 'preset-delete', id: 'deep', expectedRevision }]) {
    assert.deepEqual(parseChatAction({ ...action, extra: 'discard' }), action);
    assert.throws(() => parseChatAction({ ...action, expectedRevision: 'stale' }));
  }
  assert.throws(() => parseChatAction({ ...reorder, ids: ['deep', 'deep'] }));
  assert.throws(() => parseChatAction({ ...reorder, ids: Array.from({ length: 25 }, (_, index) => String(index)) }));
  assert.throws(() => parseChatAction({ ...update, provider: '../provider' }));
  assert.throws(() => parseChatAction({ ...restore, position: 24 }));
  assert.throws(() => parseChatAction({ ...restore, defaultIds: ['deep', 'deep'] }));
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

test('prompt editing accepts bounded text and a saved user anchor only', () => {
  const { parseChatAction, parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const action = { type: 'edit-prompt', itemId: 'user:1', text: 'A revised prompt', revision: 'a'.repeat(64) };
  assert.deepEqual(parseChatAction({ ...action, providerPath: '/private/path' }), action);
  for (const invalid of [{ itemId: '' }, { itemId: 'x'.repeat(1001) }, { text: ' ' },
    { text: 'x'.repeat(64001) }, { revision: 'stale' }])
    assert.throws(() => parseChatAction({ ...action, ...invalid }));
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const row = { id: action.itemId, kind: 'user', editable: true, text: 'Original', timestamp: '', toolId: null, toolName: null, toolKind: null, input: '', error: false, truncated: false };
  const page = { taskId: 1, sessionId: 2, cursor: 'cursor', before: null, reset: true, items: [row], events: [], state };
  assert.equal(parseChatPage(page, 1, 2).items[0].editable, true);
  assert.throws(() => parseChatPage({ ...page, items: [{ ...row, kind: 'assistant' }] }, 1, 2));
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
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
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

test('agent transcript validation checks identity, bounds, states and reported context', () => {
  const { parseChatAgentPage, parseChatAction } = require('../dist/backend-client/session-chat-validation');
  const value = { agentId: 'child', label: 'Reviewer', status: 'interrupted', prompt: '', model: null,
    context: { tokens: 100, limit: 200, percentage: 50 }, items: [], before: null, availability: 'available', message: '', privatePath: '/hidden' };
  assert.equal(parseChatAgentPage(value, 'child').status, 'interrupted');
  assert.equal(parseChatAgentPage(value, 'child').privatePath, undefined);
  const titled = { ...value, title: 'Review retry handling', agentName: 'James', role: 'reviewer' };
  assert.equal(parseChatAgentPage(titled, 'child').agentName, 'James');
  assert.equal(parseChatAgentPage(titled, 'child').title, 'Review retry handling');
  assert.throws(() => parseChatAgentPage({ ...titled, agentName: 7 }, 'child'));
  assert.throws(() => parseChatAgentPage({ ...titled, agentName: 'x'.repeat(161) }, 'child'));
  assert.throws(() => parseChatAgentPage({ ...titled, title: 'x'.repeat(301) }, 'child'));
  assert.throws(() => parseChatAgentPage({ ...titled, role: 7 }, 'child'));
  for (const malformed of [{ ...value, agentId: 'other' }, { ...value, status: 'success' }, { ...value, context: { tokens: 100, limit: 0, percentage: 50 } }, { ...value, items: Array(81).fill({}) }])
    assert.throws(() => parseChatAgentPage(malformed, 'child'));
  assert.deepEqual(parseChatAction({ type: 'background-agent', id: 'child' }), { type: 'background-agent', id: 'child' });
  assert.throws(() => parseChatAction({ type: 'background-agent', id: '../other' }));
});

test('named child history adapter confines reads to a trusted window and expected scope', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises'), vm = require('node:vm');
  let calls = 0;
  const reply = { agentId: 'child', label: 'Reviewer', status: 'running', prompt: '', model: null, context: null,
    items: [], before: null, availability: 'starting', message: '' };
  const url = await server(context, (request, response) => {
    calls++; assert.equal(request.url, '/api/desktop-workspace/tasks/1/sessions/2/chat/agent?agentId=child');
    response.writeHead(200, json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url), () => {}); context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id, handlers = new Map(), ipc = {}, adapter = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/session-chat-agents'), 'utf8'), {
    exports: adapter, URLSearchParams, require: name => name === '../ipc' ? ipc : require('../dist/backend-client/' + name.slice(2)),
  });
  const frame = {}, sender = { id: 42 }, event = { senderFrame: frame, sender };
  const stop = adapter.registerChatAgents(client, (candidate, contents) => candidate === frame && contents === sender); context.after(stop);
  const read = input => handlers.get('session-chat:agent')(event, scope, { taskId: 1, sessionId: 2, agentId: 'child', requestId: 'read', ...input });
  assert.equal((await read()).ok, true); assert.equal(calls, 1);
  assert.throws(() => read({ agentId: '../other' }));
  assert.throws(() => read({ before: '../path' }));
  assert.throws(() => handlers.get('session-chat:agent')({ senderFrame: {}, sender }, scope, {}));
  const stale = await handlers.get('session-chat:agent')(event, 'b'.repeat(36), { taskId: 1, sessionId: 2, agentId: 'child', requestId: 'read' });
  assert.equal(stale.error.code, 'stale-scope'); assert.equal(calls, 1);
  stop(); assert.equal(handlers.size, 0);
});

test('session moves validate scope, input, reply identity and paginated children', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  let reply = {id:2,taskId:1,repoId:3,name:'Child',status:'done',provider:'codex',updatedAt:'',parentSessionId:4};
  const requests = [];
  const url = await server(context, (request,response) => {
    requests.push(request.url); response.writeHead(200,json); response.end(JSON.stringify(reply));
  });
  const client = new BackendClient(() => local(url),()=>undefined);
  context.after(()=>client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id, handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'),'utf8'),{exports:ipc,require:()=>({ipcMain:{handle:(channel,handler)=>handlers.set(channel,handler),removeHandler:channel=>handlers.delete(channel)}})});
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'),'utf8'),{exports:workspace,URLSearchParams,require:name=>name==='../ipc'?ipc:require('../dist/backend-client/transport')});
  const frame = {}, sender = {id:42}, event = {senderFrame:frame,sender};
  const stop = workspace.registerWorkspaceIpc(client,(candidate,contents)=>candidate===frame && contents===sender); context.after(stop);
  const move = input => handlers.get('workspace:move-session')(event,scope,input);
  for (const parentSessionId of [undefined,'4',-1,0,1.2,2]) assert.throws(()=>move({taskId:1,sessionId:2,parentSessionId}));
  assert.equal((await move({taskId:1,sessionId:2,parentSessionId:4})).value.parentSessionId,4);
  assert.equal(requests[0],'/api/desktop-workspace/tasks/1/sessions/2/parent');
  reply = {...reply,parentSessionId:5};
  assert.equal((await move({taskId:1,sessionId:2,parentSessionId:4})).error.code,'outcome-unknown');
  reply = {items:[{...reply,parentSessionId:4,childCount:0}],nextCursor:null};
  const children = input => handlers.get('workspace:sessions')(event,scope,input);
  assert.equal((await children({taskId:1,parentSessionId:4,limit:20})).ok,true);
  assert.match(requests.at(-1),/parentSessionId=4/);
  assert.equal((await children({taskId:1,parentSessionId:5})).ok,false);
  reply.nextCursor = '2:12';
  assert.equal((await children({taskId:1,parentSessionId:4,childOrder:'nested',cursor:'3:20'})).value.nextCursor,'2:12');
  assert.match(requests.at(-1),/childOrder=nested/);
  assert.match(requests.at(-1),/cursor=3%3A20/);
  assert.equal((await children({taskId:1,parentSessionId:4})).ok,false); // unchanged legacy cursor validation
  for (const input of [{taskId:1,childOrder:'nested'}, {taskId:1,parentSessionId:null,childOrder:'nested'}, {taskId:1,parentSessionId:4,childOrder:'other'}, {taskId:1,parentSessionId:4,childOrder:'nested',cursor:'1:2:3'}]) assert.throws(()=>children(input));
  reply.nextCursor = null;
  reply.items[0].childCount = -1;
  assert.equal((await children({taskId:1,parentSessionId:4})).ok,false);
  client.reset(42); const count = requests.length;
  assert.equal((await move({taskId:1,sessionId:2,parentSessionId:null})).error.code,'stale-scope');
  assert.equal(requests.length,count); stop(); assert.equal(handlers.size,0);
});

test('navigation waits bound and validate replies, coalesce per request and cancel only within the owning window and scope', async context => {
  const { URLSearchParams } = require('node:url');
  const { readFile } = require('node:fs/promises');
  const vm = require('node:vm');
  let arrive;
  const arrived = new Promise(resolve => { arrive = resolve; });
  const requests = [];
  const url = await server(context, (request, response) => { requests.push({request,response}); arrive(); });
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(42); client.attach(43);
  const scope = client.state(42).scope.id, handlers = new Map(), ipc = {}, workspace = {};
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/workspace'), 'utf8'), { exports: workspace, URLSearchParams, require: name => name === '../ipc' ? ipc : requireWorkspace(name) });
  const frame = {}, sender = {id:42}, event = {senderFrame:frame,sender};
  const stop = workspace.registerWorkspaceIpc(client, candidate => candidate === frame); context.after(stop);
  const input = { after: 3, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
  const wait = (...args) => handlers.get('workspace:wait')(event, ...args);
  const cancel = (...args) => handlers.get('workspace:cancel-wait')(event, ...args);
  for (const invalid of [{...input, after:-1}, {...input, after:'3'}, {...input, requestId:'x'}, {...input, url:'http://example.com'}]) assert.throws(() => wait(scope,invalid));
  assert.throws(() => wait(scope,input,'extra'));
  assert.throws(() => handlers.get('workspace:wait')({senderFrame:{},sender},scope,input));
  const first = wait(scope,input), duplicate = wait(scope,input);
  await arrived; assert.equal(requests.length,1); assert.equal(requests[0].request.url,'/api/desktop-workspace/revision?after=3');
  // Neither another window nor an old scope can cancel the live read.
  handlers.get('workspace:cancel-wait')({senderFrame:frame,sender:{id:43}},scope,input.requestId);
  cancel(client.state(43).scope.id,input.requestId);
  requests[0].response.writeHead(200,json); requests[0].response.end(JSON.stringify({revision:4,version:1,revisionWait:true,sessionPriority:true,sessionNesting:true,sessionNestingOrder:true,private:'omit'}));
  const result = await first; assert.equal(result.ok,true); assert.equal(result.value.revision,4); assert.equal(result.value.private,undefined);
  assert.equal(result.value.sessionPriority,true);
  assert.equal(result.value.sessionNesting,true); assert.equal(result.value.sessionNestingOrder,true);
  assert.deepEqual(await duplicate,result);
  const pending = wait(scope,{...input, after:4});
  cancel(scope,input.requestId); assert.equal((await pending).ok,false);
  const late = wait(scope,{...input, after:5}); client.reset(42); assert.equal((await late).error.code,'stale-scope');
  assert.equal((await wait(scope,input)).error.code,'stale-scope');
  stop(); assert.equal(handlers.size,0);
});

test('completed activity and tool details validate opted-in, scoped and bounded records', async context => {
  const { URLSearchParams } = require('node:url');
  const { parseChatPage } = require('../dist/backend-client/session-chat-validation');
  const state = { provider: 'codex', phase: 'idle', canInterrupt: false, error: null, model: null, models: [], reasoning: null, plan: false, permissionMode: null, permissionModes: [], context: null, queue: [], queuePaused: false, permission: null, question: null, activity: [] };
  const revision = 'a'.repeat(64);
  const record = (id, kind) => ({ id, kind, text: 'text', timestamp: '2026-11-19T10:00:00Z', toolId: null, toolKind: null, toolName: null, input: '', error: false, truncated: false });
  const summary = { revision, endId: 'reply', beforeReply: 1, total: 1, counts: { run: 1 }, failures: 0, reply: [record('reply', 'assistant')] };
  const page = { taskId: 5, sessionId: 9, cursor: 'cursor', reset: true, state, items: [{ ...record('prompt', 'user'), completedTurn: summary }], events: [], before: null };
  assert.equal(parseChatPage(page, 5, 9, 'progressive', true).items[0].completedTurn.revision, revision);
  assert.throws(() => parseChatPage(page, 5, 9, 'progressive'), /incompatible/);
  for (const completedTurn of [{ ...summary, total: 0 }, { ...summary, beforeReply: 2 }, { ...summary, counts: { run: 2 } }, { ...summary, reply: [record('tool', 'tool_use')] }]) {
    assert.throws(() => parseChatPage({ ...page, items: [{ ...page.items[0], completedTurn }] }, 5, 9, 'progressive', true), /incompatible/);
  }
  const changes = { total: 14, files: [{ path: 'retry.ts', status: 'M', add: 2, del: 1 }], lineTotals: { add: 216, del: 339 } };
  const fullHistory = { ...page, items: [{ ...record('prompt', 'user'), turnChanges: changes }] };
  assert.deepEqual(parseChatPage(fullHistory, 5, 9, 'window').items[0].turnChanges, changes);
  const compactHistory = { ...page, items: [{ ...page.items[0], completedTurn: { ...summary, changes } }] };
  assert.deepEqual(parseChatPage(compactHistory, 5, 9, 'progressive', true).items[0].completedTurn.changes, changes);
  for (const turnChanges of [
    { ...changes, lineTotals: { add: 1, del: 10 } },
    { ...changes, total: 1 },
    { ...changes, lineTotals: { add: 5, del: -1 } },
  ]) {
    assert.throws(() => parseChatPage({ ...fullHistory, items: [{ ...fullHistory.items[0], turnChanges }] }, 5, 9, 'window'), /incompatible/);
  }
  const tool = { ...record('call', 'tool_use'), toolId: 'operation', text: '' };
  const heading = { ...tool, toolDetails: { revision, summary: 'pnpm test', private: 'discard' } };
  const callWithReceipt = { ...heading, receipt: { id: 'result', error: true, toolDetails: { revision, meta: 'Exit 1' } } };
  const linkedResult = { ...record('result', 'tool_result'), text: '', toolId: 'operation', error: true,
    toolDetails: { revision, meta: 'Exit 1' }, invocation: { id: 'call', toolKind: 'bash', toolDetails: heading.toolDetails } };
  const compact = { ...page, items: [callWithReceipt, linkedResult], events: [{ type: 'item', item: callWithReceipt }] };
  const parsed = parseChatPage(compact, 5, 9, 'window', false, true);
  assert.deepEqual(parsed.items[0].toolDetails, { revision, summary: 'pnpm test' });
  assert.deepEqual(parsed.events[0].item.toolDetails, parsed.items[0].toolDetails);
  assert.deepEqual(parsed.events[0].item.receipt, callWithReceipt.receipt);
  assert.deepEqual(parsed.items[1].invocation, { id: 'call', toolKind: 'bash', toolDetails: { revision, summary: 'pnpm test' } });
  assert.throws(() => parseChatPage(compact, 5, 9, 'window'), /incompatible/);
  for (const invalid of [
    { ...heading, input: 'unexpected' }, { ...heading, kind: 'assistant' }, { ...heading, toolDetails: { revision: 'invalid' } },
    { ...linkedResult, invocation: { ...linkedResult.invocation, id: 'result' } },
    { ...linkedResult, toolDetails: undefined },
    { ...heading, receipt: { ...callWithReceipt.receipt, id: 'call' } },
  ]) {
    assert.throws(() => parseChatPage({ ...compact, items: [invalid] }, 5, 9, 'window', false, true), /incompatible/);
  }

  const { readFile } = require('node:fs/promises'), vm = require('node:vm');
  const handlers = new Map(), ipc = {}, adapter = {}, requests = [];
  let hold;
  let response = { taskId: 5, sessionId: 9, turnId: 'prompt', revision, offset: 0, total: 2, nextOffset: 1, items: [{ ...record('call', 'tool_use'), receipt: { id: 'result', error: false } }], private: 'discard' };
  const url = await server(context, (request, reply) => {
    requests.push(request.url);
    if (hold) { hold(); return; }
    reply.writeHead(200, json);
    reply.end(JSON.stringify(response));
  });
  const client = new BackendClient(() => local(url), () => {});
  context.after(() => client.dispose()); client.attach(42);
  const scope = client.state(42).scope.id, frame = {}, sender = { id: 42 };
  vm.runInNewContext(await readFile(require.resolve('../dist/ipc'), 'utf8'), { exports: ipc, require: () => ({ ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) } }) });
  vm.runInNewContext(await readFile(require.resolve('../dist/backend-client/session-chat'), 'utf8'), {
    exports: adapter, URLSearchParams,
    require: name => name === '../ipc' ? ipc : ({
      './session-chat-agents': { registerChatAgents: () => () => undefined },
      './session-chat-attachments': { registerChatAttachments: () => () => undefined },
      './session-chat-media': { registerSessionChatMedia: () => () => undefined },
    })[name] ?? require(name.startsWith('./') ? '../dist/backend-client/' + name.slice(2) : name),
  });
  const stop = adapter.registerSessionChatIpc(client, candidate => candidate === frame);
  context.after(stop);
  const work = handlers.get('session-chat:turn-work');
  const input = { taskId: 5, sessionId: 9, turnId: 'prompt', revision, offset: 0, requestId: 'test' };
  const read = (value = input) => work({ senderFrame: frame, sender }, scope, value);
  assert.throws(() => work({ senderFrame: {}, sender }, scope, input), /Untrusted/);
  assert.throws(() => read({ ...input, offset: 0.5 }));
  assert.throws(() => read({ ...input, revision: 'old' }));
  assert.equal((await work({ senderFrame: frame, sender }, 'b'.repeat(36), input)).error.code, 'stale-scope');
  assert.equal(requests.length, 0);
  const result = await read();
  assert.equal(requests[0], `/api/desktop-workspace/tasks/5/sessions/9/chat/turn-work?turnId=prompt&revision=${revision}&offset=0`);
  assert.equal(result.value.private, undefined);
  assert.equal(result.value.items[0].receipt.id, 'result');
  const valid = response;
  for (const patch of [{ sessionId: 10 }, { turnId: 'another' }, { offset: 1 }, { nextOffset: 2 }, { items: [record('person', 'user')] }, { items: Array(41).fill(record('call', 'tool_use')) }]) {
    response = { ...valid, ...patch };
    assert.equal((await read()).error.code, 'invalid-response');
  }
  response = { ...valid, items: [{ ...heading, receipt: { id: 'result', error: false, toolDetails: { revision, meta: 'Exit 0' } } }] };
  assert.equal((await read({ ...input, deferToolDetails: true })).value.items[0].receipt.toolDetails.meta, 'Exit 0');
  assert.match(requests.at(-1), /deferToolDetails=1$/);
  const largeRead = { ...input, deferToolDetails: true, limit: 512 };
  response = { ...valid, total: 105, nextOffset: null,
    items: Array.from({ length: 105 }, (_, index) => record(`activity-${index}`, 'assistant')) };
  assert.equal((await read(largeRead)).value.items.length, 105);
  assert.match(requests.at(-1), /deferToolDetails=1&limit=512$/);
  assert.equal((await read({ ...input, deferToolDetails: true })).error.code, 'invalid-response');
  for (const invalid of [{ ...input, limit: 512 }, { ...largeRead, limit: 513 }, { ...largeRead, limit: 0 }])
    assert.throws(() => read(invalid));

  const timelineRead = { ...largeRead, timeline: true };
  assert.throws(() => read({ ...input, timeline: true }));
  const shortCall = { kind: 'call', id: 'call', toolKind: 'bash', label: 'pnpm test', resultId: 'result' };
  const timeline = { ...valid, items: undefined, nextOffset: null, timeline: [{ ...shortCall, input: 'discard' }, null] };
  response = timeline;
  assert.deepEqual((await read(timelineRead)).value.timeline, [shortCall, null]);
  assert.match(requests.at(-1), /limit=512&timeline=1&complete=1$/);
  response = { ...timeline, total: 8193, timeline: [shortCall, ...Array(8192).fill(null)] };
  assert.equal((await read(timelineRead)).value.timeline.length, 8193);
  response = { ...timeline, offset: 1, timeline: [null] };
  assert.equal((await read({ ...timelineRead, offset: 1 })).value.timeline.length, 1);
  assert.match(requests.at(-1), /offset=1&deferToolDetails=1&limit=512&timeline=1$/);
  response = timeline;
  assert.equal((await read(largeRead)).error.code, 'invalid-response');
  for (const invalid of [
    { ...timeline, timeline: [{ ...shortCall, label: 'x'.repeat(121) }, null] },
    { ...timeline, timeline: [{ ...shortCall, fullLabel: 'x'.repeat(501) }, null] },
    { ...timeline, timeline: [{ ...shortCall, resultId: 'prompt' }, null] },
    { ...timeline, timeline: [shortCall, shortCall] },
    { ...timeline, nextOffset: 2 },
  ]) {
    response = invalid;
    assert.equal((await read(timelineRead)).error.code, 'invalid-response');
  }
  const fullLabel = 'src/' + 'long-directory/'.repeat(12) + 'index.ts';
  const fullMeta = 'long-connection-name-'.repeat(3);
  response = { ...timeline, timeline: [{ ...shortCall, fullLabel, meta: fullMeta.slice(0, 40), fullMeta }, null] };
  assert.deepEqual((await read(timelineRead)).value.timeline, [{ ...shortCall, label: fullLabel, meta: fullMeta }, null]);
  response = valid;
  assert.equal((await read(timelineRead)).value.items.length, 1, 'A legacy engine may return ordinary work rows');

  const chatRead = value => handlers.get('session-chat:read')({ senderFrame: frame, sender }, scope, value);
  const recent = { taskId: 5, sessionId: 9, requestId: 'recent', loadingMode: 'progressive', summarizeCompleted: true, summarizeRecent: true };
  assert.throws(() => chatRead({ ...recent, summarizeCompleted: undefined }));
  response = page;
  assert.equal((await chatRead({ ...recent, deferToolDetails: true })).ok, true);
  assert.match(requests.at(-1), /loadingMode=progressive&summarizeCompleted=1&summarizeRecent=1&deferToolDetails=1$/);

  const review = value => handlers.get('session-chat:changes')({ senderFrame: frame, sender }, scope,
    { taskId: 5, sessionId: 9, requestId: 'review', turnId: 'prompt', offset: 0, ...value });
  response = { turnId: 'prompt', revision, offset: 0, nextOffset: null, files: [], total: 0, content: null };
  assert.equal((await review({})).ok, true, 'Older backends can omit a source');
  const provider = { ...response, source: 'provider', sources: ['provider', 'command'], total: 1,
    files: [{ path: 'file.txt', status: 'A', add: 1, del: 0 }],
    content: { path: 'file.txt', nextOffset: null, lines: [
      { id: '1', kind: 'add', text: 'new', evidence: 'Apply patch · patch' },
    ] } };
  response = provider;
  const readProvider = () => review({ source: 'provider', path: 'file.txt', revision });
  assert.equal((await readProvider()).value.content.lines[0].evidence, 'Apply patch · patch');
  assert.match(requests.at(-1), /source=provider/);
  response = { ...provider, source: 'command' };
  assert.equal((await readProvider()).error.code, 'invalid-response');
  assert.throws(() => review({ source: 'unknown' }), /Invalid review/);

  const item = { id: 'call', revision }, receipt = { id: 'result', revision };
  const details = { taskId: 5, sessionId: 9, item, result: receipt, requestId: 'details' };
  const body = { ...item, record: { ...tool, input: 'bounded command' } };
  const output = { ...receipt, record: { ...record('result', 'tool_result'), toolId: 'operation' } };
  const complete = { taskId: 5, sessionId: 9, item: body, result: output };
  const inspect = (value = details, selected = scope, senderFrame = frame) => handlers.get('session-chat:tool-details')({ senderFrame, sender }, selected, value);
  assert.throws(() => inspect(details, scope, {}), /Untrusted/);
  assert.throws(() => inspect({ ...details, result: item }));
  assert.throws(() => inspect({ ...details, item: { ...item, revision: 'short' } }));
  assert.equal((await inspect(details, 'b'.repeat(36))).error.code, 'stale-scope');
  response = complete;
  assert.deepEqual(await inspect(), { ok: true, value: complete });
  assert.equal(requests.at(-1), `/api/desktop-workspace/tasks/5/sessions/9/chat/tool-details?itemId=call&revision=${revision}&resultId=result&resultRevision=${revision}`);
  const savedDetails = { ...details, turnId: 'prompt' };
  response = { ...complete, turnId: 'prompt' };
  assert.equal((await inspect(savedDetails)).value.turnId, 'prompt');
  assert.match(requests.at(-1), /turnId=prompt/);
  assert.throws(() => inspect({ ...savedDetails, result: { ...receipt, revision: 'b'.repeat(64) } }));
  response = { ...complete, turnId: 'other' };
  assert.equal((await inspect(savedDetails)).error.code, 'invalid-response');
  for (const invalid of [
    { ...complete, taskId: 6 },
    { ...complete, result: undefined },
    { ...complete, item: { ...body, revision: 'b'.repeat(64) } },
    { ...complete, result: { ...output, record: { ...output.record, toolId: 'different-tool' } } },
    { ...complete, item: { ...body, record: { ...body.record, input: 'x'.repeat(16001) } } },
  ]) {
    response = invalid;
    assert.equal((await inspect()).error.code, 'invalid-response');
  }
  const arrived = new Promise(resolve => { hold = resolve; });
  const pending = inspect();
  await arrived;
  handlers.get('session-chat:cancel')({ senderFrame: frame, sender }, scope, details.requestId);
  assert.equal((await pending).ok, false);
  stop();
  assert.equal(handlers.size, 0);
});
