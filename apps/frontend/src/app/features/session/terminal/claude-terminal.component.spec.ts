import '@angular/compiler';
import { BehaviorSubject, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeTerminalComponent } from './claude-terminal.component';
import {
  TerminalConnectionState,
  TerminalWebsocketService,
} from '../../../shared/services/terminal-websocket.service';
import { TabService } from '../tab-service';
import { Router } from '@angular/router';

describe('ClaudeTerminalComponent', () => {
  const makeState = (
    patch: Partial<TerminalConnectionState> = {},
  ): TerminalConnectionState => ({
    phase: 'connecting',
    retryAttempt: 0,
    retryActive: false,
    nextRetryAt: null,
    msUntilNextRetry: null,
    ...patch,
  });

  it('tracks connection state from the websocket service', () => {
    const onData$ = new Subject<string>();
    const onOpen$ = new Subject<void>();
    const onClose$ = new Subject<CloseEvent>();
    const onError$ = new Subject<Event>();
    const state$ = new BehaviorSubject<TerminalConnectionState>(makeState());

    const wsService = {
      connect: vi.fn().mockReturnValue({
        onData$: onData$.asObservable(),
        onOpen$: onOpen$.asObservable(),
        onClose$: onClose$.asObservable(),
        onError$: onError$.asObservable(),
        state$: state$.asObservable(),
      }),
      setRetryActive: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalWebsocketService;

    const tabService = {
      selectPreviousTab: vi.fn(),
      selectNextTab: vi.fn(),
    } as unknown as TabService;

    const router = {
      navigate: vi.fn(),
    } as unknown as Router;

    const component = new ClaudeTerminalComponent(wsService, tabService, router);
    component.sessionId = 17;
    (component as unknown as { terminal?: { cols: number; rows: number } }).terminal = { cols: 80, rows: 24 };

    (component as unknown as { connectWebSocket: () => void }).connectWebSocket();
    expect(component.connecting()).toBe(true);

    state$.next(makeState({
      phase: 'disconnected',
      retryActive: true,
      msUntilNextRetry: 500,
    }));
    expect(component.connecting()).toBe(false);
    expect(component.connected()).toBe(false);
    expect(component.retryLabel()).toBe('0.5s');

    state$.next(makeState({ phase: 'reconnecting', retryActive: true }));
    expect(component.connecting()).toBe(true);

    onOpen$.next();
    state$.next(makeState({ phase: 'connected', retryActive: true }));
    expect(component.connected()).toBe(true);
  });

  it('starts and stops visible-only retries when visibility changes', () => {
    const state$ = new BehaviorSubject<TerminalConnectionState>(makeState({
      phase: 'disconnected',
    }));

    const wsService = {
      connect: vi.fn().mockReturnValue({
        onData$: new Subject<string>().asObservable(),
        onOpen$: new Subject<void>().asObservable(),
        onClose$: new Subject<CloseEvent>().asObservable(),
        onError$: new Subject<Event>().asObservable(),
        state$: state$.asObservable(),
      }),
      setRetryActive: vi.fn(),
      disconnect: vi.fn(),
      send: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalWebsocketService;

    const component = new ClaudeTerminalComponent(
      wsService,
      { selectPreviousTab: vi.fn(), selectNextTab: vi.fn() } as unknown as TabService,
      { navigate: vi.fn() } as unknown as Router,
    );

    component.sessionId = 23;
    component.isVisible = true;
    (component as unknown as { connectWebSocket: () => void }).connectWebSocket();
    (component as unknown as { socketInitialized: boolean }).socketInitialized = true;
    component.ngOnChanges({
      isVisible: {
        currentValue: true,
        previousValue: false,
        firstChange: false,
        isFirstChange: () => false,
      },
    });

    component.isVisible = false;
    component.ngOnChanges({
      isVisible: {
        currentValue: false,
        previousValue: true,
        firstChange: false,
        isFirstChange: () => false,
      },
    });

    expect(wsService.setRetryActive).toHaveBeenNthCalledWith(1, 23, true);
    expect(wsService.setRetryActive).toHaveBeenNthCalledWith(2, 23, false);
  });
});
