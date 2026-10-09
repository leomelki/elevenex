import '@angular/compiler';
import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalRendererService } from './terminal-renderer.service';
import { UserTerminalConnectionState } from '@/shared/services/user-terminal-websocket.service';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = { cursorBlink: true };
    cols = 80;
    rows = 24;
    parser = { registerOscHandler: vi.fn() };
    loadAddon = vi.fn();
    open = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

describe('TerminalRendererService', () => {
  let service: TerminalRendererService;
  const streams = new Map<number, { data: Subject<string>; open: Subject<void> }>();
  const ws = {
    connect: vi.fn((id: number) => {
      const data = new Subject<string>();
      const open = new Subject<void>();
      streams.set(id, { data, open });
      return {
        onData$: data.asObservable(),
        onOpen$: open.asObservable(),
        state$: new BehaviorSubject<UserTerminalConnectionState>({
          phase: 'connected',
          retryActive: true,
          retryAttempt: 0,
          nextRetryAt: null,
          msUntilNextRetry: null,
        }),
      };
    }),
    setRetryActive: vi.fn(),
    disconnect: vi.fn(),
    resize: vi.fn(),
    send: vi.fn(),
  };
  const container = () => document.createElement('div');

  beforeEach(() => {
    vi.clearAllMocks();
    streams.clear();
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://backend-one' };
    service = new TerminalRendererService(ws as never, ws as never, {} as never, {} as never);
  });

  afterEach(() => {
    service.ngOnDestroy();
    window.__ELEVENEX_RUNTIME__ = undefined;
  });

  it.each(['user', 'agent'] as const)(
    '%s: reuses the exact renderer and socket on repeated reopening',
    (kind) => {
      const first = service.attach(kind, 1, container());
      for (let i = 0; i < 5; i++) {
        service.release(first);
        const nextContainer = container();
        expect(service.attach(kind, 1, nextContainer)).toBe(first);
        expect(nextContainer.firstChild).toBe(first.element);
      }
      expect(ws.connect).toHaveBeenCalledTimes(1);
      expect(ws.disconnect).not.toHaveBeenCalled();
      expect(first.terminal.dispose).not.toHaveBeenCalled();
    },
  );

  it('continues writing hidden output into the retained renderer', () => {
    const session = service.attach('user', 1, container());
    service.release(session);
    streams.get(1)?.data.next('output while closed');
    expect(session.terminal.write).toHaveBeenCalledWith('output while closed');
    expect(ws.setRetryActive).toHaveBeenLastCalledWith(1, false);
    expect(session.terminal.options.cursorBlink).toBe(false);
    service.attach('user', 1, container());
    expect(ws.setRetryActive).toHaveBeenLastCalledWith(1, true);
    expect(session.terminal.options.cursorBlink).toBe(true);
  });

  it('evicts the least recently used idle terminal while retaining active ones', () => {
    const active = service.attach('user', 99, container());
    const sessions = Array.from({ length: 9 }, (_, i) =>
      service.attach('user', i + 1, container()),
    );
    for (const session of sessions.slice(0, 8)) service.release(session);
    service.attach('user', 1, container());
    service.release(sessions[0]);
    service.release(sessions[8]);
    expect(ws.disconnect).toHaveBeenCalledExactlyOnceWith(2);
    expect(sessions[1].terminal.dispose).toHaveBeenCalledTimes(1);
    expect(active.terminal.dispose).not.toHaveBeenCalled();
    expect(service.attach('user', 1, container())).toBe(sessions[0]);
  });

  it('keeps shell and agent terminals with the same numeric id separate', () => {
    const user = service.attach('user', 1, container());
    const agent = service.attach('agent', 1, container());
    expect(user).not.toBe(agent);
    service.remove('user', 1);
    expect(agent.terminal.dispose).not.toHaveBeenCalled();
    expect(service.attach('agent', 1, container())).toBe(agent);
  });

  it('closes deleted terminals and removes their output subscriptions', () => {
    const session = service.attach('user', 1, container());
    const data = streams.get(1)!.data;
    service.remove('user', 1);
    data.next('after deletion');
    service.release(session);
    expect(session.terminal.write).not.toHaveBeenCalled();
    expect(session.terminal.dispose).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledExactlyOnceWith(1);
    expect(data.observed).toBe(false);
  });

  it('discards cached sessions when switching backends with overlapping terminal ids', () => {
    const previous = service.attach('user', 1, container());
    service.release(previous);
    window.__ELEVENEX_RUNTIME__ = { backendOrigin: 'http://backend-two' };
    const next = service.attach('user', 1, container());
    expect(next).not.toBe(previous);
    expect(previous.terminal.dispose).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledWith(1);
    // A late component destroy from the old backend cannot release the new view.
    service.release(previous);
    expect(next.attached).toBe(true);
    ws.setRetryActive.mockClear();
    service.setVisible(previous, false);
    expect(ws.setRetryActive).not.toHaveBeenCalled();
  });
});
