import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeMessageComponent } from './claude-message.component';
import {
  DIFF_SELECTION_MENTION_TAG,
  serializeDiffSelectionMention,
} from '@/shared/utils/diff-selection-mention';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';

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
  });

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
    fixture.componentInstance.copy.subscribe(copySpy);
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
    expect(element.querySelector('.cw-msg__mention-dir')?.textContent).toBe(
      'src/main/java/package/folder',
    );
    expect(element.querySelector('.cw-msg__mention-name')?.textContent).toBe('Test.java');
    expect(element.querySelector('.cw-msg__mention-name')?.tagName.toLowerCase()).toBe('strong');
    expect(element.textContent).toContain('return next;');
    expect(element.textContent).not.toContain(DIFF_SELECTION_MENTION_TAG);
    expect(element.querySelector('.cw-msg__mention')).not.toBeNull();
  });
});
