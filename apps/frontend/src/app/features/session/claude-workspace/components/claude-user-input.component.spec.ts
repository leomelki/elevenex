import '@angular/compiler';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudeUserInputRequest } from '@/shared/models/claude-runtime.model';
import { ClaudeUserInputComponent } from './claude-user-input.component';

function codexQuestionRequest(): ClaudeUserInputRequest {
  return {
    requestId: 'codex-question-1',
    serverName: 'Codex',
    mode: 'form',
    title: 'Codex needs your input',
    message: 'Which implementation should Codex use?',
    questions: [
      {
        id: 'implementation',
        header: 'Approach',
        question: 'Which implementation should Codex use?',
        options: [
          { label: 'Minimal', description: 'Touch the smallest surface.' },
          { label: 'Complete', description: 'Cover the full workflow.' },
        ],
      },
    ],
    createdAt: '2026-05-15T16:00:00.000Z',
  };
}

async function render(
  request: ClaudeUserInputRequest,
): Promise<ComponentFixture<ClaudeUserInputComponent>> {
  await TestBed.configureTestingModule({
    imports: [ClaudeUserInputComponent],
  }).compileComponents();

  const fixture = TestBed.createComponent(ClaudeUserInputComponent);
  fixture.componentRef.setInput('request', request);
  fixture.detectChanges();
  return fixture;
}

function text(fixture: ComponentFixture<ClaudeUserInputComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function clickOption(fixture: ComponentFixture<ClaudeUserInputComponent>, label: string): void {
  const option = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('.cw-ask__opt'),
  ).find((node) => (node.textContent ?? '').includes(label));
  if (!option) throw new Error(`Option not found: ${label}`);
  const input = option.querySelector('input');
  if (!input) throw new Error(`Option input not found: ${label}`);
  input.click();
  fixture.detectChanges();
}

function clickButton(fixture: ComponentFixture<ClaudeUserInputComponent>, label: string): void {
  const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
    (node) => (node.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
  fixture.detectChanges();
}

describe('ClaudeUserInputComponent question requests', () => {
  it('renders Codex questions with the shared ask-user flow and submits by question id', async () => {
    const fixture = await render(codexQuestionRequest());
    const answers: unknown[] = [];
    fixture.componentInstance.answer.subscribe((answer) => answers.push(answer));

    expect(text(fixture)).toContain('Question 1 of 1');
    expect(text(fixture)).toContain('Which implementation should Codex use?');
    expect(text(fixture)).toContain('Minimal');

    clickOption(fixture, 'Complete');
    expect(text(fixture)).toContain('Review answers');
    expect(text(fixture)).toContain('Complete');

    clickButton(fixture, 'Submit');

    expect(answers).toEqual([
      {
        action: 'accept',
        content: {
          implementation: 'Complete',
        },
      },
    ]);
  });
});
