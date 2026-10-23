import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import {
  MAX_WEBSOCKET_BUFFERED_BYTES,
  MAX_AGENT_FRAME_BYTES,
  MAX_AGENT_LARGE_IN_FLIGHT_BYTES,
  MAX_AGENT_BUFFERED_BYTES,
  sendAgentFrame,
  sendBounded,
} from './bounded-send.js';

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

class AgentClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  send = jest.fn((data: string, _callback: (error?: Error) => void): void => {
    this.bufferedAmount += Buffer.byteLength(data);
  });
  terminate = jest.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });

  complete(index: number, error?: Error): void {
    const [data, callback] = this.send.mock.calls[index];
    this.bufferedAmount -= Buffer.byteLength(data);
    callback(error);
  }
}

describe('sendAgentFrame', () => {
  it('supports two maximum-sized snapshots plus normal deltas within a finite total', () => {
    const ws = new AgentClient();
    const snapshot = 'x'.repeat(MAX_AGENT_FRAME_BYTES);
    expect(sendAgentFrame(ws as never, snapshot, true)).toBe('sent');
    expect(sendAgentFrame(ws as never, snapshot, true)).toBe('sent');
    expect(
      sendAgentFrame(ws as never, 'd'.repeat(MAX_WEBSOCKET_BUFFERED_BYTES)),
    ).toBe('sent');
    expect(ws.bufferedAmount).toBe(MAX_AGENT_BUFFERED_BYTES);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(sendAgentFrame(ws as never, 'x')).toBe('unavailable');
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(3);
  });

  it('also permits concurrent snapshots smaller than 1 MiB without charging them as deltas', () => {
    const ws = new AgentClient();
    const snapshot = 's'.repeat(768 * 1024);
    sendAgentFrame(ws as never, snapshot, true);
    sendAgentFrame(ws as never, snapshot, true);
    sendAgentFrame(ws as never, 'delta');
    expect(ws.send).toHaveBeenCalledTimes(3);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('keeps the large reservation until callbacks, even when bufferedAmount drops early', () => {
    const ws = new AgentClient();
    const snapshot = 'x'.repeat(MAX_AGENT_FRAME_BYTES);
    sendAgentFrame(ws as never, snapshot, true);
    ws.bufferedAmount = 0;
    sendAgentFrame(ws as never, snapshot, true);
    ws.bufferedAmount = 0;
    expect(MAX_AGENT_LARGE_IN_FLIGHT_BYTES).toBe(2 * MAX_AGENT_FRAME_BYTES);
    expect(sendAgentFrame(ws as never, 'another snapshot', true)).toBe(
      'unavailable',
    );
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('releases only completed reservations and reuses their capacity without leaking listeners', () => {
    const ws = new AgentClient();
    const snapshot = 'x'.repeat(MAX_AGENT_FRAME_BYTES);
    sendAgentFrame(ws as never, snapshot, true);
    sendAgentFrame(ws as never, snapshot, true);
    ws.complete(0);
    expect(sendAgentFrame(ws as never, snapshot, true)).toBe('sent');
    ws.complete(1);
    ws.complete(2);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
    expect(sendAgentFrame(ws as never, snapshot, true)).toBe('sent');
    ws.complete(3);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.listenerCount('close')).toBe(0);
  });

  it('still disconnects a slow delta consumer while a large frame is in flight', () => {
    const ws = new AgentClient();
    sendAgentFrame(ws as never, 's'.repeat(3 * 1024 * 1024), true);
    const delta = 'd'.repeat(64 * 1024);
    for (let i = 0; i < 1000; i++) sendAgentFrame(ws as never, delta);
    expect(ws.send).toHaveBeenCalledTimes(17);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('rejects pre-existing ordinary backlog even for a large snapshot', () => {
    const ws = new AgentClient();
    ws.bufferedAmount = MAX_WEBSOCKET_BUFFERED_BYTES;
    expect(sendAgentFrame(ws as never, 's'.repeat(2 * 1024 * 1024), true)).toBe(
      'unavailable',
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(['callback', 'error event', 'close'])(
    'clears reservations and listeners on %s, ignoring late callbacks',
    (failure) => {
      const ws = new AgentClient();
      const snapshot = 's'.repeat(2 * 1024 * 1024);
      sendAgentFrame(ws as never, snapshot, true);
      sendAgentFrame(ws as never, snapshot, true);
      if (failure === 'callback') ws.complete(0, new Error('failed'));
      else if (failure === 'error event') ws.emit('error', new Error('failed'));
      else {
        ws.readyState = WebSocket.CLOSED;
        ws.emit('close');
      }
      expect(ws.listenerCount('close')).toBe(0);
      expect(ws.listenerCount('error')).toBe(0);
      // ws may settle already-queued sends after the close/error cleanup.
      expect(() =>
        ws.send.mock.calls[1][1](new Error('late failure')),
      ).not.toThrow();
      expect(ws.terminate).toHaveBeenCalledTimes(failure === 'close' ? 0 : 1);
    },
  );

  it('cleans up a synchronous send exception', () => {
    const ws = new AgentClient();
    ws.send.mockImplementationOnce(() => {
      throw new Error('failed');
    });
    expect(sendAgentFrame(ws as never, 's'.repeat(2 * 1024 * 1024), true)).toBe(
      'unavailable',
    );
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('releases allowance without overriding an existing normal close', () => {
    const ws = new AgentClient();
    sendAgentFrame(ws as never, 's'.repeat(2 * 1024 * 1024), true);
    ws.readyState = WebSocket.CLOSING;
    ws.complete(0, new Error('closing'));
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });

  it('rejects a single over-ceiling frame without disconnecting or reserving capacity', () => {
    const ws = new AgentClient();
    // Count encoded bytes, not UTF-16 characters.
    expect(
      sendAgentFrame(
        ws as never,
        'é'.repeat(MAX_AGENT_FRAME_BYTES / 2 + 1),
        true,
      ),
    ).toBe('oversized');
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.listenerCount('close')).toBe(0);
    expect(sendAgentFrame(ws as never, 'small actionable error')).toBe('sent');
    ws.complete(0);
  });
});
