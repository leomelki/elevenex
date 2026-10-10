import { WebSocket } from 'ws';
import { AgentRuntimeGateway } from './agent-runtime.gateway.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    const ws = { readyState: WebSocket.OPEN as number, send: jest.fn() };
    const hydrate = () =>
      (gateway as any).handleMessage('codex', 7, ws, '{"type":"hydrate"}');
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
});
