import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeComposerComponent } from './composer/claude-composer.component';
import { ForkedChatComponent } from './forked-chat.component';
import { ClaudeTranscriptComponent } from './transcript/claude-transcript.component';

async function setup() {
  const ws = {
    borrow: vi.fn(() => new Subject().asObservable()),
    send: vi.fn(),
    releaseBorrow: vi.fn(),
  };
  const api = { getAutocompleteItems: vi.fn(() => of([])), getHistory: vi.fn(() => of([])) };
  await TestBed.configureTestingModule({
    imports: [ForkedChatComponent],
    providers: [
      { provide: AgentRuntimeWebsocketService, useValue: ws },
      { provide: AgentRuntimeApiService, useValue: api },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ForkedChatComponent);
  fixture.componentRef.setInput('lens', {
    sanitizeUserContent: (text: string) => text,
    isOwnPrompt: () => true,
  });
  fixture.componentRef.setInput('target', { sessionId: 1, provider: 'codex' });
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, ws };
}

describe('ForkedChatComponent actions', () => {
  it('rolls back the latest repeated prompt without overwriting a new draft', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance;
    const first = component.transcript()!.addOptimisticPrompt('Continue');
    component.transcript()!.addOptimisticPrompt('Continue');
    component.draft.set('My next question');
    component.revertPrompt('Continue');
    expect(component.transcript()!.optimistic()).toEqual([first]);
    expect(component.draft()).toBe('My next question');
  });
  it('sends all queue controls to the active provider', async () => {
    const { fixture, ws } = await setup();
    const composer = fixture.debugElement.query(By.directive(ClaudeComposerComponent))
      .componentInstance as ClaudeComposerComponent;
    composer.cancelPending.emit('p1');
    composer.steerPending.emit('p2');
    composer.resumePending.emit();
    composer.clearPending.emit();
    expect(ws.send.mock.calls.slice(-4)).toEqual([
      [1, { type: 'cancel_pending_prompt', id: 'p1' }, 'codex'],
      [1, { type: 'steer_pending_prompt', id: 'p2' }, 'codex'],
      [1, { type: 'resume_pending_prompts' }, 'codex'],
      [1, { type: 'clear_pending_prompts' }, 'codex'],
    ]);
  });

  it('forwards file navigation and handles transcript copy actions', async () => {
    const { fixture } = await setup();
    const item = { id: 'a', kind: 'assistant' as const, content: 'Copy me', timestamp: '1' };
    fixture.componentInstance.transcript()!.history.set([item]);
    fixture.componentInstance.transcript()!.loading.set(false);
    // The session lens begins at a user prompt.
    fixture.componentInstance
      .transcript()!
      .history.set([{ id: 'u', kind: 'user', content: 'Question', timestamp: '0' }, item]);
    fixture.detectChanges();
    const transcript = fixture.debugElement.query(By.directive(ClaudeTranscriptComponent))
      .componentInstance as ClaudeTranscriptComponent;
    const open = vi.fn();
    fixture.componentInstance.openLocalFile.subscribe(open);
    transcript.openLocalFile.emit({ path: 'a.ts', line: 12 });
    expect(open).toHaveBeenCalledExactlyOnceWith({ path: 'a.ts', line: 12 });
    const writeText = vi.fn(async () => undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      transcript.messageCopy.emit({ item, text: 'Selected text' });
      await fixture.whenStable();
      expect(writeText).toHaveBeenCalledExactlyOnceWith('Selected text');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
