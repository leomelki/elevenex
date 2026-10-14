import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentPortForwardingService } from './agent-port-forwarding.service';
import { PortForwardingOperationsService } from './port-forwarding-operations.service';
import { OnboardingStateService } from './onboarding-state.service';

class FakeSocket {
  static readonly OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
  }
  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('AgentPortForwardingService transport', () => {
  const originalBridge = window.__ELEVENEX_ELECTRON__;
  let service: AgentPortForwardingService;
  let state: OnboardingStateService;
  let execute: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.sockets = [];
    localStorage.clear();
    window.__ELEVENEX_ELECTRON__ = { sshForwarding: {} as never };
    execute = vi.fn().mockResolvedValue({ forwards: [], total: 0, nextOffset: null });
    TestBed.configureTestingModule({
      providers: [
        AgentPortForwardingService,
        OnboardingStateService,
        { provide: PortForwardingOperationsService, useValue: { execute } },
      ],
    });
    state = TestBed.inject(OnboardingStateService);
    state.setMode('local');
    service = TestBed.inject(AgentPortForwardingService);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.__ELEVENEX_ELECTRON__ = originalBridge;
  });
  function start() {
    service.start();
    TestBed.tick();
    return FakeSocket.sockets.at(-1)!;
  }

  it('registers a persistent desktop identity and handles correlated requests', async () => {
    const socket = start();
    socket.onopen?.();
    await Promise.resolve();
    const registration = JSON.parse(socket.send.mock.calls[0][0]);
    expect(registration).toMatchObject({
      type: 'register',
      context: { desktopId: expect.any(String), mode: 'local', defaultConnection: null },
    });
    expect(socket.url).toContain('/desktop-port-forwarding');
    socket.message({ type: 'request', id: 'r1', operation: 'list', args: { projectId: 5 } });
    await Promise.resolve();
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({
      type: 'response',
      id: 'r1',
      data: { forwards: [], total: 0, nextOffset: null },
    });
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    const replacement = FakeSocket.sockets.at(-1)!;
    replacement.onopen?.();
    await Promise.resolve();
    expect(JSON.parse(replacement.send.mock.calls[0][0]).context.desktopId).toBe(
      registration.context.desktopId,
    );
  });
  it('cancels queued requests on disconnect and never replays them', async () => {
    const socket = start();
    execute.mockImplementation(() => new Promise(() => {}));
    socket.message({ type: 'request', id: 'r1', operation: 'create', args: { projectId: 5 } });
    const signal = execute.mock.calls[0][1] as AbortSignal;
    socket.onclose?.();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not open a bridge in a browser-only window', () => {
    window.__ELEVENEX_ELECTRON__ = undefined;
    service.start();
    TestBed.tick();
    expect(FakeSocket.sockets).toEqual([]);
  });
  it('closes the old socket on environment change and ignores its stale requests', () => {
    const oldSocket = start();
    state.setMode('paired');
    TestBed.tick();
    expect(oldSocket.close).toHaveBeenCalled();
    oldSocket.message({ type: 'request', id: 'r1', operation: 'create', args: { projectId: 5 } });
    expect(execute).not.toHaveBeenCalled();
  });
  it('aborts a request when the backend sends cancellation', () => {
    const socket = start();
    execute.mockImplementation(() => new Promise(() => {}));
    socket.message({ type: 'request', id: 'r1', operation: 'start', args: { projectId: 5 } });
    socket.message({ type: 'cancel', id: 'r1' });
    expect((execute.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });
});
