import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { ServerConnectionGateway } from './server-connection.gateway.js';

class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = jest.fn();
  close = jest.fn();
}

describe('ServerConnectionGateway', () => {
  let server: EventEmitter;
  let gateway: ServerConnectionGateway;

  beforeEach(() => {
    jest.useFakeTimers();
    server = new EventEmitter();
    gateway = new ServerConnectionGateway();
    gateway.attachToServer(server as never);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it('accepts /server-connection and sends an initial ready payload', () => {
    const ws = new MockWebSocket();
    const wss = (gateway as unknown as {
      wss: {
        handleUpgrade: jest.Mock;
      };
    }).wss;
    wss.handleUpgrade = jest.fn((_request, _socket, _head, callback) => {
      callback(ws);
    });

    server.emit('upgrade', {
      url: '/server-connection',
      headers: { host: 'localhost' },
    } as IncomingMessage, {}, Buffer.alloc(0));

    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
    const message = JSON.parse(ws.send.mock.calls[0][0]) as { type: string; serverTime: string };
    expect(message.type).toBe('ready');
    expect(Number.isNaN(Date.parse(message.serverTime))).toBe(false);
  });

  it('does not accept unrelated websocket paths', () => {
    const wss = (gateway as unknown as {
      wss: {
        handleUpgrade: jest.Mock;
      };
    }).wss;
    wss.handleUpgrade = jest.fn();

    server.emit('upgrade', {
      url: '/other',
      headers: { host: 'localhost' },
    } as IncomingMessage, {}, Buffer.alloc(0));

    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('sends heartbeats and cleans up clients on close', () => {
    const ws = new MockWebSocket();
    const wss = (gateway as unknown as {
      wss: EventEmitter;
      clients: Set<MockWebSocket>;
    }).wss;
    wss.emit('connection', ws);

    expect((gateway as unknown as { clients: Set<MockWebSocket> }).clients.size).toBe(1);

    jest.advanceTimersByTime(5000);
    expect(ws.send).toHaveBeenCalledTimes(2);
    const heartbeat = JSON.parse(ws.send.mock.calls[1][0]) as { type: string };
    expect(heartbeat.type).toBe('heartbeat');

    ws.emit('close');
    expect((gateway as unknown as { clients: Set<MockWebSocket> }).clients.size).toBe(0);
  });
});
