import { WebSocket } from 'ws';
import { MAX_WEBSOCKET_BUFFERED_BYTES, sendBounded } from './bounded-send.js';

function client(bufferedAmount = 0) {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    send: jest.fn(),
    terminate: jest.fn(),
    close: jest.fn(),
  };
}

describe('sendBounded', () => {
  it('bounds a growing queue and stops all subsequent output on that client', () => {
    const ws = client();
    ws.send.mockImplementation((data: Buffer) => {
      ws.bufferedAmount += data.length;
    });
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < 1000; i++) sendBounded(ws as never, payload);
    expect(ws.send).toHaveBeenCalledTimes(16);
    expect(ws.bufferedAmount).toBe(MAX_WEBSOCKET_BUFFERED_BYTES);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes of the next message before enqueueing', () => {
    const ws = client(MAX_WEBSOCKET_BUFFERED_BYTES - 1);
    expect(sendBounded(ws as never, 'é')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized first payload without affecting healthy clients', () => {
    const slow = client();
    const healthy = client();
    expect(
      sendBounded(
        slow as never,
        Buffer.alloc(MAX_WEBSOCKET_BUFFERED_BYTES + 1),
      ),
    ).toBe(false);
    expect(sendBounded(healthy as never, 'status')).toBe(true);
    expect(healthy.send).toHaveBeenCalledWith('status', expect.any(Function));
    expect(healthy.terminate).not.toHaveBeenCalled();
  });

  it.each([WebSocket.CONNECTING, WebSocket.CLOSING, WebSocket.CLOSED])(
    'leaves existing close/control semantics alone in state %s',
    (readyState) => {
      const ws = { ...client(), readyState };
      expect(sendBounded(ws as never, 'output')).toBe(false);
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.terminate).not.toHaveBeenCalled();
    },
  );

  it.each(['throw', 'callback'])('disconnects on a send %s failure', (mode) => {
    const ws = client();
    ws.send.mockImplementation((_data, callback) => {
      if (mode === 'throw') throw new Error('closed');
      callback(new Error('closed'));
    });
    sendBounded(ws as never, 'output');
    sendBounded(ws as never, 'more output');
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('does not override a normal close already underway when a send fails', () => {
    const ws = { ...client(), readyState: Number(WebSocket.OPEN) };
    sendBounded(ws as never, 'final output');
    ws.readyState = WebSocket.CLOSING;
    const callback = ws.send.mock.calls[0][1] as (error: Error) => void;
    callback(new Error('socket closed'));
    expect(ws.terminate).not.toHaveBeenCalled();
  });
});
