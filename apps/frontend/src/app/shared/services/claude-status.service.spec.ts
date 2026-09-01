import '@angular/compiler';
import { NgZone } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStatusService } from './claude-status.service';
import { ONBOARDING_STORAGE_KEY } from './onboarding-state.service';

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  close(): void {}
}

function writeOnboarding(overrides: { remoteConnectionReady: boolean }): void {
  onboardingStore.set(ONBOARDING_STORAGE_KEY, JSON.stringify({
    mode: 'ssh',
    currentStep: 'project',
    activeServerId: 1,
    remoteConnectionReady: overrides.remoteConnectionReady,
    servers: [{
      id: 1,
      name: 'box',
      sshHost: 'box.local',
      sshPort: 22,
      authMode: 'agent',
      localPort: 45678,
      remotePort: 11111,
      installStatus: 'available',
    }],
  }));
}

const onboardingStore = new Map<string, string>();

describe('ClaudeStatusService', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalLocalStorage = globalThis.localStorage;
  let socket: FakeWebSocket | null = null;

  beforeEach(() => {
    onboardingStore.clear();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (key: string) => onboardingStore.get(key) ?? null,
        setItem: (key: string, value: string) => onboardingStore.set(key, value),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
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

  it('stores worktree context consumption updates from the status websocket', () => {
    globalThis.WebSocket = vi.fn(function (this: unknown, url: string) {
      socket = new FakeWebSocket(url);
      return socket;
    }) as unknown as typeof WebSocket;

    const service = new ClaudeStatusService({
      run: (fn: () => void) => fn(),
    } as NgZone);

    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'session-worktree-context-changed',
        sessionId: 7,
        hasInjectedWorktreeContext: true,
      }),
    });

    expect(service.sessionWorktreeContexts().get(7)).toBe(true);
    service.ngOnDestroy();
  });

  it('hydrates worktree context consumption state from init', () => {
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
        statuses: {},
        activities: {},
        completions: {},
        worktreeContexts: { 7: true, 8: false },
      }),
    });

    expect(service.sessionWorktreeContexts().get(7)).toBe(true);
    expect(service.sessionWorktreeContexts().get(8)).toBe(false);
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
      backgroundActive: false,
    });
    expect(service.getActivity(8)).toEqual({
      activityStatus: 'idle',
      actionKind: null,
      actionLabel: null,
      backgroundActive: false,
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
      backgroundActive: false,
    });
    service.ngOnDestroy();
  });

  it('reports background work alongside the blocked main turn', () => {
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
        status: 'waiting',
        activityStatus: 'waiting',
        actionKind: 'permission',
        actionLabel: 'Permission needed',
        backgroundActive: true,
      }),
    });

    expect(service.getActivity(7)).toEqual({
      activityStatus: 'waiting',
      actionKind: 'permission',
      actionLabel: 'Permission needed',
      backgroundActive: true,
    });
    service.ngOnDestroy();
  });

  it('waits for the remote tunnel before opening the status socket', () => {
    vi.useFakeTimers();
    // Only Electron falls back to this machine's own port; served over http
    // the fallback is the page origin and is safe to use.
    (window as unknown as Record<string, unknown>)['__ELEVENEX_ELECTRON__'] = {};
    const construct = vi.fn(function (this: unknown, url: string) {
      socket = new FakeWebSocket(url);
      return socket;
    });
    globalThis.WebSocket = construct as unknown as typeof WebSocket;
    writeOnboarding({ remoteConnectionReady: false });

    const service = new ClaudeStatusService({
      run: (fn: () => void) => fn(),
    } as NgZone);

    // Connecting now would bind to this machine's own backend instead of the
    // tunnel, and that socket would never close or reconnect.
    expect(construct).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(construct).not.toHaveBeenCalled();

    writeOnboarding({ remoteConnectionReady: true });
    vi.advanceTimersByTime(1000);

    expect(construct).toHaveBeenCalledTimes(1);
    expect(socket?.url).toBe('ws://127.0.0.1:45678/claude-status');
    service.ngOnDestroy();
    delete (window as unknown as Record<string, unknown>)['__ELEVENEX_ELECTRON__'];
    vi.useRealTimers();
  });
});
