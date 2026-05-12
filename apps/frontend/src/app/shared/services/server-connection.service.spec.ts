import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerConnectionService } from './server-connection.service';

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

  emitMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) {
      return;
    }
    this.emitClose();
  }
}

describe('ServerConnectionService', () => {
  const originalWebSocket = globalThis.WebSocket;
  let service: ServerConnectionService;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
    service = new ServerConnectionService({
      run: <T>(fn: () => T): T => fn(),
    } as never);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  });

  it('shows no overlay after a normal initial connection', () => {
    service.start();
    expect(MockWebSocket.instances.length).toBe(1);

    MockWebSocket.instances[0].emitOpen();
    expect(service.state().phase).toBe('connecting');
    expect(service.isInteractive()).toBe(false);

    MockWebSocket.instances[0].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:00.000Z',
    }));

    expect(service.state().phase).toBe('connected');
    expect(service.showOverlay()).toBe(false);
    expect(service.isInteractive()).toBe(true);
  });

  it('enters disconnected state on close and reconnects with backoff', () => {
    service.start();
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:00.000Z',
    }));

    MockWebSocket.instances[0].emitClose();

    expect(service.state().phase).toBe('disconnected');
    expect(service.showOverlay()).toBe(true);
    expect(service.isInteractive()).toBe(false);
    expect(MockWebSocket.instances.length).toBe(1);

    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it('requires a server message before marking a reconnection restored', () => {
    service.start();
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:00.000Z',
    }));
    MockWebSocket.instances[0].emitClose();
    vi.advanceTimersByTime(500);

    MockWebSocket.instances[1].emitOpen();

    expect(service.state().phase).toBe('disconnected');
    expect(service.isInteractive()).toBe(false);

    MockWebSocket.instances[1].emitMessage(JSON.stringify({
      type: 'heartbeat',
      serverTime: '2026-05-12T08:00:05.000Z',
    }));

    expect(service.state().phase).toBe('restored');
    expect(service.showOverlay()).toBe(true);
    expect(service.isInteractive()).toBe(false);
  });

  it('resolves waiters only after the restored grace period completes', async () => {
    service.start();
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:00.000Z',
    }));
    MockWebSocket.instances[0].emitClose();

    const resolved = vi.fn();
    void service.waitUntilInteractive().then(resolved);
    vi.advanceTimersByTime(500);
    MockWebSocket.instances[1].emitOpen();
    MockWebSocket.instances[1].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:05.000Z',
    }));

    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(service.state().phase).toBe('restored');

    vi.advanceTimersByTime(1499);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(service.state().phase).toBe('connected');
    expect(service.showOverlay()).toBe(false);
    expect(service.isInteractive()).toBe(true);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it('treats missed heartbeats as a disconnect', () => {
    service.start();
    MockWebSocket.instances[0].emitOpen();
    MockWebSocket.instances[0].emitMessage(JSON.stringify({
      type: 'ready',
      serverTime: '2026-05-12T08:00:00.000Z',
    }));

    vi.advanceTimersByTime(12000);

    expect(service.state().phase).toBe('disconnected');
    expect(service.showOverlay()).toBe(true);
  });
});
