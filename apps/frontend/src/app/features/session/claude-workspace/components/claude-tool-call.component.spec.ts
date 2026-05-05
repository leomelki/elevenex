import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeToolCallComponent } from './claude-tool-call.component';

describe('ClaudeToolCallComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders structured ask-user-question answers from interaction metadata', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeToolCallComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeToolCallComponent);
    fixture.componentRef.setInput('call', {
      id: 'tool-1',
      kind: 'tool_use',
      toolUseId: 'tool-1',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [{ question: 'Which approach should we use?' }],
      },
      interaction: {
        kind: 'ask_user_question',
        decision: 'answered',
        decisionLabel: 'Answered',
        decisionTone: 'ok',
        remember: false,
        answers: [{ question: 'Which approach should we use?', answer: 'Option A' }],
        createdAt: '2026-04-24T08:00:00.000Z',
        resolvedAt: '2026-04-24T08:00:05.000Z',
      },
      timestamp: '2026-04-24T08:00:00.000Z',
    });
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cw-tool__head') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Which approach should we use?');
    expect(text).toContain('Option A');
    expect(text).toContain('Answered');
  });

  it('shows the explicit decision for denied permission prompts and keeps request details visible', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeToolCallComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeToolCallComponent);
    fixture.componentRef.setInput('call', {
      id: 'tool-2',
      kind: 'tool_use',
      toolUseId: 'tool-2',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf tmp' },
      interaction: {
        kind: 'permission',
        decision: 'denied',
        decisionLabel: 'Deny',
        decisionTone: 'warn',
        remember: false,
        createdAt: '2026-04-24T08:00:00.000Z',
        resolvedAt: '2026-04-24T08:00:03.000Z',
      },
      timestamp: '2026-04-24T08:00:00.000Z',
    });
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cw-tool__head') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Deny');
    expect(text).toContain('rm -rf tmp');
  });

  it('shows a running timer for live Bash tool calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T08:00:20.000Z'));

    await TestBed.configureTestingModule({
      imports: [ClaudeToolCallComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeToolCallComponent);
    fixture.componentRef.setInput('call', {
      id: 'tool-3',
      kind: 'tool_use',
      toolUseId: 'tool-3',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      timestamp: '2026-04-24T08:00:00.000Z',
      receivedAt: '2026-04-24T08:00:00.000Z',
    });
    fixture.componentRef.setInput('isLive', true);
    fixture.componentRef.setInput('progress', {
      toolUseId: 'tool-3',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedTimeSeconds: 12,
      timestamp: '2026-04-24T08:00:15.000Z',
    });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('Running 17s');

    vi.advanceTimersByTime(3000);
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent ?? '').toContain('Running 20s');
  });
});
