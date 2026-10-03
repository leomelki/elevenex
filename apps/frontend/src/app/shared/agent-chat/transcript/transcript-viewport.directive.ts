import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { parseDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { parseTaskNotifications } from '@/shared/utils/task-notification';
import {
  Directive,
  ElementRef,
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

  private shouldAutoScrollTranscript = true;

  private readonly transcriptBottomThresholdPx = 48;

  readonly contextualPrompt = signal<ClaudeTranscriptItem | null>(null);

  readonly contextualPromptCollapsed = signal(false);

  readonly contextualPromptText = computed(() => {
    const item = this.contextualPrompt();
    if (!item) return '';

    const taskDisplay = parseTaskNotifications(item.content);
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
      if (
        item.kind === 'user' &&
        !item.isSynthetic &&
        !item.parentToolUseId &&
        parseTaskNotifications(item.content).text.trim()
      ) {
        byId.set(item.id, item);
        firstId ??= item.id;
        lastId = item.id;
      }
    }
    return { byId, firstId, lastId };
  });

  private userPromptElements: HTMLElement[] = [];
  constructor() {
    afterRenderEffect(() => {
      this.items();
      this.runPhase();
      this.pendingReply();
      this.scrollTranscriptToBottomIfPinned();
      this.refreshUserPromptElements();
      this.updateContextualPrompt();
    });
    effect(() => {
      this.sessionKey();
      untracked(() => this.reset());
    });
  }
  pinToBottom(): void {
    this.shouldAutoScrollTranscript = true;
    this.scrollToBottom();
  }

  reset(): void {
    this.shouldAutoScrollTranscript = true;

    this.userPromptElements = [];

    this.contextualPrompt.set(null);

    this.contextualPromptCollapsed.set(false);
  }

  onTranscriptScroll(): void {
    const el = this.element.nativeElement;
    if (!el) return;
    this.shouldAutoScrollTranscript = this.isTranscriptScrolledToBottom(el);
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
