import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeToolCallComponent } from './claude-tool-call.component';

describe('ClaudeToolCallComponent', () => {
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

  it('renders nested subagent permission prompts inline', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeToolCallComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeToolCallComponent);
    fixture.componentRef.setInput('call', {
      id: 'tool-agent',
      kind: 'tool_use',
      toolUseId: 'tool-agent',
      toolName: 'Task',
      toolInput: { description: 'Inspect files' },
      timestamp: '2026-04-24T08:00:00.000Z',
    });
    fixture.componentRef.setInput('childItems', [
      {
        id: 'child-bash',
        kind: 'tool_use',
        toolUseId: 'child-bash',
        parentToolUseId: 'tool-agent',
        toolName: 'Bash',
        toolInput: { command: 'cat /outside-boundary/file.txt' },
        timestamp: '2026-04-24T08:00:01.000Z',
      },
    ]);
    fixture.componentRef.setInput('permission', {
      requestId: 'req-1',
      toolUseId: 'child-bash',
      toolName: 'Bash',
      input: { command: 'cat /outside-boundary/file.txt' },
      blockedPath: '/outside-boundary/file.txt',
      createdAt: '2026-04-24T08:00:02.000Z',
    });
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.cw-tool__head') as HTMLButtonElement;
    button.click();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Needs your approval');
    expect(text).toContain('/outside-boundary/file.txt');
  });
});
