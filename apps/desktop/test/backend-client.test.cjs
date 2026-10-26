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
