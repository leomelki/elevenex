import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { MAX_WEBSOCKET_BUFFERED_BYTES } from '../websocket/bounded-send.js';
import { ActionsGateway } from './actions.gateway.js';

class Client extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send = jest.fn();
  close = jest.fn();
  terminate = jest.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
}

describe('ActionsGateway bounded output', () => {
  const pty = {
    registerGateway: jest.fn(),
    isRunning: jest.fn(() => true),
    getCurrentOutput: jest.fn(() => 'replay'),
  };
  let gateway: ActionsGateway;
  let findOne: jest.Mock;
  let connect: (ws: WebSocket, id: number) => Promise<void>;

  beforeEach(() => {
    pty.getCurrentOutput.mockReturnValue('replay');
    findOne = jest.fn().mockResolvedValue({ status: 'stopped' });
    gateway = new ActionsGateway(pty as never, { findOne } as never);
    connect = (
      gateway as unknown as { handleConnection: typeof connect }
    ).handleConnection.bind(gateway);
  });

  afterEach(() => gateway.onModuleDestroy());

  it('replays output and status, then disconnects only the lagging subscriber', async () => {
    const slow = new Client();
    const healthy = new Client();
    await connect(slow as unknown as WebSocket, 1);
    await connect(healthy as unknown as WebSocket, 1);
    expect(slow.send).toHaveBeenNthCalledWith(
      1,
      'replay',
      expect.any(Function),
    );
    expect(slow.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'status', status: 'running' }),
      expect.any(Function),
    );
    slow.bufferedAmount = MAX_WEBSOCKET_BUFFERED_BYTES;
    for (let i = 0; i < 100; i++) {
      gateway.sendToAction(1, Buffer.from('output'));
      gateway.notifyStatus(1, 'stopped');
    }
    expect(slow.send).toHaveBeenCalledTimes(2);
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(healthy.send).toHaveBeenCalledTimes(202);
    expect(healthy.terminate).not.toHaveBeenCalled();
  });

  it('bounds initial replay and cleans up even when it disconnects immediately', async () => {
    pty.getCurrentOutput.mockReturnValue(
      'x'.repeat(MAX_WEBSOCKET_BUFFERED_BYTES + 1),
    );
    const ws = new Client();
    await connect(ws as unknown as WebSocket, 1);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(
      (gateway as unknown as { connections: Map<number, unknown> }).connections
        .size,
    ).toBe(0);
  });

  it('cleans up when a client disconnects while initial action lookup is pending', async () => {
    let resolve!: (value: { status: string }) => void;
    findOne.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const ws = new Client();
    const pending = connect(ws as unknown as WebSocket, 1);
    ws.terminate();
    resolve({ status: 'stopped' });
    await pending;
    expect(ws.send).not.toHaveBeenCalled();
    expect(
      (gateway as unknown as { connections: Map<number, unknown> }).connections
        .size,
    ).toBe(0);
  });
});
