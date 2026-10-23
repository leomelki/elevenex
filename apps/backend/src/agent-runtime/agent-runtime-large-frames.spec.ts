import { WebSocket, WebSocketServer } from 'ws';
import { EventEmitter, once } from 'events';
import { createServer } from 'http';
import { AgentRuntimeGateway } from './agent-runtime.gateway.js';
import {
  MAX_AGENT_FRAME_BYTES,
  MAX_WEBSOCKET_BUFFERED_BYTES,
} from '../websocket/bounded-send.js';

function runtimeSocket(bufferedAmount = 0) {
  return Object.assign(new EventEmitter(), {
    readyState: Number(WebSocket.OPEN),
    bufferedAmount,
    send: jest.fn<void, [string, (error?: Error) => void]>(),
    terminate: jest.fn(),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AgentRuntimeGateway large frames', () => {
  function setup() {
    const runtime = deferred<unknown>();
    const history = deferred<unknown[]>();
    const provider = {
      getRuntimeState: jest.fn(() => runtime.promise),
      getHistory: jest.fn(() => history.promise),
    };
    const gateway = new AgentRuntimeGateway(
      { getProvider: () => provider } as any,
      {} as any,
      {} as any,
    );
    const ws = runtimeSocket();
    const hydrate = (includeHistory = true) =>
      (gateway as any).handleMessage(
        'codex',
        7,
        ws,
        JSON.stringify({ type: 'hydrate', includeHistory }),
      );
    const events = () =>
      ws.send.mock.calls.map(([message]) => JSON.parse(message));
    return { gateway, runtime, history, provider, ws, hydrate, events };
  }

  it('delivers a full history larger than 2 MiB to a fast socket', async () => {
    const test = setup();
    test.ws.send.mockImplementation((_data, callback) => callback());
    const content = 'history'.repeat(400_000);
    await test.hydrate();
    test.history.resolve([{ id: 'message', content }]);
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    const history = test
      .events()
      .find((event) => event.type === 'history_snapshot');
    expect(history.payload.history[0].content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    expect(test.ws.terminate).not.toHaveBeenCalled();
    expect(test.ws.listenerCount('close')).toBe(0);
    expect(test.ws.listenerCount('error')).toBe(0);
  });

  it('allows concurrent history, runtime liveItems, large tool results, and deltas until callbacks settle', async () => {
    const test = setup();
    test.ws.send.mockImplementation((data) => {
      test.ws.bufferedAmount += Buffer.byteLength(data);
    });
    const content = 'x'.repeat(2 * 1024 * 1024 + 100);
    (test.gateway as any).clients.set('codex:7', new Set([test.ws]));
    await test.hydrate();
    test.history.resolve([{ id: 'history', content }]);
    test.runtime.resolve({
      sessionId: 7,
      liveItems: [{ id: 'live', content }],
    });
    await new Promise(setImmediate);
    (test.gateway as any).broadcast('codex', 7, {
      type: 'message_start',
      payload: {
        sessionId: 7,
        item: { id: 'tool', kind: 'tool_result', content },
      },
    });
    (test.gateway as any).broadcast('codex', 7, {
      type: 'message_delta',
      payload: { sessionId: 7, delta: 'still streaming' },
    });
    expect(test.events().map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'history_snapshot',
        'runtime_snapshot',
        'message_start',
        'message_delta',
      ]),
    );
    expect(test.ws.send).toHaveBeenCalledTimes(4);
    expect(test.ws.terminate).not.toHaveBeenCalled();
    // Complete out of order to verify each frame releases its own reservation.
    for (const index of [1, 2, 0, 3]) {
      const [data, callback] = test.ws.send.mock.calls[index];
      test.ws.bufferedAmount -= Buffer.byteLength(data);
      callback();
    }
    expect(test.ws.listenerCount('close')).toBe(0);
    expect(test.ws.listenerCount('error')).toBe(0);
  });

  it('keeps slow delta backlog bounded while large hydration frames are pending', async () => {
    const test = setup();
    const content = 'x'.repeat(2 * 1024 * 1024);
    (test.gateway as any).clients.set('codex:7', new Set([test.ws]));
    await test.hydrate();
    test.history.resolve([{ content }]);
    test.runtime.resolve({ sessionId: 7, liveItems: [{ content }] });
    await new Promise(setImmediate);
    const delta = {
      type: 'message_delta',
      payload: { sessionId: 7, delta: 'd'.repeat(64 * 1024) },
    };
    for (let i = 0; i < 1000; i++)
      (test.gateway as any).broadcast('codex', 7, delta);
    expect(test.ws.terminate).toHaveBeenCalledTimes(1);
    const queuedDeltaBytes = test.ws.send.mock.calls
      .filter(([data]) => JSON.parse(data).type === 'message_delta')
      .reduce((sum, [data]) => sum + Buffer.byteLength(data), 0);
    expect(queuedDeltaBytes).toBeGreaterThan(0);
    expect(queuedDeltaBytes).toBeLessThanOrEqual(MAX_WEBSOCKET_BUFFERED_BYTES);
    expect(test.ws.listenerCount('close')).toBe(0);
    expect(test.ws.listenerCount('error')).toBe(0);
  });

  it('reports over-ceiling full history on the existing socket instead of reconnect-looping', async () => {
    const test = setup();
    test.ws.send.mockImplementation((_data, callback) => callback());
    test.history.resolve([{ content: 'x'.repeat(MAX_AGENT_FRAME_BYTES) }]);
    test.runtime.resolve({ sessionId: 7 });
    for (let i = 0; i < 3; i++) {
      await test.hydrate();
      await new Promise(setImmediate);
    }
    expect(test.provider.getHistory).toHaveBeenCalledTimes(3);
    expect(
      test.events().filter((event) => event.type === 'history_snapshot'),
    ).toHaveLength(0);
    const errors = test.events().filter((event) => event.type === 'error');
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      expect(error.payload.sessionId).toBe(7);
      expect(error.payload.message).toContain('32 MiB');
      expect(error.payload.message).toContain('Export conversation');
      expect(error.payload.message).toContain('HTTP history API');
    }
    expect(test.ws.readyState).toBe(WebSocket.OPEN);
    expect(test.ws.terminate).not.toHaveBeenCalled();
    expect(test.ws.listenerCount('close')).toBe(0);
  });
});

it('hydrates history and runtime frames larger than 2 MiB each over a real fast websocket', async () => {
  const content = 'x'.repeat(2 * 1024 * 1024 + 100);
  const provider = {
    getHistory: jest.fn().mockResolvedValue([{ id: 'history', content }]),
    getRuntimeState: jest
      .fn()
      .mockResolvedValue({
        sessionId: 7,
        liveItems: [{ id: 'live', content }],
      }),
  };
  const gateway = new AgentRuntimeGateway(
    { getProvider: () => provider } as never,
    {} as never,
    {} as never,
  );
  const server = createServer();
  gateway.attachToServer(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const client = new WebSocket(
    `ws://127.0.0.1:${port}/agent-runtime?sessionId=7&provider=codex`,
  );
  try {
    await once(client, 'open');
    const messages: { type: string; payload: any }[] = [];
    const received = new Promise<void>((resolve, reject) => {
      client.once('close', () =>
        reject(new Error('Closed before hydration completed')),
      );
      client.once('error', reject);
      client.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length === 2) resolve();
      });
    });
    client.send(JSON.stringify({ type: 'hydrate' }));
    await received;
    expect(
      messages.find((event) => event.type === 'history_snapshot')?.payload
        .history[0].content,
    ).toBe(content);
    expect(
      messages.find((event) => event.type === 'runtime_snapshot')?.payload
        .liveItems[0].content,
    ).toBe(content);
    expect(client.readyState).toBe(WebSocket.OPEN);
    const closed = once(client, 'close');
    client.close(1000);
    await closed;
  } finally {
    client.terminate();
    const wss = (gateway as any).wss as WebSocketServer;
    for (const peer of wss.clients) peer.terminate();
    gateway.onModuleDestroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
