import { ClaudeMessageComponent } from '@/shared/agent-chat/transcript/claude-message.component';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import {
  DIFF_SELECTION_MENTION_TAG,
  serializeDiffSelectionMention,
} from '@/shared/utils/diff-selection-mention';
import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mention = (overrides: Partial<DiffSelectionMention> = {}): DiffSelectionMention => ({
  id: 'mention-1',
  version: 1,
  scope: 'branch',
  compareLabel: 'feature vs origin/main',
  baseSha: 'base',
  headSha: 'head',
  filePath: 'src/app.ts',
  oldPath: null,
  status: 'modified',
  changeHash: 'hash',
  oldLineStart: 4,
  oldLineEnd: 4,
  newLineStart: 5,
  newLineEnd: 5,
  selectedText: 'return next;',
  context: { before: [], selected: [], after: [] },
  truncated: false,
  ...overrides,
});

describe('ClaudeMessageComponent', () => {
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.documentElement.classList.remove('dark');
  });

  it.each(['light', 'dark'])(
    'preserves quoted event text and hides empty bubbles in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ClaudeMessageComponent],
      }).compileComponents();
      const fixture = TestBed.createComponent(ClaudeMessageComponent);
      const content =
        'Review this XML:\n```xml\n<skill><name>test</name><path>/repo/test</path>Important instructions</skill>\n```';
      fixture.componentRef.setInput('item', { id: 'quoted', kind: 'user', content, timestamp: '' });
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('.cw-msg__user-text')?.textContent).toBe(content);
      expect(element.querySelector('[data-message-load]')).toBeNull();

      fixture.componentRef.setInput('item', {
        id: 'empty',
        kind: 'user',
        content: ' \n\t',
        timestamp: '',
      });
      fixture.detectChanges();
      expect(element.querySelector('.cw-msg--user')).toBeNull();
    },
  );

  it.each(['light', 'dark'])(
    'renders skill and image loads as events in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ClaudeMessageComponent],
      }).compileComponents();
      const fixture = TestBed.createComponent(ClaudeMessageComponent);
      fixture.componentRef.setInput('showEdit', true);
      fixture.componentRef.setInput('item', {
        id: 'skill',
        kind: 'user',
        timestamp: '2026-04-24T08:00:00.000Z',
        content:
          'Base directory for this skill: /repo/.claude/skills/write-tests\n\n# Long guidelines\nSkill instructions',
      });
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      expect(element.querySelector('[data-message-load="skill"]')?.textContent).toContain(
        'Loaded skill: write-tests',
      );
      expect(element.textContent).not.toContain('Skill instructions');
      expect(element.querySelector('.cw-msg--user')).toBeNull();
      expect(element.querySelector('[aria-label="Edit message"]')).toBeNull();

      fixture.componentRef.setInput('item', {
        id: 'image',
        kind: 'user',
        timestamp: '2026-04-24T08:00:00.000Z',
        content:
          '[Image: original 1100x3000, displayed at 733x2000. Multiply coordinates by 1.50 to map to original image.]',
      });
      fixture.detectChanges();
      expect(element.querySelector('[data-message-load="image"]')?.textContent).toContain(
        'Loaded image',
      );
      expect(element.textContent).not.toContain('Multiply coordinates');
      expect(element.querySelector('.cw-msg--user')).toBeNull();

      fixture.componentRef.setInput('item', {
        id: 'mixed',
        kind: 'user',
        timestamp: '2026-04-24T08:00:00.000Z',
        content: 'Check this\n[Image: original 1100x3000, displayed at 733x2000.]',
      });
      fixture.detectChanges();
      expect(element.querySelector('.cw-msg__user-text')?.textContent).toBe('Check this');
      expect(element.querySelector('[data-message-load="image"]')).not.toBeNull();
    },
  );

  it.each(['light', 'dark'])(
    'renders agent hand-backs with readable sender, result label and expandable Markdown in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      await TestBed.configureTestingModule({
        imports: [ClaudeMessageComponent],
      }).compileComponents();
      const fixture = TestBed.createComponent(ClaudeMessageComponent);
      const content =
        'Received a final response from af8cdb1911fc5f307.\n\n[Subagent hand-back] All checks passed.\n\nFull details remain available.';
      fixture.componentRef.setInput('item', {
        id: 'agent-message-1:user:0',
        kind: 'system',
        content,
        timestamp: '',
      });
      fixture.componentRef.setInput('showEdit', true);
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;
      const toggle = element.querySelector('[aria-expanded]') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(element.querySelector('[data-agent-message]')?.textContent).toContain('Final result');
      expect(element.textContent).toContain('af8cdb1911fc5f307');
      expect(element.textContent).not.toContain('[Subagent hand-back]');
      expect(element.querySelector('.cw-msg--user')).toBeNull();
      expect(element.querySelector('[aria-label="Edit message"]')).toBeNull();
      toggle.click();
      fixture.detectChanges();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(element.querySelector('agent-markdown')?.textContent).toContain(
        'Full details remain available.',
      );
    },
  );

  it('renders configured copy, edit, and fork actions', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Ship it',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showCopy', true);
    fixture.componentRef.setInput('showEdit', true);
    fixture.componentRef.setInput('showFork', true);
    fixture.detectChanges();

    let element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Fork from here"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Edit message"]')).not.toBeNull();

    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: 'Done',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
      sourceMessageId: 'source-assistant-1',
    });
    fixture.componentRef.setInput('showCopy', true);
    fixture.componentRef.setInput('showEdit', false);
    fixture.componentRef.setInput('showFork', true);
    fixture.detectChanges();

    element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Fork from here"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Edit message"]')).toBeNull();
  });

  it('emits arm/edit confirmation events in sequence', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Rework this prompt',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showEdit', true);

    const armSpy = vi.fn();
    const confirmSpy = vi.fn();
    fixture.componentInstance.armEdit.subscribe(armSpy);
    fixture.componentInstance.confirmEdit.subscribe(confirmSpy);

    fixture.detectChanges();
    let buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-msg__action'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.getAttribute('aria-label') === 'Edit message')?.click();
    expect(armSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();

    fixture.componentRef.setInput('editArmed', true);
    fixture.detectChanges();

    buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.cw-msg__action'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.getAttribute('aria-label') === 'Confirm edit')?.click();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.textContent).toContain('Rewind to this message?');
  });

  it('emits selected text when copying part of a message', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-1',
      kind: 'user',
      content: 'Copy only this phrase',
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-1',
    });
    fixture.componentRef.setInput('showCopy', true);

    const copySpy = vi.fn();
    fixture.componentInstance.messageCopy.subscribe(copySpy);
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector('.cw-msg__user-text') as HTMLElement;
    const textNode = text.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.setEnd(textNode, 14);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    const copyButton = fixture.nativeElement.querySelector(
      '.cw-msg__action[aria-label="Copy message"]',
    ) as HTMLButtonElement;
    copyButton.click();

    expect(copySpy).toHaveBeenCalledWith('only this');
  });

  it('renders fork markers and emits fork panel actions', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    const fork = {
      id: 1,
      parentSessionId: 7,
      childSessionId: 8,
      provider: 'claude',
      anchorMessageId: 'assistant-wrapper-1',
      anchorMessageKind: 'assistant' as const,
      anchorExcerpt: 'Done',
      draft: null,
      createdAt: '2026-04-24T08:00:00.000Z',
      childSession: {
        id: 8,
        repoId: 1,
        projectId: 1,
        branchName: 'main',
        worktreePath: '/tmp/project',
        name: 'Parent (fork)',
        status: 'created',
        activeAgentProvider: 'claude',
        claudeSessionId: 'forked-claude',
        codexSessionId: '-1',
        piSessionPath: '-1',
        hasInjectedWorktreeContext: false,
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        lastStateChangeAt: null,
        createdAt: '2026-04-24T08:00:00.000Z',
        updatedAt: '2026-04-24T08:00:00.000Z',
      },
    };
    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: 'Done',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
      sourceMessageId: 'source-assistant-1',
    });
    fixture.componentRef.setInput('showFork', true);
    fixture.componentRef.setInput('forks', [fork]);
    fixture.componentRef.setInput('forksExpanded', true);

    const openSpy = vi.fn();
    const forkAgainSpy = vi.fn();
    fixture.componentInstance.openFork.subscribe(openSpy);
    fixture.componentInstance.forkAgain.subscribe(forkAgainSpy);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.cw-msg__fork-marker')?.textContent).toContain('1 fork');
    expect(element.querySelector('.cw-msg__fork-name')?.textContent).toContain('Parent (fork)');

    (element.querySelector('.cw-msg__fork-open') as HTMLButtonElement).click();
    (element.querySelector('.cw-msg__fork-again') as HTMLButtonElement).click();

    expect(openSpy).toHaveBeenCalledWith(fork);
    expect(forkAgainSpy).toHaveBeenCalledTimes(1);
  });

  it('emits a plan chat request from the plan launcher ask button', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    const review = {
      provider: 'codex' as const,
      source: 'transcript-plan' as const,
      sessionId: 7,
      reviewId: 'transcript-plan:assistant-1',
      messageId: 'assistant-1',
      anchorMessageId: 'provider-msg-1',
      anchorMessageKind: 'assistant' as const,
      planMarkdown: '# Plan',
      createdAt: '2026-04-24T08:00:01.000Z',
    };
    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: '# Plan',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
    });
    fixture.componentRef.setInput('planReviewEnabled', true);
    fixture.componentRef.setInput('planReview', review);

    const askSpy = vi.fn();
    fixture.componentInstance.openPlanChat.subscribe(askSpy);
    fixture.detectChanges();

    const askButton = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll('.cw-plan-launcher__button'),
    ).find((button) => button.textContent?.includes('Ask')) as HTMLButtonElement;
    askButton.click();

    expect(askSpy).toHaveBeenCalledWith(review);
  });

  it('renders markdown while assistant text is streaming', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'assistant-1',
      kind: 'assistant',
      content: '**Bold** and `code`',
      timestamp: '2026-04-24T08:00:01.000Z',
      receivedAt: '2026-04-24T08:00:01.000Z',
      sourceMessageId: 'source-assistant-1',
    });
    fixture.componentRef.setInput('streaming', true);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.cw-md--streaming strong')?.textContent).toBe('Bold');
    expect(element.querySelector('.cw-md--streaming code')?.textContent).toBe('code');
    expect(element.textContent).not.toContain('**Bold**');
    expect(element.querySelector('.cw-caret')).not.toBeNull();
  });

  it('renders user diff mention payloads as cards instead of raw tags', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const diffMention = mention({ filePath: 'src/main/java/package/folder/Test.java' });
    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'user-mention',
      kind: 'user',
      content: `Please review this\n\n${serializeDiffSelectionMention(diffMention)}`,
      timestamp: '2026-04-24T08:00:00.000Z',
      authoredAt: '2026-04-24T08:00:00.000Z',
      sourceMessageId: 'source-user-mention',
    });
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Please review this');
    expect(element.querySelector('.agent-mention__dir')?.textContent).toBe(
      'src/main/java/package/folder',
    );
    expect(element.querySelector('.agent-mention__name')?.textContent).toBe('Test.java');
    expect(element.querySelector('.agent-mention__name')?.tagName.toLowerCase()).toBe('strong');
    expect(element.textContent).toContain('return next;');
    expect(element.textContent).not.toContain(DIFF_SELECTION_MENTION_TAG);
    expect(element.querySelector('.cw-msg__mention')).not.toBeNull();
  });

  it('emits an editor target when a rendered local file link is clicked', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeMessageComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeMessageComponent);
    fixture.componentRef.setInput('item', {
      id: 'assistant-file-link',
      kind: 'assistant',
      content: '[open](/tmp/project/src/app.ts:14:2)',
      timestamp: '2026-04-24T08:00:01.000Z',
    });
    fixture.componentRef.setInput('worktreePath', '/tmp/project');
    const openSpy = vi.fn();
    fixture.componentInstance.openLocalFile.subscribe(openSpy);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.cw-md a') as HTMLAnchorElement).click();

    expect(openSpy).toHaveBeenCalledWith({ path: 'src/app.ts', line: 14, column: 2 });
  });
});
