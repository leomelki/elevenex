import '@angular/compiler';
import { NgZone } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStatusService } from './claude-status.service';

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  close(): void {}
}

describe('ClaudeStatusService', () => {
  const originalWebSocket = globalThis.WebSocket;
  let socket: FakeWebSocket | null = null;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    socket = null;
  });

  it('stores generated session title updates from the status websocket', () => {
    globalThis.WebSocket = vi.fn(function (this: unknown, url: string) {
      socket = new FakeWebSocket(url);
      return socket;
    }) as unknown as typeof WebSocket;

    const service = new ClaudeStatusService({
      run: (fn: () => void) => fn(),
    } as NgZone);

    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'session-title-changed',
        sessionId: 7,
        name: 'Implement Auto Names',
      }),
    });

    expect(service.sessionTitles().get(7)).toBe('Implement Auto Names');
    service.ngOnDestroy();
  });
});
