import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendLogsWebsocketService } from './backend-logs-websocket.service';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  emitMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitClose(): void {
    this.onclose?.(new CloseEvent('close'));
  }

  close(): void {
    this.emitClose();
  }
}

describe('BackendLogsWebsocketService', () => {
  const originalWebSocket = globalThis.WebSocket;
  let service: BackendLogsWebsocketService;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    service = new BackendLogsWebsocketService({
      runOutsideAngular: <T>(fn: () => T): T => fn(),
    } as never);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      originalWebSocket;
    debugSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it.each([
    ['debug', 'debug'],
    ['verbose', 'debug'],
    ['trace', 'debug'],
    ['error', 'error'],
    ['fatal', 'error'],
    ['info', 'info'],
    ['log', 'log'],
    ['warn', 'warn'],
  ] as const)('writes backend %s entries with console.%s', (level, method) => {
    service.start();
    MockWebSocket.instances[0].emitMessage(
      JSON.stringify({
        level,
        message: `${level} message`,
        timestamp: '2026-05-06T10:00:00.000Z',
      }),
    );

    expect(debugSpy).toHaveBeenCalledTimes(method === 'debug' ? 1 : 0);
    expect(errorSpy).toHaveBeenCalledTimes(method === 'error' ? 1 : 0);
    expect(infoSpy).toHaveBeenCalledTimes(method === 'info' ? 1 : 0);
    expect(logSpy).toHaveBeenCalledTimes(method === 'log' ? 1 : 0);
    expect(warnSpy).toHaveBeenCalledTimes(method === 'warn' ? 1 : 0);
  });

  it('ignores malformed backend log entries', () => {
    service.start();
    MockWebSocket.instances[0].emitMessage('not json');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to console.log for unknown backend log levels', () => {
    service.start();
    MockWebSocket.instances[0].emitMessage(
      JSON.stringify({
        level: 'notice',
        message: 'notice message',
        timestamp: '2026-05-06T10:00:00.000Z',
      }),
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
