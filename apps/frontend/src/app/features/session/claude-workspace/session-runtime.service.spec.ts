import '@angular/compiler';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EMPTY, Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeEvent,
  AgentRuntimeState,
  AgentTranscriptItem,
} from '@/shared/models/agent-runtime.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeProviderService } from '@/shared/services/agent-runtime-provider.service';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { ClaudeTerminalTranscriptWebsocketService } from '@/shared/services/claude-terminal-transcript-websocket.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { SessionRuntime } from './session-runtime.service';

function fixture() {
  const events = new Subject<AgentRuntimeEvent>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const ws = {
    connect: () => events,
    connectionState$: () => EMPTY,
    isConnected: () => false,
    send: vi.fn(),
    disconnect: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      SessionRuntime,
      { provide: ClaudeRuntimeWebsocketService, useValue: ws },
      { provide: ClaudeTerminalTranscriptWebsocketService, useValue: ws },
      { provide: ClaudeRuntimeApiService, useValue: {} },
      {
        provide: AgentRuntimeApiService,
        useValue: {
          getAuthStatus: () =>
            of({ installed: true, authenticated: true, isAuthenticating: false, output: [] }),
        },
      },
      { provide: AgentRuntimeProviderService, useValue: {} },
      { provide: SessionsService, useValue: {} },
      { provide: ClaudeStatusService, useValue: { onReconnect: signal(0) } },
      {
        provide: AppSettingsService,
        useValue: { load: () => Promise.resolve(), settings: signal({ agentModelPresets: [] }) },
      },
    ],
  });
  const runtime = TestBed.inject(SessionRuntime);
  runtime.bindInputs({
    sessionId: signal(1),
    repoId: signal(1),
    worktreePath: signal('/repo'),
    hasInjectedWorktreeContext: signal(false),
    activeAgentProvider: signal('opencode'),
    hasStartedAgentRuntime: signal(true),
    isVisible: signal(true),
    archived: signal(false),
    readOnlyTranscript: signal(false),
    terminalTranscriptMirror: signal(false),
  });
  runtime.sendRuntimeAction({ type: 'hydrate' });
  const part = (content: string): AgentTranscriptItem => ({
    id: 'p',
    kind: 'assistant',
    content,
    timestamp: new Date(1).toISOString(),
  });
  const send = (event: AgentRuntimeEvent) => events.next(event);
  const next = () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  };
  return { runtime, frames, part, send, next };
}

describe('Session streaming order', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });
  it.each(['message_start', 'runtime_snapshot', 'session_snapshot'])(
    'does not append buffered tokens twice after %s',
    (type) => {
      const f = fixture();
      f.send({ type: 'message_start', payload: { sessionId: 1, item: f.part('') } });
      f.send({ type: 'message_delta', payload: { sessionId: 1, itemId: 'p', delta: 'hello' } });
      if (type === 'message_start')
        f.send({ type, payload: { sessionId: 1, item: f.part('hello') } });
      else {
        const state = {
          sessionId: 1,
          liveItems: [f.part('hello')],
          runPhase: 'running',
          canInterrupt: true,
          history: [],
        } as unknown as AgentRuntimeState;
        f.send({ type, payload: state } as AgentRuntimeEvent);
      }
      f.next();
      expect(f.runtime.liveItems()[0].content).toBe('hello');
    },
  );
  it('batches consecutive text and reasoning deltas into one frame', () => {
    const f = fixture();
    f.send({ type: 'message_start', payload: { sessionId: 1, item: f.part('') } });
    f.send({
      type: 'thinking_start',
      payload: { sessionId: 1, item: { ...f.part(''), id: 'r', kind: 'thinking' } },
    });
    const scheduled = f.frames.size;
    f.send({ type: 'message_delta', payload: { sessionId: 1, itemId: 'p', delta: 'a' } });
    f.send({ type: 'thinking_delta', payload: { sessionId: 1, itemId: 'r', delta: 'thought' } });
    f.send({ type: 'message_delta', payload: { sessionId: 1, itemId: 'p', delta: 'b' } });
    expect(f.frames.size).toBe(scheduled + 1);
    f.next();
    expect(f.runtime.liveItems().find((item) => item.id === 'p')?.content).toBe('ab');
    expect(f.runtime.liveItems().find((item) => item.id === 'r')?.content).toBe('thought');
  });
});
