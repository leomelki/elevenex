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
    const closed = assert.rejects(companion, error => /display connection interrupted/.test(error.message) && !/outcome/.test(error.message));
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

for (const window of [3, 8]) test(`video window ${window} negotiates compatibly and retains every dependent packet`, async () => {
  const f = await fixture();
  try {
    const commands = [];
    f.socket.on('message', bytes => {
      const request = JSON.parse(bytes);
      commands.push(request);
      if (!request.body.oneWay) f.socket.send(JSON.stringify({ id: request.id, result: null }));
    });
    const requested = once(f.socket, 'message');
    const first = f.stream.video.next('tab', 0, 'panel', window);
    const [request] = await requested;
    const subscription = JSON.parse(request).body.subscription;
    assert.equal(JSON.parse(request).body.maxInFlight, window === 8 ? 8 : undefined);
    const send = n => {
      const header = Buffer.from(JSON.stringify({ event: 'video', tabId: 'tab', subscription, sequence: n, width: 800, height: 600,
        video: { codec: 'avc1.42E02A', epoch: '11111111-1111-4111-8111-111111111111', key: n === 1, timestamp: n * 33333 } }));
      const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
      f.socket.send(Buffer.concat([length, header, Buffer.from([n])]));
    };
    for (let n = 1; n <= window; n++) send(n);
    assert.equal((await first).video.data[0], 1);
    for (let n = 2; n <= window; n++) {
      const frame = await f.stream.video.next('tab', n - 1, 'panel');
      assert.equal(frame.video.data[0], n);
    }
    assert.equal(commands.filter(c => c.body.action === 'start').length, 1);
    // Expanded-window receipts have no reply and cannot accumulate RPC deadlines.
    while (commands.filter(c => c.body.action === 'ack').length < window - 1) await once(f.socket, 'message');
    assert.ok(commands.filter(c => c.body.action === 'ack').every(c => c.body.oneWay === (window === 8 ? true : undefined)));
    f.stream.video.fallback('panel');
    assert.equal(f.stream.video.available('panel'), false);
    assert.equal(f.stream.video.available('companion'), true);
  } finally { await f.cleanup(); }
});

test('queued video preserves dependent packets and catches up without starving visible progress', async context => {
  const { RemoteBrowserVideo } = require('../dist/browser/remote-video');
  let subscription, now = 1000;
  context.mock.method(performance, 'now', () => now);
  const video = new RemoteBrowserVideo(async body => { subscription = body.subscription; return null; });
  try {
    const first = video.next('tab', 0, 'panel', 8);
    for (let n = 1; n <= 3; n++) video.receive({ tabId: 'tab', subscription, sequence: n, width: 800, height: 600,
      video: { epoch: '11111111-1111-4111-8111-111111111111', codec: 'avc1.42E02A', key: n === 1, timestamp: n * 33333 } }, new Uint8Array([n]));
    assert.equal((await first).video.data[0], 1);
    const intermediate = await video.next('tab', 1, 'panel', 8);
    assert.equal(intermediate.video.data[0], 2);
    assert.equal(intermediate.video.present, false);
    video.receive({ tabId: 'tab', subscription, sequence: 4, width: 800, height: 600,
      video: { epoch: '11111111-1111-4111-8111-111111111111', codec: 'avc1.42E02A', key: false, timestamp: 133332 } }, new Uint8Array([4]));
    now += 33;
    assert.equal((await video.next('tab', 2, 'panel', 8)).video.present, undefined, 'Sustained backlog still paints at a useful cadence');
    const latest = await video.next('tab', 3, 'panel', 8);
    assert.equal(latest.video.data[0], 4);
    assert.equal(latest.video.present, undefined);
  } finally { video.destroy(); }
});

test('a long jitter pause keeps the control socket alive without replaying an input', async context => {
  const f = await fixture();
  try {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const received = once(f.socket, 'message');
    const input = f.stream.request('input', { generation: 1 });
    const [bytes] = await received;
    context.mock.timers.tick(12000);
    assert.equal(f.socket.readyState, 1);
    f.socket.send(JSON.stringify({ id: JSON.parse(bytes).id, result: { generation: 1 } }));
    assert.deepEqual(await input, { generation: 1 });
  } finally { await f.cleanup(); }
});

test('one-way video receipts cannot fill the control RPC limit on a delayed link', async () => {
  const f = await fixture();
  try {
    f.socket.on('message', bytes => {
      const request = JSON.parse(bytes);
      if (request.method === 'ping' || request.body?.action === 'start') f.socket.send(JSON.stringify({ id: request.id, result: null }));
      // Deliberately never reply to receipts.
    });
    const start = once(f.socket, 'message');
    let next = f.stream.video.next('tab', 0, 'panel', 8);
    const [body] = await start;
    const subscription = JSON.parse(body).body.subscription;
    for (let sequence = 1; sequence <= 64; sequence++) {
      const header = Buffer.from(JSON.stringify({ event: 'video', tabId: 'tab', subscription, sequence, width: 800, height: 600,
        video: { codec: 'avc1.42E02A', epoch: '11111111-1111-4111-8111-111111111111', key: sequence === 1, timestamp: sequence * 33333 } }));
      const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
      f.socket.send(Buffer.concat([size, header, Buffer.from([sequence])]));
      assert.equal((await next).sequence, sequence);
      if (sequence < 64) next = f.stream.video.next('tab', sequence, 'panel', 8);
    }
    assert.equal(await f.stream.request('ping'), null);
  } finally { await f.cleanup(); }
});

test('cancelling a video waiter releases it without interpreting late packets as a new display', async () => {
  const f = await fixture();
  try {
    const frame = f.stream.video.next('tab', 0, 'panel');
    f.stream.cancel('panel');
    assert.equal(await frame, null);
  } finally { await f.cleanup(); }
});

test('first pixels bypass cold video startup and codec transitions retain independent source receipts', async () => {
  const { RemoteBrowserFrames } = require('../dist/browser/remote-frames');
  const { RemoteBrowserVideo } = require('../dist/browser/remote-video');
  const commands = [], jpegReads = [];
  let finish;
  const video = new RemoteBrowserVideo(async command => {
    commands.push(command);
    return null;
  });
  const frames = new RemoteBrowserFrames(video, async (tab, after) => {
    jpegReads.push(after);
    if (jpegReads.length === 2) return new Promise(resolve => { finish = resolve; });
    return { sequence: 100, width: 800, height: 600, jpeg: new Uint8Array([1]) };
  });
  try {
    const first = await frames.next('tab', 0, 'panel', 8);
    assert.equal(first.sequence, 1);
    assert.equal(commands.length, 0, 'first image never waits for capability probes or encoder startup');
    const second = frames.next('tab', 1, 'panel', 8);
    assert.equal(commands[0].action, 'start');
    assert.equal(commands[0].sequence, 0, 'JPEG cursor is never a video acknowledgment');
    video.receive({ tabId: 'tab', subscription: commands[0].subscription, sequence: 1, width: 800, height: 600,
      video: { epoch: '11111111-1111-4111-8111-111111111111', codec: 'avc1.42E02A', key: true, timestamp: 0 } }, new Uint8Array([2]));
    assert.equal((await second).sequence, 2, 'display sequence increases despite resetting source cursor');
    video.fallback('panel');
    const fallback = frames.next('tab', 2, 'panel', 8);
    assert.deepEqual(jpegReads, [0, 100]);
    finish({ sequence: 120, width: 800, height: 600, jpeg: new Uint8Array([3]) });
    assert.equal((await fallback).sequence, 3);
    // A fresh presentation must bootstrap again, even on the same retained page.
    frames.cancel('panel');
    assert.equal((await frames.next('tab', 0, 'panel', 8)).sequence, 1);
    assert.deepEqual(jpegReads, [0, 100, 0]);
  } finally { frames.destroy(); }
});

test('cancelled JPEG bootstrap cannot revive a display or allocate another video subscription', async () => {
  const { RemoteBrowserFrames } = require('../dist/browser/remote-frames');
  const { RemoteBrowserVideo } = require('../dist/browser/remote-video');
  let finish;
  const frames = new RemoteBrowserFrames(new RemoteBrowserVideo(async () => { throw new Error('Unexpected video startup'); }),
    () => new Promise(resolve => { finish = resolve; }));
  try {
    const old = frames.next('tab', 0, 'panel', 8);
    await assert.rejects(frames.next('tab', 0, 'panel', 8), /Invalid frame receipt/);
    frames.cancel('panel');
    finish({ sequence: 1, width: 800, height: 600, jpeg: new Uint8Array([1]) });
    assert.equal(await old, null);
  } finally { frames.destroy(); }
});
