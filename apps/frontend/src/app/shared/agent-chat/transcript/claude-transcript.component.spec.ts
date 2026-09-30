import { ClaudeTranscriptComponent } from '@/shared/agent-chat/transcript/claude-transcript.component';
import { pairTranscript } from '@/shared/agent-chat/transcript/paired-transcript';
import { buildTranscriptRenderItems } from '@/shared/agent-chat/transcript/transcript-render-items';
import type { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

const timestamp = '2026-09-30T08:00:00.000Z';
const call: ClaudeTranscriptItem = {
  id: 'tool',
  kind: 'tool_use',
  toolUseId: 'tool',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf tmp' },
  timestamp,
  interaction: {
    kind: 'permission',
    decision: 'denied',
    decisionLabel: 'Deny',
    decisionTone: 'warn',
    remember: false,
    content: { message: 'Keep these files.\nUse <another> folder.' },
    createdAt: timestamp,
    resolvedAt: timestamp,
  },
};

async function render(items: ClaudeTranscriptItem[], settled = true) {
  await TestBed.configureTestingModule({
    imports: [ClaudeTranscriptComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(ClaudeTranscriptComponent);
  fixture.componentRef.setInput(
    'items',
    buildTranscriptRenderItems({
      units: pairTranscript(items),
      settled,
      childItemsByParentToolUseId: {},
      subagents: [],
      hookEvents: [],
    }),
  );
  fixture.detectChanges();
  return fixture;
}

describe('ClaudeTranscriptComponent final outputs', () => {
  it('offers review navigation only when the host supports it', async () => {
    const fixture = await render([
      { id: 'user', kind: 'user', content: 'Update the file', timestamp },
      {
        ...call,
        toolName: 'Edit',
        interaction: undefined,
        toolInput: { file_path: 'a.ts', old_string: 'old', new_string: 'new' },
      },
      { id: 'answer', kind: 'assistant', content: 'Done', timestamp },
    ]);
    fixture.componentRef.setInput('expandedTurnChanges', { user: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('cw-turn-changes')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.cw-turn-changes__review')).toBeNull();
    fixture.componentRef.setInput('canReviewChanges', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cw-turn-changes__review')).not.toBeNull();
  });

  afterEach(() => document.documentElement.classList.remove('dark'));

  it.each(['light', 'dark'])(
    'renders consecutive final replies outside collapsed work in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const fixture = await render([
        { id: 'user', kind: 'user', content: 'Check the changes', timestamp },
        { id: 'commentary', kind: 'assistant', content: 'Checking the files.', timestamp },
        { ...call, interaction: undefined },
        { id: 'first-reply', kind: 'assistant', content: 'The changes are ready.', timestamp },
        { id: 'second-reply', kind: 'assistant', content: 'All checks passed.', timestamp },
      ]);
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('cw-turn-summary')).not.toBeNull();
      expect(element.querySelector('cw-tool-call')).toBeNull();
      expect(element.textContent).not.toContain('Checking the files.');
      expect(element.textContent).toContain('The changes are ready.');
      expect(element.textContent).toContain('All checks passed.');
      expect(element.textContent!.indexOf('The changes are ready.')).toBeLessThan(
        element.textContent!.indexOf('All checks passed.'),
      );

      fixture.componentRef.setInput('expandedTurns', { user: true });
      fixture.detectChanges();
      expect(element.querySelector('cw-tool-call')).not.toBeNull();
      expect(element.textContent).toContain('Checking the files.');
      expect(element.querySelectorAll('.cw-msg--assistant')).toHaveLength(3);
    },
  );
});

describe('ClaudeTranscriptComponent denial feedback', () => {
  it('keeps feedback visible in a settled turn and renders it only once when expanded', async () => {
    const fixture = await render([
      { id: 'user', kind: 'user', content: 'Clean up temporary files', timestamp },
      call,
      { id: 'reply', kind: 'assistant', content: 'I will use another folder.', timestamp },
    ]);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('cw-turn-summary')).not.toBeNull();
    expect(element.querySelector('cw-tool-call')).toBeNull();
    const receipt = element.querySelector('[data-tool-denial]')!;
    expect(receipt.textContent).toContain('You denied this tool');
    expect(receipt.textContent).toContain('rm -rf tmp');
    expect(receipt.textContent).toContain('Keep these files.\nUse <another> folder.');
    expect(receipt.querySelector('another')).toBeNull();
    expect(element.textContent!.indexOf('Keep these files.')).toBeLessThan(
      element.textContent!.indexOf('I will use another folder.'),
    );

    fixture.componentRef.setInput('expandedTurns', { user: true });
    fixture.detectChanges();
    expect(element.querySelector('cw-tool-call')).not.toBeNull();
    expect(element.querySelectorAll('[data-tool-denial]')).toHaveLength(1);
  });

  it('shows feedback immediately while the turn is running', async () => {
    const fixture = await render([call], false);
    expect(fixture.nativeElement.querySelector('[data-tool-denial]').textContent).toContain(
      'Keep these files.',
    );
  });

  it('retains feedback for normally hidden plan-file tools', async () => {
    const fixture = await render([
      {
        ...call,
        toolName: 'Write',
        toolInput: {
          file_path: '/tmp/.claude/plans/example.md',
          content: 'Plan draft',
        },
      },
    ]);
    expect(fixture.nativeElement.querySelector('[data-tool-denial]').textContent).toContain(
      'Keep these files.',
    );
  });

  it('shows an explicit denial without inventing a reason', async () => {
    const fixture = await render([
      { ...call, interaction: { ...call.interaction!, content: null } },
    ]);
    const receipt = fixture.nativeElement.querySelector('[data-tool-denial]');
    expect(receipt.textContent).toContain('You denied this tool');
    expect(receipt.querySelector('p')).toBeNull();
  });

  it('does not misrepresent a tool error as a user denial', async () => {
    const fixture = await render([
      { ...call, interaction: undefined },
      {
        id: 'result',
        kind: 'tool_result',
        toolUseId: 'tool',
        isError: true,
        content: 'Permission denied',
        timestamp,
      },
    ]);
    expect(fixture.nativeElement.querySelector('[data-tool-denial]')).toBeNull();
  });

  it('shows one feedback message for a batch denied with one user decision', () => {
    const batch = [{ toolUseId: 'tool' }, { toolUseId: 'second-tool' }];
    const interaction = { ...call.interaction!, requestSnapshot: { batch } };
    const items = buildTranscriptRenderItems({
      units: pairTranscript([
        { ...call, interaction },
        { ...call, id: 'second-tool', toolUseId: 'second-tool', interaction },
      ]),
      settled: false,
      childItemsByParentToolUseId: {},
      subagents: [],
      hookEvents: [],
    });
    expect(items.filter((item) => item.kind === 'tool-denial')).toHaveLength(1);
  });

  it('keeps feedback from a subagent visible outside the collapsed work', () => {
    const items = buildTranscriptRenderItems({
      units: pairTranscript([
        { id: 'user', kind: 'user', content: 'Clean up', timestamp },
        { id: 'agent', kind: 'tool_use', toolUseId: 'agent', toolName: 'Agent', timestamp },
        { id: 'reply', kind: 'assistant', content: 'Done', timestamp },
      ]),
      settled: true,
      childItemsByParentToolUseId: { agent: [call] },
      subagents: [],
      hookEvents: [],
    });
    expect(items.map((item) => item.kind)).toEqual([
      'unit',
      'collapsed-turn',
      'tool-denial',
      'unit',
    ]);
    expect(items[2]).toMatchObject({ call });
  });
});
