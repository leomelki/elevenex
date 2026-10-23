import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { MAX_WEBSOCKET_BUFFERED_BYTES } from '../websocket/bounded-send.js';
import { BackendLogsGateway } from './backend-logs.gateway.js';
import type { LogEntry } from './log-interceptor.js';

class Client extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  send = jest.fn();
  close = jest.fn();
  terminate = jest.fn(() => this.emit('close'));
}

it('bounds backend log output per client and preserves normal shutdown close codes', () => {
  const gateway = new BackendLogsGateway();
  gateway.attachToServer(new EventEmitter() as never);
  const { wss, broadcast } = gateway as unknown as {
    wss: EventEmitter;
    broadcast: (entry: LogEntry) => void;
  };
  const slow = new Client();
  const healthy = new Client();
  slow.bufferedAmount = MAX_WEBSOCKET_BUFFERED_BYTES;
  wss.emit('connection', slow);
  wss.emit('connection', healthy);
  for (let i = 0; i < 100; i++) {
    broadcast.call(gateway, {
      level: 'info',
      message: 'log',
      timestamp: new Date().toISOString(),
    });
  }
  expect(slow.send).not.toHaveBeenCalled();
  expect(slow.terminate).toHaveBeenCalledTimes(1);
  expect(healthy.send).toHaveBeenCalledTimes(100);
  gateway.onModuleDestroy();
  expect(healthy.close).toHaveBeenCalledWith(1001, 'Server shutting down');
  expect(healthy.terminate).not.toHaveBeenCalled();
});
