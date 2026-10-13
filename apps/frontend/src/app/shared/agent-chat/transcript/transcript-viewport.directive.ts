import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { parseDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { getUserMessageDisplay, isUserPrompt } from '@/shared/utils/user-message-display';
import {
  Directive,
  ElementRef,
  DestroyRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

@Directive({
  selector: '[cwTranscriptViewport]',
  exportAs: 'cwTranscriptViewport',
  host: { '(scroll)': 'onTranscriptScroll()', '(window:resize)': 'onWindowResize()' },
})
export class TranscriptViewportDirective {
  private readonly element = inject<ElementRef<HTMLDivElement>>(ElementRef);
  readonly items = input<readonly ClaudeTranscriptItem[]>([]);
  readonly sessionKey = input<number | string | null>(null);
  readonly pendingReply = input(false);
  readonly runPhase = input<string>('idle');
  readonly scrollMemory = input<Map<string, { top: number; pinned: boolean }> | null>(null);
  readonly restoreReady = input(true);
  readonly hasNewActivity = signal(false);
  private currentKey: string | null = null;
  private pendingRestore: { top: number; pinned: boolean } | null = null;
  private lastTail = '';
  private lastFirst = '';
  private lastHeight = 0;

  private shouldAutoScrollTranscript = true;

  private readonly transcriptBottomThresholdPx = 48;

  readonly contextualPrompt = signal<ClaudeTranscriptItem | null>(null);

  readonly contextualPromptCollapsed = signal(false);

  readonly contextualPromptText = computed(() => {
    const item = this.contextualPrompt();
    if (!item) return '';

    const taskDisplay = getUserMessageDisplay(item);
    const sessionDisplay = parseSessionMentions(taskDisplay.text);
    const messageDisplay = parseDiffSelectionMentions(sessionDisplay.text);
    const text = messageDisplay.text.trim();
    if (text) return text;

    const attachmentCount = sessionDisplay.mentions.length + messageDisplay.mentions.length;
    if (attachmentCount) {
      return `${attachmentCount} attached ${attachmentCount === 1 ? 'reference' : 'references'}`;
    }
    return item.content?.trim() || 'Prompt';
  });

  readonly userPromptIndex = computed(() => {
    const byId = new Map<string, ClaudeTranscriptItem>();
    let firstId: string | null = null;
    let lastId: string | null = null;
    const items = this.items();
    for (const item of items) {
      if (isUserPrompt(item)) {
        byId.set(item.id, item);
        firstId ??= item.id;
        lastId = item.id;
      }
    }
    return { byId, firstId, lastId };
  });

  private userPromptElements: HTMLElement[] = [];
  constructor() {
    inject(DestroyRef).onDestroy(() => this.saveScroll());
    afterRenderEffect(() => {
      const items = this.items();
      this.runPhase();
      this.pendingReply();
      const el = this.element.nativeElement;
      const tail = items.length ? `${items.at(-1)!.id}:${items.at(-1)!.content?.length ?? 0}` : '';
      const first = items[0]?.id ?? '';
      if (this.restoreReady() && this.pendingRestore) {
        el.scrollTop = this.pendingRestore.top;
        this.shouldAutoScrollTranscript = this.pendingRestore.pinned;
        this.pendingRestore = null;
      } else if (
        !this.shouldAutoScrollTranscript &&
        this.lastFirst &&
        first !== this.lastFirst &&
        tail === this.lastTail
      ) {
        el.scrollTop += Math.max(0, el.scrollHeight - this.lastHeight);
      }
      if (!this.shouldAutoScrollTranscript && this.lastTail && tail !== this.lastTail)
        this.hasNewActivity.set(true);
      this.scrollTranscriptToBottomIfPinned();
      this.refreshUserPromptElements();
      this.updateContextualPrompt();
      this.lastTail = tail;
      this.lastFirst = first;
      this.lastHeight = el.scrollHeight;
    });
    effect(() => {
      const key = this.sessionKey();
      const memory = this.scrollMemory();
      untracked(() => {
        this.saveScroll();
        this.currentKey = key === null ? null : String(key);
        this.reset();
        this.pendingRestore = this.currentKey ? (memory?.get(this.currentKey) ?? null) : null;
        if (this.pendingRestore) this.shouldAutoScrollTranscript = this.pendingRestore.pinned;
      });
    });
  }
  private saveScroll(): void {
    const memory = this.scrollMemory();
    if (!memory || !this.currentKey) return;
    memory.delete(this.currentKey);
    memory.set(this.currentKey, {
      top: this.element.nativeElement.scrollTop,
      pinned: this.shouldAutoScrollTranscript,
    });
    while (memory.size > 32) memory.delete(memory.keys().next().value!);
  }
  pinToBottom(): void {
    this.shouldAutoScrollTranscript = true;
    this.hasNewActivity.set(false);
    this.scrollToBottom();
  }

  reset(): void {
    this.shouldAutoScrollTranscript = true;
    this.hasNewActivity.set(false);
    this.lastTail = '';
    this.lastFirst = '';
    this.lastHeight = 0;

    this.userPromptElements = [];

    this.contextualPrompt.set(null);

    this.contextualPromptCollapsed.set(false);
  }

  onTranscriptScroll(): void {
    const el = this.element.nativeElement;
    if (!el) return;
    this.shouldAutoScrollTranscript = this.isTranscriptScrolledToBottom(el);
    if (this.shouldAutoScrollTranscript) this.hasNewActivity.set(false);
    this.updateContextualPrompt();
  }

  onWindowResize(): void {
    this.updateContextualPrompt();
  }

  scrollToContextualPrompt(): void {
    const container = this.element.nativeElement;
    const promptId = this.contextualPrompt()?.id;
    const message = promptId
      ? this.userPromptElements.find((element) => element.dataset['userPromptId'] === promptId)
      : null;
    if (!container || !message) return;

    const containerTop = container.getBoundingClientRect().top;
    const messageTop = message.getBoundingClientRect().top;
    container.scrollTo({
      top: Math.max(0, container.scrollTop + messageTop - containerTop - 16),
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }

  collapseContextualPrompt(): void {
    this.contextualPromptCollapsed.set(true);
  }

  expandContextualPrompt(): void {
    this.contextualPromptCollapsed.set(false);
  }

  private scrollTranscriptToBottomIfPinned(): void {
    if (!this.shouldAutoScrollTranscript) return;
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    const el = this.element.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  private isTranscriptScrolledToBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= this.transcriptBottomThresholdPx;
  }

  private refreshUserPromptElements(): void {
    const container = this.element.nativeElement;
    if (!container) {
      this.userPromptElements = [];
      return;
    }

    const promptIndex = this.userPromptIndex();
    if (!promptIndex.byId.size) {
      this.userPromptElements = [];
      return;
    }
    const firstElement = this.userPromptElements[0];
    const lastElement = this.userPromptElements.at(-1);
    if (
      this.userPromptElements.length === promptIndex.byId.size &&
      firstElement?.isConnected &&
      lastElement?.isConnected &&
      firstElement.dataset['userPromptId'] === promptIndex.firstId &&
      lastElement.dataset['userPromptId'] === promptIndex.lastId
    ) {
      return;
    }

    this.userPromptElements = Array.from(
      container.querySelectorAll<HTMLElement>('[data-user-prompt-id]'),
    );
  }

  private updateContextualPrompt(): void {
    const container = this.element.nativeElement;
    if (!container || !this.userPromptElements.length) {
      this.contextualPrompt.set(null);
      return;
    }

    const containerTop = container.getBoundingClientRect().top;
    // A point near the top represents the response the reader is currently
    // following. Selecting the last prompt above it makes turn hand-offs feel
    // stable without waiting until the next prompt has left the viewport.
    const probeY = containerTop + Math.min(160, Math.max(48, container.clientHeight * 0.28));
    let low = 0;
    let high = this.userPromptElements.length - 1;
    let candidate: HTMLElement | null = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const element = this.userPromptElements[middle];
      if (element.getBoundingClientRect().top <= probeY) {
        candidate = element;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    if (!candidate || candidate.getBoundingClientRect().bottom >= containerTop - 1) {
      this.contextualPrompt.set(null);
      return;
    }

    const promptId = candidate.dataset['userPromptId'];
    this.contextualPrompt.set(
      promptId ? (this.userPromptIndex().byId.get(promptId) ?? null) : null,
    );
  }
}
