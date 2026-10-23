import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { AgentRuntimeGateway } from './agent-runtime.gateway.js';
import { MAX_WEBSOCKET_BUFFERED_BYTES } from '../websocket/bounded-send.js';

function mockSocket(bufferedAmount = 0) {
  return Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount,
    send: jest.fn((_data: string, callback?: (error?: Error) => void) =>
      callback?.(),
    ),
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

describe('AgentRuntimeGateway client ownership', () => {
  it.each(['pi', 'opencode'])(
    'balances %s multi-tab attachment and duplicate disconnects',
    (providerId) => {
      let count = 0;
      const provider = {
        onClientAttached: jest.fn(() => count++),
        onClientDetached: jest.fn(() => count--),
      };
      const gateway = new AgentRuntimeGateway(
        { getProvider: () => provider } as any,
        {} as any,
        {} as any,
      );
      gateway.attachToServer(new EventEmitter() as any);
      const connect = () => {
        const ws = Object.assign(new EventEmitter(), {
          close: jest.fn(() => ws.emit('close')),
        });
        (gateway as any).wss.emit('connection', ws, {
          url: `/agent-runtime?provider=${providerId}&sessionId=7`,
          headers: { host: 'localhost' },
        });
        return ws;
      };
      const first = connect();
      const second = connect();
      expect(count).toBe(2);
      first.emit('error', new Error('Disconnected'));
      first.emit('close');
      expect(count).toBe(1);
      second.emit('close');
      expect(count).toBe(0);
      expect(provider.onClientAttached).toHaveBeenCalledTimes(2);
      expect(provider.onClientDetached).toHaveBeenCalledTimes(2);

      connect();
      connect();
      gateway.onModuleDestroy();
      expect(count).toBe(0);
      expect(provider.onClientDetached).toHaveBeenCalledTimes(4);
    },
  );
});

describe('AgentRuntimeGateway hydration', () => {
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
    const ws = mockSocket();
    const hydrate = (includeHistory = true) =>
      (gateway as any).handleMessage(
        'codex',
        7,
        ws,
        JSON.stringify({ type: 'hydrate', includeHistory }),
      );
    const events = () =>
      ws.send.mock.calls.map(([message]) => JSON.parse(message));
    return { runtime, history, provider, ws, hydrate, events };
  }

  it('delivers history while runtime initialization is still pending', async () => {
    const test = setup();
    await test.hydrate();
    expect(test.provider.getHistory).toHaveBeenCalledWith(7);
    test.history.resolve([{ id: 'message' }]);
    await new Promise(setImmediate);
    expect(test.events()).toEqual([
      {
        type: 'history_snapshot',
        payload: { sessionId: 7, history: [{ id: 'message' }] },
      },
    ]);
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    expect(test.events()[1].type).toBe('runtime_snapshot');
  });

  it('skips socket history when HTTP owns the initial transcript load', async () => {
    const test = setup();
    await test.hydrate(false);
    expect(test.provider.getHistory).not.toHaveBeenCalled();
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    expect(test.events()).toEqual([
      { type: 'runtime_snapshot', payload: { sessionId: 7 } },
    ]);
  });

  it('allows history fallback while runtime-only hydration is still pending', async () => {
    const test = setup();
    await test.hydrate(false);
    await test.hydrate();
    expect(test.provider.getHistory).toHaveBeenCalledTimes(1);
    test.history.resolve([]);
    await new Promise(setImmediate);
    expect(test.events()).toContainEqual({
      type: 'history_snapshot',
      payload: { sessionId: 7, history: [] },
    });
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
  });

  it('coalesces repeated hydrates and permits a fresh hydrate after completion', async () => {
    const test = setup();
    await Promise.all([test.hydrate(), test.hydrate()]);
    expect(test.provider.getHistory).toHaveBeenCalledTimes(1);
    expect(test.provider.getRuntimeState).toHaveBeenCalledTimes(1);
    test.history.resolve([]);
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    await test.hydrate();
    await new Promise(setImmediate);
    expect(test.provider.getHistory).toHaveBeenCalledTimes(2);
  });

  it('still delivers history when runtime initialization fails', async () => {
    const test = setup();
    await test.hydrate();
    test.runtime.reject(new Error('Provider unavailable'));
    test.history.resolve([]);
    await new Promise(setImmediate);
    expect(test.events()).toEqual(
      expect.arrayContaining([
        {
          type: 'error',
          payload: { sessionId: 7, message: 'Provider unavailable' },
        },
        { type: 'history_snapshot', payload: { sessionId: 7, history: [] } },
      ]),
    );
  });

  it('does not send late snapshots to a closed socket', async () => {
    const test = setup();
    await test.hydrate();
    test.ws.readyState = WebSocket.CLOSED;
    test.history.resolve([]);
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    expect(test.ws.send).not.toHaveBeenCalled();
  });

  it('disconnects a saturated runtime socket and skips subsequent hydration output', async () => {
    const test = setup();
    test.ws.bufferedAmount = MAX_WEBSOCKET_BUFFERED_BYTES;
    await test.hydrate();
    test.runtime.resolve({ sessionId: 7 });
    await new Promise(setImmediate);
    expect(test.ws.terminate).toHaveBeenCalledTimes(1);
    expect(test.ws.send).not.toHaveBeenCalled();
    test.history.resolve([{ id: 'message' }]);
    await new Promise(setImmediate);
    expect(test.ws.terminate).toHaveBeenCalledTimes(1);
    expect(test.ws.send).not.toHaveBeenCalled();
  });
});

it('sends worker logs only to subscribed clients and avoids serializing unobserved output', async () => {
  const provider = {};
  const gateway = new AgentRuntimeGateway(
    { getProvider: () => provider } as any,
    {} as any,
    {} as any,
  );
  const watched = mockSocket();
  const other = mockSocket();
  (gateway as any).clients.set('claude:7', new Set([watched, other]));
  let serializations = 0;
  const item = {
    agentId: 'worker',
    get content() {
      serializations++;
      return 'Worker output';
    },
  };
  const event = { type: 'message_start', payload: { sessionId: 7, item } };
  (gateway as any).broadcast('claude', 7, event);
  expect(serializations).toBe(0);
  await (gateway as any).handleMessage(
    'claude',
    7,
    watched,
    JSON.stringify({ type: 'watch_subagent', agentId: 'worker' }),
  );
  (gateway as any).broadcast('claude', 7, event);
  expect(serializations).toBe(1);
  expect(watched.send).toHaveBeenCalledTimes(1);
  expect(other.send).not.toHaveBeenCalled();
});

it.each(['session', 'provider'])(
  'bounds runtime %s broadcasts without delaying healthy subscribers',
  (scope) => {
    const gateway = new AgentRuntimeGateway(
      {} as never,
      {} as never,
      {} as never,
    );
    const slow = mockSocket(MAX_WEBSOCKET_BUFFERED_BYTES);
    const healthy = mockSocket();
    const otherProvider = mockSocket();
    (gateway as any).clients.set('codex:7', new Set([slow, healthy]));
    (gateway as any).clients.set('claude:7', new Set([otherProvider]));
    const event = {
      type: 'message_delta',
      payload: { sessionId: 7, delta: 'token' },
    };
    for (let i = 0; i < 1000; i++) {
      if (scope === 'session') (gateway as any).broadcast('codex', 7, event);
      else (gateway as any).broadcastToProvider('codex', event);
    }
    expect(slow.send).not.toHaveBeenCalled();
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(healthy.send).toHaveBeenCalledTimes(1000);
    expect(healthy.terminate).not.toHaveBeenCalled();
    expect(otherProvider.send).not.toHaveBeenCalled();
  },
);

it.each(['invalid JSON', 'provider error'])(
  'bounds runtime error output for %s',
  async (failure) => {
    const gateway = new AgentRuntimeGateway(
      {
        getProvider: () => ({
          interrupt: jest.fn().mockRejectedValue(new Error('failed')),
        }),
      } as never,
      { findOne: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
    );
    const ws = mockSocket(MAX_WEBSOCKET_BUFFERED_BYTES);
    for (let i = 0; i < 10; i++) {
      await (gateway as any).handleMessage(
        'codex',
        7,
        ws,
        failure === 'invalid JSON'
          ? '{'
          : JSON.stringify({ type: 'interrupt' }),
      );
    }
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  },
);
