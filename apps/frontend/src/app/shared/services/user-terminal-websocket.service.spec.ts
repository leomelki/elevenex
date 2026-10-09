import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserTerminalWebsocketService } from './user-terminal-websocket.service';

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

describe('UserTerminalWebsocketService', () => {
  let service: UserTerminalWebsocketService;
  const zone = {
    run: vi.fn(<T>(fn: () => T): T => fn()),
    runOutsideAngular: vi.fn(<T>(fn: () => T): T => fn()),
  };

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.clearAllMocks();
    service = new UserTerminalWebsocketService(zone as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares connecting and open sockets across attaches', () => {
    service.connect(42);
    service.connect(42);
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].emitOpen();
    const phases: string[] = [];
    service.connect(42).state$.subscribe((state) => phases.push(state.phase));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(phases).toEqual(['connected']);
  });

  it('receives output on a retained socket while hidden without Angular updates', () => {
    const data = vi.fn();
    service.connect(1).onData$.subscribe(data);
    MockWebSocket.instances[0].emitOpen();
    service.setRetryActive(1, false);
    zone.run.mockClear();
    zone.runOutsideAngular.mockClear();
    MockWebSocket.instances[0].emitMessage('background output');
    expect(data).toHaveBeenCalledWith('background output');
    expect(zone.run).not.toHaveBeenCalled();
    expect(zone.runOutsideAngular).toHaveBeenCalledTimes(1);
  });

  it('retries immediately when a hidden disconnected terminal is reopened', () => {
    service.connect(1);
    MockWebSocket.instances[0].emitOpen();
    service.setRetryActive(1, false);
    MockWebSocket.instances[0].emitClose();
    vi.advanceTimersByTime(10000);
    expect(MockWebSocket.instances).toHaveLength(1);
    service.setRetryActive(1, true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('does not wait for backoff when connect is requested again', () => {
    service.connect(1);
    MockWebSocket.instances[0].emitClose();
    service.connect(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it.each([false, true])('waits until reopen to restart an exited shell (hidden=%s)', (hidden) => {
    const phases: string[] = [];
    service.connect(1).state$.subscribe((state) => phases.push(state.phase));
    MockWebSocket.instances[0].emitOpen();
    if (hidden) service.setRetryActive(1, false);
    MockWebSocket.instances[0].emitClose(4000, 'Terminal process exited');
    vi.advanceTimersByTime(20000);

    expect(service.isConnected(1)).toBe(false);
    expect(phases.at(-1)).toBe('disconnected');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    service.setRetryActive(1, false);
    service.setRetryActive(1, true);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].emitOpen();
    expect(service.isConnected(1)).toBe(true);
  });

  it('restarts on reopen even if the exited socket has not finished closing', () => {
    service.connect(1);
    const exited = MockWebSocket.instances[0];
    exited.emitOpen();
    exited.readyState = MockWebSocket.CLOSING;
    service.setRetryActive(1, false);
    service.setRetryActive(1, true);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].emitOpen();
    exited.emitClose(4000, 'Terminal process exited');
    expect(service.isConnected(1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled handshake on every reconnect attempt', () => {
    service.connect(1);
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitClose();
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(8000);
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.CLOSED);
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(3);
    MockWebSocket.instances[2].emitOpen();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late events from replaced sockets', () => {
    const data = vi.fn();
    const phases: string[] = [];
    const connection = service.connect(1);
    connection.onData$.subscribe(data);
    connection.state$.subscribe((state) => phases.push(state.phase));
    const old = MockWebSocket.instances[0];
    old.emitClose();
    vi.advanceTimersByTime(500);
    MockWebSocket.instances[1].emitOpen();
    old.emitOpen();
    old.emitMessage('stale output');
    old.emitClose();
    expect(phases.at(-1)).toBe('connected');
    expect(data).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the socket and all timers on explicit deletion', () => {
    service.connect(1);
    MockWebSocket.instances[0].emitClose();
    service.disconnect(1);
    vi.advanceTimersByTime(20000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(service.isConnected(1)).toBe(false);
  });
});
