import '@angular/compiler';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeTerminalComponent } from './claude-terminal.component';
import { TerminalConnectionState } from '@/shared/services/terminal-websocket.service';
import {
  TerminalRenderer,
  TerminalRendererService,
} from '@/shared/services/terminal-renderer.service';

const makeState = (patch: Partial<TerminalConnectionState> = {}): TerminalConnectionState => ({
  phase: 'connecting',
  retryAttempt: 0,
  retryActive: false,
  nextRetryAt: null,
  msUntilNextRetry: null,
  ...patch,
});

function setup() {
  const state$ = new BehaviorSubject<TerminalConnectionState>(makeState());
  const session = {
    state$,
    terminalId: 17,
    kind: 'agent',
    terminal: { cols: 80, rows: 24 },
    fitAddon: { fit: vi.fn() },
  } as unknown as TerminalRenderer;
  const renderer = { attach: vi.fn(() => session), release: vi.fn(), setVisible: vi.fn() };
  const component = new ClaudeTerminalComponent(renderer as unknown as TerminalRendererService);
  component.sessionId = 17;
  component.container = { nativeElement: document.createElement('div') };
  (component as unknown as { connectWebSocket: () => void }).connectWebSocket();
  (component as unknown as { socketInitialized: boolean }).socketInitialized = true;
  return { component, renderer, session, state$ };
}

describe('ClaudeTerminalComponent', () => {
  it('tracks retained connection state, including an already connected renderer', () => {
    const { component, state$ } = setup();
    expect(component.connecting()).toBe(true);
    state$.next(makeState({ phase: 'disconnected', retryActive: true, msUntilNextRetry: 500 }));
    expect(component.connecting()).toBe(false);
    expect(component.connected()).toBe(false);
    expect(component.retryLabel()).toBe('0.5s');
    state$.next(makeState({ phase: 'reconnecting', retryActive: true }));
    expect(component.connecting()).toBe(true);
    state$.next(makeState({ phase: 'connected', retryActive: true }));
    expect(component.connected()).toBe(true);
    component.ngOnDestroy();
  });

  it('starts and stops visible-only retries when visibility changes', () => {
    const { component, renderer, session } = setup();
    for (const isVisible of [true, false]) {
      component.isVisible = isVisible;
      component.ngOnChanges({
        isVisible: {
          currentValue: isVisible,
          previousValue: !isVisible,
          firstChange: false,
          isFirstChange: () => false,
        },
      });
    }
    expect(renderer.setVisible).toHaveBeenNthCalledWith(1, session, true);
    expect(renderer.setVisible).toHaveBeenNthCalledWith(2, session, false);
    component.ngOnDestroy();
  });

  it('releases the old renderer before attaching a different session', () => {
    const { component, renderer, session } = setup();
    component.sessionId = 23;
    component.ngOnChanges({
      sessionId: {
        currentValue: 23,
        previousValue: 17,
        firstChange: false,
        isFirstChange: () => false,
      },
    });
    expect(renderer.release).toHaveBeenCalledWith(session);
    expect(renderer.attach).toHaveBeenLastCalledWith(
      'agent',
      23,
      component.container.nativeElement,
      false,
    );
    expect(renderer.release.mock.invocationCallOrder[0]).toBeLessThan(
      renderer.attach.mock.invocationCallOrder[1],
    );
    component.ngOnDestroy();
  });

  it('releases the renderer on destruction and unsubscribes from state updates', () => {
    const { component, renderer, session, state$ } = setup();
    component.ngOnDestroy();
    expect(renderer.release).toHaveBeenCalledWith(session);
    state$.next(makeState({ phase: 'connected' }));
    expect(component.connectionPhase()).toBe('disconnected');
  });
});
