const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { TaskAppStream } = require('../dist/task-apps/stream');
const { appRuns, taskPath } = require('../dist/task-apps/validation');

test('task and run identity and bounded metadata are checked before presentation', () => {
  const run = { taskId: 2, runId: randomUUID(), name: 'Electron', mode: 'stream', startedAt: 10, status: 'running' };
  assert.deepEqual(appRuns([run], 2), [run]);
  assert.throws(() => appRuns([run], 1));
  assert.throws(() => appRuns([run, run], 2));
  assert.throws(() => taskPath(1, '../another-task'));
});

test('app stream waits for a painted frame before control, rejects interrupted input and releases the socket on scope change', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const scope = new AbortController();
  const target = { taskId: 4, runId: randomUUID(), scopeId: randomUUID(), watchId: randomUUID() };
  const frame = Promise.withResolvers(), ended = Promise.withResolvers();
  const token = randomUUID();
  const stream = new TaskAppStream({ url: 'http://127.0.0.1:' + server.address().port, headers: { Authorization: 'Bearer desktop' } },
    token, target, scope.signal, frame.resolve, ended.resolve);
  const [peer, req] = await connected;
  try {
    assert.equal(req.headers['x-elevenex-app-view'], token);
    assert.equal(req.headers.authorization, 'Bearer desktop');
    peer.send(JSON.stringify({ ready: true }));
    await stream.ready;
    const input = { kind: 'down', x: 42, y: 28, button: 0 };
    await assert.rejects(stream.control(input), /first app frame/);
    const packet = Buffer.alloc(21);
    packet.writeUInt32BE(1); packet.writeUInt16BE(640, 4); packet.writeUInt16BE(480, 6);
    packet.writeUInt8(1, 8); packet.writeDoubleBE(12345, 9); packet.set([0, 0, 1, 5], 17);
    peer.send(packet);
    assert.deepEqual(await frame.promise, { ...target, sequence: 1, width: 640, height: 480, key: true, timestamp: 12345, data: Uint8Array.of(0, 0, 1, 5), codec: 'avc1.42E02A' });
    const credit = once(peer, 'message');
    stream.acknowledge(1);
    assert.deepEqual(JSON.parse((await credit)[0]), { ack: 1 });
    const requested = once(peer, 'message');
    const writing = stream.control(input);
    assert.deepEqual(JSON.parse((await requested)[0]), { id: 1, input });
    const interrupted = assert.rejects(writing, /control interrupted/);
    const releasing = stream.release();
    scope.abort();
    await Promise.all([interrupted, releasing, ended.promise]);
    await stream.release();
  } finally {
    stream.close();
    peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
