import '@angular/compiler';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ClaudePermissionRequest } from '@/shared/models/claude-runtime.model';
import { ClaudePermissionInlineComponent } from './claude-permission-inline.component';

function askRequest(
  requestId = 'perm-ask-1',
  questions: unknown[] = [
    {
      question: 'Which approach should we use?',
      options: [
        { label: 'Option A', description: 'Use the first path.' },
        { label: 'Option B', description: 'Use the second path.' },
      ],
    },
    {
      question: 'How much detail should the answer include?',
      options: [
        { label: 'Brief', description: 'Keep it short.' },
        { label: 'Detailed', description: 'Include more context.' },
      ],
    },
  ],
): ClaudePermissionRequest {
  return {
    requestId,
    toolUseId: 'tool-ask-1',
    toolName: 'AskUserQuestion',
    input: { questions },
    createdAt: '2026-04-24T08:00:00.000Z',
  };
}

async function render(
  request: ClaudePermissionRequest = askRequest(),
): Promise<ComponentFixture<ClaudePermissionInlineComponent>> {
  await TestBed.configureTestingModule({
    imports: [ClaudePermissionInlineComponent],
  }).compileComponents();

  const fixture = TestBed.createComponent(ClaudePermissionInlineComponent);
  fixture.componentRef.setInput('request', request);
  fixture.detectChanges();
  return fixture;
}

function text(fixture: ComponentFixture<ClaudePermissionInlineComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function clickOption(
  fixture: ComponentFixture<ClaudePermissionInlineComponent>,
  label: string,
): void {
  const option = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('.cw-ask__opt'),
  ).find((node) => (node.textContent ?? '').includes(label));
  if (!option) throw new Error(`Option not found: ${label}`);
  const input = option.querySelector('input');
  if (!input) throw new Error(`Option input not found: ${label}`);
  input.click();
  fixture.detectChanges();
}

function clickButton(
  fixture: ComponentFixture<ClaudePermissionInlineComponent>,
  label: string,
): void {
  const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
    (node) => (node.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
  fixture.detectChanges();
}

function checkedOption(
  fixture: ComponentFixture<ClaudePermissionInlineComponent>,
  label: string,
): boolean {
  const option = Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll('.cw-ask__opt'),
  ).find((node) => (node.textContent ?? '').includes(label));
  const input = option?.querySelector('input');
  return input instanceof HTMLInputElement ? input.checked : false;
}

function setOtherAnswer(
  fixture: ComponentFixture<ClaudePermissionInlineComponent>,
  value: string,
): void {
  const textarea = (fixture.nativeElement as HTMLElement).querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement))
    throw new Error('Other answer textarea not found');
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('ClaudePermissionInlineComponent ask-user wizard', () => {
  it('shows only the first question initially', async () => {
    const fixture = await render();

    expect(text(fixture)).toContain('Question 1 of 2');
    expect(text(fixture)).toContain('Which approach should we use?');
    expect(text(fixture)).not.toContain('How much detail should the answer include?');
    expect(text(fixture)).not.toContain('Submit');
  });

  it('auto-advances after a single-choice answer', async () => {
    const fixture = await render();

    clickOption(fixture, 'Option A');

    expect(text(fixture)).toContain('Question 2 of 2');
    expect(text(fixture)).toContain('How much detail should the answer include?');
    expect(text(fixture)).not.toContain('Which approach should we use?');
  });

  it('goes back to the previous question with the answer preserved', async () => {
    const fixture = await render();

    clickOption(fixture, 'Option A');
    clickButton(fixture, 'Back');

    expect(text(fixture)).toContain('Question 1 of 2');
    expect(text(fixture)).toContain('Which approach should we use?');
    expect(checkedOption(fixture, 'Option A')).toBe(true);
  });

  it('requires explicit next for multi-select questions', async () => {
    const fixture = await render(
      askRequest('perm-ask-multi', [
        {
          question: 'Which checks should run?',
          multiSelect: true,
          options: [{ label: 'Unit tests' }, { label: 'Build' }],
        },
        {
          question: 'When should they run?',
          options: [{ label: 'Now' }],
        },
      ]),
    );

    clickOption(fixture, 'Unit tests');

    expect(text(fixture)).toContain('Question 1 of 2');
    expect(text(fixture)).toContain('Which checks should run?');
    expect(text(fixture)).toContain('Next');

    clickButton(fixture, 'Next');

    expect(text(fixture)).toContain('Question 2 of 2');
    expect(text(fixture)).toContain('When should they run?');
  });

  it('requires text before advancing an Other answer', async () => {
    const fixture = await render();

    clickOption(fixture, 'Other');

    expect(text(fixture)).toContain('Question 1 of 2');
    expect(text(fixture)).toContain('Next');
    const nextButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((node) => (node.textContent ?? '').includes('Next')) as HTMLButtonElement | undefined;
    expect(nextButton?.disabled).toBe(true);

    setOtherAnswer(fixture, 'Use a hybrid approach');

    expect(nextButton?.disabled).toBe(false);
    clickButton(fixture, 'Next');
    expect(text(fixture)).toContain('Question 2 of 2');
  });

  it('submits all answers from the final recap with the existing payload shape', async () => {
    const fixture = await render();
    const approvals: unknown[] = [];
    fixture.componentInstance.approve.subscribe((approval) => approvals.push(approval));

    clickOption(fixture, 'Option A');
    clickOption(fixture, 'Brief');

    expect(text(fixture)).toContain('Review answers');
    expect(text(fixture)).toContain('Which approach should we use?');
    expect(text(fixture)).toContain('Option A');
    expect(text(fixture)).toContain('How much detail should the answer include?');
    expect(text(fixture)).toContain('Brief');

    clickButton(fixture, 'Submit');

    expect(approvals).toEqual([
      {
        remember: false,
        content: {
          answers: {
            'Which approach should we use?': 'Option A',
            'How much detail should the answer include?': 'Brief',
          },
        },
      },
    ]);
  });

  it('resets to the first question when the request changes', async () => {
    const fixture = await render();

    clickOption(fixture, 'Option A');
    expect(text(fixture)).toContain('Question 2 of 2');

    fixture.componentRef.setInput('request', askRequest('perm-ask-2'));
    fixture.detectChanges();

    expect(text(fixture)).toContain('Question 1 of 2');
    expect(text(fixture)).toContain('Which approach should we use?');
    expect(text(fixture)).not.toContain('How much detail should the answer include?');
    expect(checkedOption(fixture, 'Option A')).toBe(false);
  });
});
