import {
  ClaudeComposerComponent,
  ComposerImageAttachment,
} from '@/shared/agent-chat/composer/claude-composer.component';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
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
  oldLineStart: 10,
  oldLineEnd: 10,
  newLineStart: 11,
  newLineEnd: 11,
  selectedText: 'const value = true;',
  context: { before: [], selected: [], after: [] },
  truncated: false,
  ...overrides,
});

const image = (overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment => ({
  id: 'img-1',
  name: 'screen.png',
  mediaType: 'image/png',
  dataUrl: 'data:image/png;base64,abc',
  size: 3,
  ...overrides,
});

describe('ClaudeComposerComponent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lets an idle Codex parent send follow-ups while subagents run, without a queue warning', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Stop the explorers and summarize their findings');
    fixture.componentRef.setInput('backgroundAgentCount', 3);
    fixture.componentRef.setInput('queueBehindBackgroundWork', false);
    fixture.detectChanges();
    const send = fixture.nativeElement.querySelector(
      '[aria-label="Send message"]',
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(fixture.componentInstance.queueing()).toBe(false);
    expect(fixture.nativeElement.querySelector('.cw-comp__bg-agent')).toBeNull();
    const received = vi.fn();
    fixture.componentInstance.send.subscribe(received);
    send.click();
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Stop the explorers and summarize their findings' }),
    );
  });

  it('queues Codex follow-ups during the parent turn and respects an explicitly paused queue', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Check performance next');
    fixture.componentRef.setInput('backgroundAgentCount', 3);
    fixture.componentRef.setInput('queueBehindBackgroundWork', false);
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="Queue message"]')).toBeTruthy();
    fixture.componentRef.setInput('running', false);
    fixture.componentRef.setInput('queuePaused', true);
    fixture.detectChanges();
    expect(fixture.componentInstance.queueing()).toBe(true);
    expect(fixture.nativeElement.querySelector('[aria-label="Queue message"]')).toBeTruthy();
  });

  it('preserves background queueing for providers that require it', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('backgroundAgentCount', 1);
    fixture.detectChanges();
    expect(fixture.componentInstance.queueing()).toBe(true);
    expect(fixture.nativeElement.querySelector('.cw-comp__bg-agent').textContent).toContain(
      'queued until it finishes',
    );
  });

  it('describes Codex steering as non-interrupting and forwards the selected queued message', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('nativeSteering', true);
    fixture.componentRef.setInput('running', true);
    fixture.componentRef.setInput('pendingPrompts', [
      {
        id: 'correction',
        prompt: 'Focus on the API instead',
        queuedAt: '2026-10-12T10:00:00.000Z',
      },
    ]);
    fixture.detectChanges();
    const steer = fixture.nativeElement.querySelector(
      '.cw-comp__pending-steer',
    ) as HTMLButtonElement;
    expect(steer.title).toContain('without stopping');
    const selected = vi.fn();
    fixture.componentInstance.steerPending.subscribe(selected);
    steer.click();
    expect(selected).toHaveBeenCalledExactlyOnceWith('correction');
  });

  it('keeps drafting and attachments available while connecting without sending', async () => {
    await TestBed.configureTestingModule({ imports: [ClaudeComposerComponent] }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('disconnected', true);
    fixture.componentRef.setInput('connectionLabel', 'Connecting…');
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    textarea.value = 'Start with the API';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe('Start with the API');
    expect(fixture.nativeElement.textContent).toContain('Connecting… You can keep writing.');
    expect(fixture.nativeElement.querySelector('[aria-label="Attach image"]').disabled).toBe(false);
    const send = vi.fn();
    fixture.componentInstance.send.subscribe(send);
    fixture.componentInstance.submit();
    expect(send).not.toHaveBeenCalled();
    fixture.componentRef.setInput('disconnected', false);
    fixture.detectChanges();
    fixture.componentInstance.submit();
    expect(send).toHaveBeenCalledOnce();
  });

  it('resizes wrapped drafts when the pane width changes and stops observing on destroy', async () => {
    let notifyResize!: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'A draft that wraps in a narrow pane');
    fixture.detectChanges();
    const textarea = fixture.nativeElement.querySelector('.cw-comp__ta') as HTMLTextAreaElement;
    let scrollHeight = 52;
    const readHeight = vi.fn(() => scrollHeight);
    Object.defineProperty(textarea, 'scrollHeight', { get: readHeight });
    const editor = fixture.nativeElement.querySelector('.cw-comp__editor') as HTMLElement;
    const resize = (width: number) =>
      notifyResize(
        [{ target: editor, contentRect: { width } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );

    expect(observe).toHaveBeenCalledWith(editor);
    resize(600);
    expect(textarea.style.height).toBe('52px');
    readHeight.mockClear();
    resize(600);
    expect(readHeight).not.toHaveBeenCalled();
    scrollHeight = 112;
    resize(300);
    expect(textarea.style.height).toBe('112px');
    scrollHeight = 32;
    resize(800);
    expect(textarea.style.height).toBe('32px');
    scrollHeight = 600;
    resize(200);
    expect(textarea.style.height).toBe('256px');
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('measures at the compact width without oscillating or replacing the focused textarea', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'A message near the wrapping threshold');
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const editor = element.querySelector('.cw-comp__editor') as HTMLElement;
    const textarea = element.querySelector('.cw-comp__ta') as HTMLTextAreaElement;
    const measure = element.querySelector('.cw-comp__measure') as HTMLTextAreaElement;
    const tools = element.querySelector('.cw-comp__bar > div') as HTMLElement;
    const actions = element.querySelector('.cw-comp__btns') as HTMLElement;
    let editorWidth = 600;
    let measuredHeight = 52;
    editor.style.padding = '8px';
    editor.style.columnGap = '6px';
    measure.style.lineHeight = '20px';
    measure.style.padding = '6px';
    Object.defineProperty(editor, 'clientWidth', { get: () => editorWidth });
    Object.defineProperty(tools, 'offsetWidth', { value: 58 });
    Object.defineProperty(actions, 'offsetWidth', { value: 28 });
    Object.defineProperty(measure, 'scrollHeight', { get: () => measuredHeight });
    // The wider visible textarea fits a line after expanding, while the
    // compact measurement still wraps. This must not collapse the composer.
    Object.defineProperty(textarea, 'scrollHeight', { value: 32 });
    textarea.focus();
    textarea.setSelectionRange(2, 8);
    fixture.componentInstance.onInput({ target: textarea } as unknown as Event);
    fixture.detectChanges();

    expect(fixture.componentInstance.expanded()).toBe(true);
    expect(measure.style.width).toBe('486px');
    expect(editor.dataset['expanded']).toBe('true');
    fixture.componentInstance.onInput({ target: textarea } as unknown as Event);
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBe(true);
    expect(element.querySelector('.cw-comp__ta')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 8]);

    // A wider panel or a shorter draft can fit the compact layout again.
    editorWidth = 800;
    measuredHeight = 32;
    fixture.componentInstance.onInput({ target: textarea } as unknown as Event);
    fixture.detectChanges();
    expect(measure.style.width).toBe('686px');
    expect(fixture.componentInstance.expanded()).toBe(false);
    expect(document.activeElement).toBe(textarea);
  });

  it('expands for explicit line breaks and returns to compact when a restored draft is cleared', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'First line\n');
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBe(true);
    fixture.componentRef.setInput('value', '');
    fixture.detectChanges();
    expect(fixture.componentInstance.expanded()).toBe(false);
  });

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
    fixture.componentRef.setInput(
      'sendDisabledReason',
      'Approve or deny the pending request to resume the conversation.',
    );
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
    const diffMention = mention({ filePath: 'src/main/java/package/folder/Test.java' });
    fixture.componentRef.setInput('value', '');
    fixture.componentRef.setInput('diffMentions', [diffMention]);
    const sendSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.agent-mention__dir')?.textContent).toBe(
      'src/main/java/package/folder',
    );
    expect(element.querySelector('.agent-mention__name')?.textContent).toBe('Test.java');
    expect(element.querySelector('.agent-mention__name')?.tagName.toLowerCase()).toBe('strong');
    expect(element.textContent).toContain('const value = true;');

    fixture.componentInstance.submit();
    expect(sendSpy).toHaveBeenCalledWith({ text: '', images: [], diffMentions: [diffMention] });
  });

  it('finds sessions with @ and attaches the selected session', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', '@auth');
    fixture.componentRef.setInput('sessionMentionCandidates', [
      { sessionId: 42, title: 'Fix authentication', branch: 'feature/auth', status: 'active' },
    ]);
    const requestSpy = vi.fn();
    fixture.componentInstance.requestSessionMention.subscribe(requestSpy);
    fixture.detectChanges();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    const textarea = fixture.nativeElement.querySelector('.cw-comp__ta') as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    fixture.componentInstance.refreshAc(textarea);

    expect(fixture.componentInstance.filtered()[0]).toEqual(
      expect.objectContaining({ type: 'session' }),
    );
    fixture.componentInstance.apply(fixture.componentInstance.filtered()[0]);
    expect(requestSpy).toHaveBeenCalledWith(42);
  });

  it('renders controlled image attachments and emits removal changes', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    const first = image();
    const second = image({ id: 'img-2', name: 'other.png' });
    const imageChangeSpy = vi.fn();
    fixture.componentInstance.imageAttachments.subscribe(imageChangeSpy);
    fixture.componentRef.setInput('imageAttachments', [first, second]);
    fixture.detectChanges();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.cw-comp__image')).toHaveLength(2);

    fixture.componentInstance.removeImage('img-1');
    expect(imageChangeSpy).toHaveBeenCalledWith([second]);
  });

  it('clears image attachments after submitting an image-only prompt', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    const attachedImage = image();
    const sendSpy = vi.fn();
    const imageChangeSpy = vi.fn();
    fixture.componentInstance.send.subscribe(sendSpy);
    fixture.componentInstance.imageAttachments.subscribe(imageChangeSpy);
    fixture.componentRef.setInput('value', '');
    fixture.componentRef.setInput('imageAttachments', [attachedImage]);
    fixture.detectChanges();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    fixture.componentInstance.submit();

    expect(sendSpy).toHaveBeenCalledWith({
      text: '',
      images: [attachedImage],
      diffMentions: [],
    });
    expect(imageChangeSpy).toHaveBeenCalledWith([]);
  });

  it('shows actionable paused queue controls and keeps new messages queued', async () => {
    await TestBed.configureTestingModule({
      imports: [ClaudeComposerComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ClaudeComposerComponent);
    fixture.componentRef.setInput('value', 'Add another task');
    fixture.componentRef.setInput('queuePaused', true);
    fixture.componentRef.setInput('pendingPrompts', [
      { id: 'queued-1', prompt: 'First queued task', queuedAt: new Date().toISOString() },
      { id: 'queued-2', prompt: 'Second queued task', queuedAt: new Date().toISOString() },
    ]);
    const resumeSpy = vi.fn();
    const clearSpy = vi.fn();
    const steerSpy = vi.fn();
    fixture.componentInstance.resumePending.subscribe(resumeSpy);
    fixture.componentInstance.clearPending.subscribe(clearSpy);
    fixture.componentInstance.steerPending.subscribe(steerSpy);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('2 messages paused');
    expect(element.querySelector('.cw-comp__btn--send')?.textContent).toContain('Queue');

    const steerButtons = element.querySelectorAll<HTMLButtonElement>('.cw-comp__pending-steer');
    expect(steerButtons).toHaveLength(2);
    steerButtons[1].click();
    expect(steerSpy).toHaveBeenCalledWith('queued-2');

    const actions = element.querySelectorAll<HTMLButtonElement>('.cw-comp__pending-action');
    actions[0].click();
    actions[1].click();

    expect(resumeSpy).toHaveBeenCalledOnce();
    expect(clearSpy).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(actions[1].textContent).toContain('Confirm clear');
    actions[1].click();
    expect(clearSpy).toHaveBeenCalledOnce();
  });
});
