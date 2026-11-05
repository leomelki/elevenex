const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { RemoteBrowserStream } = require('../dist/browser/remote-stream');

async function fixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(server, 'listening');
  const controller = new AbortController(), states = [];
  const connecting = once(server, 'connection');
  const stream = new RemoteBrowserStream({ url: `http://127.0.0.1:${server.address().port}`, headers: { Authorization: 'Bearer private' } }, 1, 'viewer-token', controller.signal, value => states.push(value));
  const [socket, request] = await connecting;
  await stream.opened;
  const cleanup = async () => { stream.destroy(); await stream.closed; socket.terminate(); await new Promise(resolve => server.close(resolve)); };
  return { server, controller, states, stream, socket, request, cleanup };
}
test('private browser socket carries binary frames, pushed state and ordered input without HTTP polling', async () => {
  const f = await fixture();
  try {
    assert.equal(f.request.headers.authorization, 'Bearer private');
    assert.equal(f.request.headers['x-elevenex-browser-view'], 'viewer-token');
    assert.equal(f.request.headers.origin, undefined);
    f.socket.send(JSON.stringify({ event: 'state', state: { revision: 1 } }));
    const credit = once(f.socket, 'message');
    const frame = f.stream.request('frame', { tabId: 'one', after: 0 }, 10000, 'panel');
    const [bytes] = await credit; const id = JSON.parse(bytes).id;
    const header = Buffer.from(JSON.stringify({ id, sequence: 1, width: 800, height: 600 })), length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    f.socket.send(Buffer.concat([length, header, Buffer.from([255, 216, 255])]));
    assert.deepEqual(await frame, { sequence: 1, width: 800, height: 600, jpeg: new Uint8Array([255, 216, 255]) });
    assert.deepEqual(f.states, [{ revision: 1 }]);
    const received = once(f.socket, 'message');
    const input = f.stream.request('input', { generation: 1 });
    const [body] = await received;
    f.socket.send(JSON.stringify({ id: JSON.parse(body).id, result: { generation: 2 } }));
    assert.deepEqual(await input, { generation: 2 });
  } finally { await f.cleanup(); }
});
test('frame cancellation releases only its display and scope abort rejects mutations without replay', async () => {
  const f = await fixture();
  try {
    const panel = f.stream.request('frame', {}, 10000, 'panel');
    const companion = f.stream.request('frame', {}, 10000, 'companion');
    f.stream.cancel('panel');
    assert.equal(await panel, null);
    const mutation = f.stream.request('input', {});
    const rejected = assert.rejects(mutation, /outcome may be unknown/);
    const closed = assert.rejects(companion, /interrupted/);
    f.controller.abort();
    await Promise.all([rejected, closed, f.stream.closed]);
    await assert.rejects(f.stream.request('input', {}), /unavailable/);
  } finally { await f.cleanup(); }
});
test('malformed or oversized binary metadata closes the stream and rejects pending work', async () => {
  const f = await fixture();
  try {
    const waiting = f.stream.request('frame', {});
    const rejected = assert.rejects(waiting, /interrupted/);
    const data = Buffer.alloc(8); data.writeUInt32BE(2048);
    f.socket.send(data);
    await rejected;
  } finally { await f.cleanup(); }
});
