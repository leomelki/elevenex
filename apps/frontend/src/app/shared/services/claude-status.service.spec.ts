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

  it('hydrates rich activity state from init while preserving getStatus', () => {
    globalThis.WebSocket = vi.fn(function (this: unknown, url: string) {
      socket = new FakeWebSocket(url);
      return socket;
    }) as unknown as typeof WebSocket;

    const service = new ClaudeStatusService({
      run: (fn: () => void) => fn(),
    } as NgZone);

    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'init',
        statuses: { 7: 'running', 8: 'idle' },
        activities: {
          7: {
            activityStatus: 'waiting',
            actionKind: 'permission',
            actionLabel: 'Permission needed',
          },
        },
      }),
    });

    expect(service.getStatus(7)).toBe('waiting');
    expect(service.getActivity(7)).toEqual({
      activityStatus: 'waiting',
      actionKind: 'permission',
      actionLabel: 'Permission needed',
    });
    expect(service.getActivity(8)).toEqual({
      activityStatus: 'idle',
      actionKind: null,
      actionLabel: null,
    });
    service.ngOnDestroy();
  });

  it('accepts legacy status-changed messages without activity fields', () => {
    globalThis.WebSocket = vi.fn(function (this: unknown, url: string) {
      socket = new FakeWebSocket(url);
      return socket;
    }) as unknown as typeof WebSocket;

    const service = new ClaudeStatusService({
      run: (fn: () => void) => fn(),
    } as NgZone);

    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'status-changed',
        sessionId: 7,
        status: 'running',
      }),
    });

    expect(service.getStatus(7)).toBe('running');
    expect(service.getActivity(7)).toEqual({
      activityStatus: 'running',
      actionKind: null,
      actionLabel: null,
    });
    service.ngOnDestroy();
  });
});
