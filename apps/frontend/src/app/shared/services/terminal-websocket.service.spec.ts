import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalWebsocketService } from './terminal-websocket.service';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  emitMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  close(): void {
    this.emitClose(1006, 'closed');
  }
}

describe('TerminalWebsocketService', () => {
  const originalWebSocket = globalThis.WebSocket;
  let service: TerminalWebsocketService;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
    service = new TerminalWebsocketService({
      run: <T>(fn: () => T): T => fn(),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  });

  it('reuses an already open socket for the same session', () => {
    service.connect(42);
    expect(MockWebSocket.instances.length).toBe(1);

    MockWebSocket.instances[0].emitOpen();

    service.connect(42);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('reconnects after a post-open disconnect when retries are active', () => {
    service.connect(7);
    service.setRetryActive(7, true);
    MockWebSocket.instances[0].emitOpen();

    MockWebSocket.instances[0].emitClose();
    expect(MockWebSocket.instances.length).toBe(1);

    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('uses the configured reconnect backoff sequence', () => {
    const stateHistory: Array<{ retryAttempt: number; msUntilNextRetry: number | null }> = [];
    const connection = service.connect(8);
    connection.state$.subscribe((state) => {
      stateHistory.push({
        retryAttempt: state.retryAttempt,
        msUntilNextRetry: state.msUntilNextRetry,
      });
    });

    service.setRetryActive(8, true);

    const expectedDelays = [500, 500, 1000, 1000, 2000, 2000, 4000];
    for (const expectedDelay of expectedDelays) {
      MockWebSocket.instances.at(-1)?.emitClose();
      const latest = stateHistory.at(-1);
      expect(latest).toEqual({
        retryAttempt: expect.any(Number),
        msUntilNextRetry: expectedDelay,
      });
      vi.advanceTimersByTime(expectedDelay);
    }

    const retryStates = stateHistory.filter((state, index, history) => {
      if (state.msUntilNextRetry === null) {
        return false;
      }

      const previous = history[index - 1];
      return previous?.retryAttempt !== state.retryAttempt;
    });
    expect(retryStates.map(state => state.msUntilNextRetry)).toEqual(expectedDelays);
  });

  it('does not retry while retries are inactive', () => {
    service.connect(9);
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitClose();

    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('triggers an immediate retry when a disconnected terminal becomes visible', () => {
    const connection = service.connect(10);
    const phases: string[] = [];
    connection.state$.subscribe(state => {
      phases.push(state.phase);
    });

    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitClose();
    expect(MockWebSocket.instances.length).toBe(1);

    service.setRetryActive(10, true);
    expect(MockWebSocket.instances.length).toBe(2);
    expect(phases.at(-1)).toBe('reconnecting');
  });

  it('clears pending timers when retries are disabled', () => {
    const connection = service.connect(11);
    service.setRetryActive(11, true);
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitClose();
    expect(MockWebSocket.instances.length).toBe(1);

    service.setRetryActive(11, false);
    vi.advanceTimersByTime(5000);

    expect(MockWebSocket.instances.length).toBe(1);
    expect(connection.state$).toBeTruthy();
  });
});
