import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeComposerComponent } from './claude-composer.component';
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
  oldLineStart: 10,
  oldLineEnd: 10,
  newLineStart: 11,
  newLineEnd: 11,
  selectedText: 'const value = true;',
  context: { before: [], selected: [], after: [] },
  truncated: false,
  ...overrides,
});

describe('ClaudeComposerComponent', () => {
  it('shrinks the textarea when the value is cleared programmatically', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Line 1\nLine 2\nLine 3');
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('.cw-comp__ta') as HTMLTextAreaElement;
    let scrollHeight = 120;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    fixture.componentInstance.onInput({ target: textarea } as unknown as Event);
    expect(textarea.style.height).toBe('120px');

    scrollHeight = 0;
    fixture.componentRef.setInput('value', '');
    fixture.detectChanges();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(textarea.value).toBe('');
    expect(textarea.style.height).toBe('0px');
  });

  it('disables send while a permission request is pending', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', true);
    fixture.componentRef.setInput('sendDisabledReason', 'Approve or deny the pending request to resume the conversation.');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const sendButton = element.querySelector('.cw-comp__btn--send') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(element.textContent).toContain('Approve or deny the pending request');
  });

  it('blocks Enter submit while a permission request is pending', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', true);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    fixture.componentInstance.onKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('resumes normal send once the permission request is cleared', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Continue');
    fixture.componentRef.setInput('blockedByPermission', false);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    fixture.componentInstance.submit();
    expect(sendSpy).toHaveBeenCalledWith({ text: 'Continue', images: [], diffMentions: [] });
  });

  it('renders and sends diff mentions without typed text', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', '');
    fixture.componentRef.setInput('diffMentions', [mention()]);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('src/app.ts');
    expect(element.textContent).toContain('const value = true;');

    fixture.componentInstance.submit();
    expect(sendSpy).toHaveBeenCalledWith({ text: '', images: [], diffMentions: [mention()] });
  });
});
