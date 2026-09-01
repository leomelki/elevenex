import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { ClaudeHooksGateway } from './claude-hooks.gateway.js';

class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
  ping = jest.fn();
  terminate = jest.fn();
}

const HEARTBEAT_MS = 25_000;

describe('ClaudeHooksGateway', () => {
  let server: EventEmitter;
  let gateway: ClaudeHooksGateway;

  beforeEach(() => {
    jest.useFakeTimers();

    const hooksService = Object.assign(new EventEmitter(), {
      getAllStatuses: jest.fn(() => ({})),
      getAllActivities: jest.fn(() => ({})),
    });
    const sessionsService = Object.assign(new EventEmitter(), {
      findAllCompletionStates: jest.fn(async () => []),
    });

    server = new EventEmitter();
    gateway = new ClaudeHooksGateway(
      hooksService as never,
      sessionsService as never,
      new EventEmitter() as never,
    );
    gateway.onModuleInit();
    gateway.attachToServer(server as never);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  const connect = (): MockWebSocket => {
    const ws = new MockWebSocket();
    (gateway as unknown as { wss: EventEmitter }).wss.emit('connection', ws);
    return ws;
  };

  const clients = (): Set<MockWebSocket> =>
    (gateway as unknown as { clients: Set<MockWebSocket> }).clients;

  const heartbeatTimer = (): unknown =>
    (gateway as unknown as { heartbeatTimer: unknown }).heartbeatTimer;

  it('heartbeats connected clients so a silent socket is detectable', () => {
    const ws = connect();

    jest.advanceTimersByTime(HEARTBEAT_MS);

    expect(ws.ping).toHaveBeenCalledTimes(1);
    const sent = ws.send.mock.calls.map(
      (call) => (JSON.parse(call[0] as string) as { type: string }).type,
    );
    expect(sent).toContain('heartbeat');
  });

  it('terminates a client that never answers the ping', () => {
    const ws = connect();

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(clients().has(ws)).toBe(false);
  });

  it('keeps a client that answers the ping', () => {
    const ws = connect();

    jest.advanceTimersByTime(HEARTBEAT_MS);
    ws.emit('pong');
    jest.advanceTimersByTime(HEARTBEAT_MS);

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(clients().has(ws)).toBe(true);
  });

  it('stops heartbeating once the last client disconnects', () => {
    const ws = connect();
    expect(heartbeatTimer()).not.toBeNull();

    ws.emit('close');

    expect(clients().size).toBe(0);
    expect(heartbeatTimer()).toBeNull();
  });
});
