import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideMessageSquare,
  lucideRefreshCw,
  lucideSend,
  lucideSquare,
  lucideX,
} from '@ng-icons/lucide';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import type { PlanChatFork } from '@/shared/models/session.model';
import { MarkdownPipe } from '../session/claude-workspace/pipes/markdown.pipe';
import { PlanReviewRequest } from './plan-review.model';
import { PlanChatService } from './plan-chat.service';

type PlanChatVisibleItem = Pick<
  ClaudeTranscriptItem,
  'id' | 'kind' | 'content' | 'timestamp' | 'authoredAt' | 'receivedAt'
>;

const QUESTION_RE = /<elevenex_plan_question>\s*([\s\S]*?)\s*<\/elevenex_plan_question>/i;

export function sanitizePlanChatUserContent(content: string | null | undefined): string {
  const text = content ?? '';
  const match = QUESTION_RE.exec(text);
  return (match?.[1] ?? text).trim();
}

@Component({
  selector: 'app-plan-chat-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideMessageSquare,
      lucideRefreshCw,
      lucideSend,
      lucideSquare,
      lucideX,
    }),
  ],
  template: `
    @if (review(); as activeReview) {
      <section class="pc-panel" aria-label="Ask about plan">
        <header class="pc-head">
          <div class="pc-head__copy">
            <span class="pc-eyebrow">Plan Q&A</span>
            <h3>Ask about this plan</h3>
          </div>
          @if (currentChat()) {
            <button
              type="button"
              class="pc-icon-btn"
              title="Start fresh"
              aria-label="Start fresh"
              [disabled]="resetting()"
              (click)="startFresh(activeReview)"
            >
              <ng-icon name="lucideRefreshCw" size="13" />
            </button>
          }
        </header>

        @if (!canAsk(activeReview)) {
          <div class="pc-body">
            <p class="pc-empty pc-empty--center">
              Questions are available for transcript plans after the plan message is saved.
            </p>
          </div>
        } @else {
          <div
            #messagesRef
            class="pc-messages"
            aria-live="polite"
            aria-label="Plan questions"
            (scroll)="onMessagesScroll()"
          >
            @if (loading()) {
              <div class="pc-skeleton" aria-label="Loading plan questions">
                <span></span>
                <span></span>
                <span></span>
              </div>
            } @else if (!visibleItems().length) {
              <div class="pc-empty pc-empty--center">
                <span class="pc-empty__icon" aria-hidden="true">
                  <ng-icon name="lucideMessageSquare" size="16" />
                </span>
                <p>Ask a focused question about the reviewed plan.</p>
              </div>
            } @else {
              @for (item of visibleItems(); track item.id) {
                <article class="pc-message" [attr.data-kind]="item.kind">
                  @if (item.kind === 'assistant') {
                    <div class="pc-md" [innerHTML]="itemContent(item) | cwMarkdown"></div>
                  } @else {
                    <p>{{ itemContent(item) }}</p>
                  }
                </article>
              }

              @if (runPhase() === 'running' || sending()) {
                <div class="pc-running" aria-label="Generating response">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              }
            }
          </div>

          <div class="pc-footer">
            @if (lastError(); as error) {
              <p class="pc-error" role="alert">{{ error }}</p>
            }

            <form
              class="pc-compose"
              (submit)="$event.preventDefault(); sendQuestion(activeReview)"
            >
              <div class="pc-field">
                <textarea
                  rows="2"
                  placeholder="Ask a question about the plan…"
                  [disabled]="sending() || resetting()"
                  [ngModel]="draft()"
                  name="plan-chat-question"
                  (ngModelChange)="draft.set($event)"
                  (keydown)="onComposeKeydown($event, activeReview)"
                ></textarea>
                <div class="pc-compose__actions">
                  @if (canInterrupt()) {
                    <button type="button" class="pc-btn pc-btn--ghost" (click)="interrupt()">
                      <ng-icon name="lucideSquare" size="12" />
                      Stop
                    </button>
                  }
                  <button
                    type="submit"
                    class="pc-btn pc-btn--primary"
                    [disabled]="!draft().trim() || sending() || resetting()"
                  >
                    <ng-icon name="lucideSend" size="13" />
                    Ask
                  </button>
                </div>
              </div>
              <p class="pc-hint">
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
              </p>
            </form>
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        min-height: 0;
        flex-direction: column;
      }

      .pc-panel {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
      }

      .pc-head {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
        padding: 0.6rem 0.75rem;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 62%, transparent);
      }

      .pc-head__copy {
        min-width: 0;
      }

      .pc-eyebrow {
        display: block;
        color: var(--muted-foreground);
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        line-height: 1.2;
        text-transform: uppercase;
      }

      h3,
      p {
        margin: 0;
      }

      h3 {
        color: var(--foreground);
        font-size: 0.85rem;
        font-weight: 700;
        line-height: 1.25;
      }

      .pc-body {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        padding: 0.75rem;
      }

      .pc-messages {
        display: flex;
        min-height: 0;
        flex: 1;
        flex-direction: column;
        gap: 0.55rem;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 0.75rem;
        scroll-behavior: smooth;
      }

      .pc-message {
        max-width: 90%;
        border: 1px solid var(--border);
        border-radius: 0.7rem;
        padding: 0.55rem 0.7rem;
        color: var(--foreground);
        font-size: 0.8rem;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .pc-message[data-kind='user'] {
        align-self: flex-end;
        border-color: color-mix(in oklab, var(--primary) 26%, var(--border));
        border-bottom-right-radius: 0.2rem;
        background: color-mix(in oklab, var(--primary) 10%, var(--card));
        white-space: pre-wrap;
      }

      .pc-message[data-kind='assistant'] {
        align-self: flex-start;
        border-bottom-left-radius: 0.2rem;
        background: var(--card);
      }

      .pc-message[data-kind='error'] {
        align-self: stretch;
        max-width: 100%;
        border-color: color-mix(in oklab, var(--destructive) 38%, var(--border));
        background: color-mix(in oklab, var(--destructive) 8%, var(--background));
        color: var(--destructive);
      }

      .pc-md :first-child {
        margin-top: 0;
      }

      .pc-md :last-child {
        margin-bottom: 0;
      }

      .pc-md p,
      .pc-md ul,
      .pc-md ol {
        margin: 0.45rem 0;
      }

      .pc-md ul,
      .pc-md ol {
        padding-left: 1.1rem;
      }

      .pc-empty,
      .pc-error {
        border-radius: 0.55rem;
        color: var(--muted-foreground);
        font-size: 0.78rem;
        line-height: 1.45;
      }

      .pc-empty--center {
        display: flex;
        min-height: 8rem;
        flex: 1;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin: auto 0;
        color: var(--muted-foreground);
        text-align: center;
      }

      .pc-empty--center p {
        max-width: 15rem;
      }

      .pc-empty__icon {
        display: inline-flex;
        width: 2.25rem;
        height: 2.25rem;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: color-mix(in oklab, var(--muted) 58%, transparent);
        color: var(--primary);
      }

      .pc-footer {
        display: flex;
        flex-shrink: 0;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.65rem 0.75rem 0.75rem;
        border-top: 1px solid color-mix(in oklab, var(--border) 62%, transparent);
        background: color-mix(in oklab, var(--card) 38%, transparent);
      }

      .pc-error {
        border: 1px solid color-mix(in oklab, var(--destructive) 36%, var(--border));
        background: color-mix(in oklab, var(--destructive) 8%, var(--background));
        color: var(--destructive);
        padding: 0.5rem 0.6rem;
      }

      .pc-compose {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }

      .pc-field {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        border: 1px solid var(--input);
        border-radius: 0.65rem;
        background: var(--background);
        padding: 0.5rem;
        transition:
          border-color 140ms ease,
          box-shadow 140ms ease;
      }

      .pc-field:focus-within {
        border-color: color-mix(in oklab, var(--primary) 66%, var(--input));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 16%, transparent);
      }

      textarea {
        width: 100%;
        max-height: 9rem;
        min-height: 2.6rem;
        resize: none;
        border: 0;
        background: transparent;
        color: var(--foreground);
        font: inherit;
        font-size: 0.8rem;
        line-height: 1.5;
        padding: 0.15rem 0.2rem;
      }

      textarea:focus {
        outline: none;
      }

      textarea::placeholder {
        color: var(--muted-foreground);
      }

      .pc-compose__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      .pc-hint {
        color: var(--muted-foreground);
        font-size: 0.66rem;
        line-height: 1.2;
        text-align: right;
      }

      .pc-hint kbd {
        border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
        border-radius: 0.25rem;
        background: color-mix(in oklab, var(--muted) 48%, transparent);
        color: var(--muted-foreground);
        font-family: inherit;
        font-size: 0.62rem;
        padding: 0.02rem 0.28rem;
      }

      .pc-btn,
      .pc-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          color 140ms ease,
          opacity 140ms ease;
      }

      .pc-btn {
        gap: 0.38rem;
        min-height: 2rem;
        border-radius: 0.5rem;
        padding: 0 0.85rem;
        font-size: 0.78rem;
        font-weight: 700;
      }

      .pc-icon-btn {
        width: 1.85rem;
        height: 1.85rem;
        flex-shrink: 0;
        border-radius: 0.45rem;
        padding: 0;
        color: var(--muted-foreground);
      }

      .pc-btn--primary {
        border-color: var(--primary);
        background: var(--primary);
        color: var(--primary-foreground);
      }

      .pc-btn--ghost:hover:not(:disabled),
      .pc-icon-btn:hover:not(:disabled),
      .pc-btn--ghost:focus-visible,
      .pc-icon-btn:focus-visible {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 42%, var(--border));
        background: color-mix(in oklab, var(--primary) 8%, var(--background));
        color: var(--foreground);
      }

      .pc-btn--primary:hover:not(:disabled),
      .pc-btn--primary:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 88%, var(--foreground));
      }

      .pc-btn:focus-visible,
      .pc-icon-btn:focus-visible {
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 18%, transparent);
      }

      button:disabled,
      textarea:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .pc-skeleton,
      .pc-running {
        display: flex;
        flex-shrink: 0;
        gap: 0.28rem;
        padding: 0.35rem 0.2rem;
      }

      .pc-skeleton {
        flex-direction: column;
      }

      .pc-skeleton span {
        height: 0.65rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        animation: pc-pulse 900ms ease-in-out infinite alternate;
      }

      .pc-skeleton span:nth-child(1) {
        width: 88%;
      }

      .pc-skeleton span:nth-child(2) {
        width: 70%;
      }

      .pc-skeleton span:nth-child(3) {
        width: 48%;
      }

      .pc-running {
        align-self: flex-start;
      }

      .pc-running span {
        width: 0.38rem;
        height: 0.38rem;
        border-radius: 999px;
        background: var(--muted-foreground);
        animation: pc-bounce 800ms ease-in-out infinite;
      }

      .pc-running span:nth-child(2) {
        animation-delay: 100ms;
      }

      .pc-running span:nth-child(3) {
        animation-delay: 200ms;
      }

      @keyframes pc-pulse {
        to {
          opacity: 0.45;
        }
      }

      @keyframes pc-bounce {
        50% {
          transform: translateY(-0.18rem);
          opacity: 0.45;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .pc-messages {
          scroll-behavior: auto;
        }

        .pc-skeleton span,
        .pc-running span {
          animation: none;
        }
      }
    `,
  ],
})
export class PlanChatPanelComponent {
  readonly review = input<PlanReviewRequest | null>(null);

  private readonly messagesRef = viewChild<ElementRef<HTMLElement>>('messagesRef');

  private readonly planChats = inject(PlanChatService);
  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly currentChat = signal<PlanChatFork | null>(null);
  readonly loading = signal(false);
  readonly sending = signal(false);
  readonly resetting = signal(false);
  readonly draft = signal('');
  readonly historyItems = signal<ClaudeTranscriptItem[]>([]);
  readonly liveItems = signal<ClaudeTranscriptItem[]>([]);
  readonly optimisticUserItems = signal<PlanChatVisibleItem[]>([]);
  readonly runPhase = signal<ClaudeRunPhase>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);

  readonly visibleItems = computed<PlanChatVisibleItem[]>(() => {
    const items = [
      ...this.historyItems(),
      ...this.optimisticUserItems(),
      ...this.liveItems(),
    ]
      .filter(
        (item): item is PlanChatVisibleItem =>
          item.kind === 'user' || item.kind === 'assistant' || item.kind === 'error',
      )
      .sort((left, right) => (left.timestamp || '').localeCompare(right.timestamp || ''));

    // The forked child session carries the entire original plan conversation as
    // history. Only the Q&A exchange belongs in this panel, so drop everything
    // before the first asked question (optimistic or wrapped-in-history).
    const firstQuestion = items.findIndex((item) => this.isPlanQuestion(item));
    return firstQuestion < 0 ? [] : items.slice(firstQuestion);
  });

  private loadedReviewKey = '';
  private connectedSessionId: number | null = null;
  private connectedProvider: AgentProviderId | null = null;

  constructor() {
    effect(() => {
      const review = this.review();
      const key = review ? `${review.sessionId}:${review.reviewId}` : '';
      if (key === this.loadedReviewKey) return;
      this.loadedReviewKey = key;
      this.resetLocalState();
      if (review) {
        void this.loadExistingChat(review);
      }
    });

    // Keep the conversation pinned to the latest message as content streams in,
    // but only when the user is already at the bottom so reading history is not
    // interrupted.
    effect(() => {
      this.visibleItems();
      this.runPhase();
      this.sending();
      if (!this.stickToBottom) return;
      const el = this.messagesRef()?.nativeElement;
      if (!el) return;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });

    this.destroyRef.onDestroy(() => this.disconnectCurrent());
  }

  private stickToBottom = true;

  onMessagesScroll(): void {
    const el = this.messagesRef()?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.stickToBottom = distanceFromBottom < 48;
  }

  private isPlanQuestion(item: PlanChatVisibleItem): boolean {
    return (
      item.kind === 'user' &&
      (item.id.startsWith('plan-chat-opt-') || QUESTION_RE.test(item.content ?? ''))
    );
  }

  onComposeKeydown(event: KeyboardEvent, review: PlanReviewRequest): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.sendQuestion(review);
    }
  }

  canAsk(review: PlanReviewRequest): boolean {
    return Boolean(
      (review.anchorMessageId && review.anchorMessageKind) ||
      (review.source === 'exit-plan-permission' && review.planMarkdown.trim()),
    );
  }

  itemContent(item: PlanChatVisibleItem): string {
    if (item.kind === 'user') {
      return sanitizePlanChatUserContent(item.content);
    }
    return item.content?.trim() || '';
  }

  async sendQuestion(review: PlanReviewRequest): Promise<void> {
    const question = this.draft().trim();
    if (!question || this.sending() || this.resetting() || !this.canAsk(review)) {
      return;
    }

    const optimistic: PlanChatVisibleItem = {
      id: `plan-chat-opt-${Date.now()}`,
      kind: 'user',
      content: question,
      timestamp: new Date().toISOString(),
      authoredAt: new Date().toISOString(),
    };
    this.stickToBottom = true;
    this.optimisticUserItems.update((items) => [...items, optimistic]);
    this.draft.set('');
    this.sending.set(true);
    this.lastError.set(null);

    try {
      const chat = await this.ensureChat(review);
      await firstValueFrom(this.planChats.submitQuestion(review.sessionId, chat.id, { question }));
    } catch (error) {
      this.optimisticUserItems.update((items) => items.filter((item) => item.id !== optimistic.id));
      this.draft.set(question);
      this.lastError.set(this.httpErrorMessage(error, 'Could not ask about this plan.'));
    } finally {
      this.sending.set(false);
    }
  }

  interrupt(): void {
    const chat = this.currentChat();
    if (!chat?.childSessionId) return;
    this.ws.send(chat.childSessionId, { type: 'interrupt' }, chat.provider);
  }

  async startFresh(review: PlanReviewRequest): Promise<void> {
    const chat = this.currentChat();
    if (!chat || this.resetting()) return;
    this.resetting.set(true);
    try {
      await firstValueFrom(this.planChats.delete(review.sessionId, chat.id));
      this.disconnectCurrent();
      this.resetLocalState(false);
    } catch (error) {
      toast.error(this.httpErrorMessage(error, 'Could not reset plan Q&A.'));
    } finally {
      this.resetting.set(false);
    }
  }

  private async loadExistingChat(review: PlanReviewRequest): Promise<void> {
    if (!this.canAsk(review)) return;
    this.loading.set(true);
    const key = this.loadedReviewKey;
    try {
      const chats = await firstValueFrom(
        this.planChats.getByReview(review.sessionId, review.reviewId),
      );
      if (key !== this.loadedReviewKey) return;
      const chat = chats.find((candidate) => candidate.childSession) ?? null;
      this.currentChat.set(chat);
      if (chat?.childSessionId) {
        this.connectToChat(chat);
      }
    } catch {
      if (key === this.loadedReviewKey) {
        this.currentChat.set(null);
      }
    } finally {
      if (key === this.loadedReviewKey) {
        this.loading.set(false);
      }
    }
  }

  private async ensureChat(review: PlanReviewRequest): Promise<PlanChatFork> {
    const existing = this.currentChat();
    if (existing?.childSession) return existing;
    if (!this.canAsk(review)) {
      throw new Error('This plan cannot be forked for questions yet.');
    }

    const response = await firstValueFrom(
      this.planChats.ensure(review.sessionId, {
        reviewId: review.reviewId,
        reviewSource: review.source,
        anchorMessageId: review.anchorMessageId,
        anchorMessageKind: review.anchorMessageKind,
        permissionRequestId: review.requestId,
        toolUseId: review.toolUseId,
        planMarkdown: review.planMarkdown,
      }),
    );
    this.currentChat.set(response.planChat);
    this.connectToChat(response.planChat);
    return response.planChat;
  }

  private connectToChat(chat: PlanChatFork): void {
    if (
      this.connectedSessionId === chat.childSessionId &&
      this.connectedProvider === chat.provider
    ) {
      this.hydrateChat(chat);
      return;
    }

    this.disconnectCurrent();
    this.connectedSessionId = chat.childSessionId;
    this.connectedProvider = chat.provider;
    this.ws
      .connect(chat.childSessionId, chat.provider)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleRuntimeEvent(event as ClaudeRuntimeEvent));
    this.hydrateChat(chat);
  }

  private hydrateChat(chat: PlanChatFork): void {
    this.ws.send(chat.childSessionId, { type: 'hydrate' }, chat.provider);
  }

  private disconnectCurrent(): void {
    if (this.connectedSessionId !== null && this.connectedProvider) {
      this.ws.disconnect(this.connectedSessionId, this.connectedProvider);
    }
    this.connectedSessionId = null;
    this.connectedProvider = null;
  }

  private handleRuntimeEvent(event: ClaudeRuntimeEvent): void {
    switch (event.type) {
      case 'session_snapshot':
        this.historyItems.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        this.applyRuntimeState(event.payload);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.historyItems.set(event.payload.history ?? []);
        this.reconcileOptimistic(event.payload.history ?? []);
        return;
      case 'run_state':
        this.runPhase.set(event.payload.runPhase);
        this.canInterrupt.set(event.payload.canInterrupt);
        this.lastError.set(event.payload.lastError);
        if (event.payload.runPhase !== 'running') {
          this.sending.set(false);
        }
        return;
      case 'message_start':
        this.upsertLiveItem(event.payload.item);
        return;
      case 'message_delta':
        this.appendDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'error':
        this.lastError.set(event.payload.message);
        this.sending.set(false);
        return;
      case 'complete':
        this.runPhase.set('idle');
        this.canInterrupt.set(false);
        this.sending.set(false);
        void this.refreshHistory();
        return;
      default:
        return;
    }
  }

  private applyRuntimeState(state: any): void {
    this.liveItems.set(state.liveItems ?? []);
    this.runPhase.set(state.runPhase ?? 'idle');
    this.canInterrupt.set(Boolean(state.canInterrupt));
    this.lastError.set(state.lastError ?? null);
  }

  private upsertLiveItem(item: ClaudeTranscriptItem): void {
    this.liveItems.update((items) => [
      ...items.filter((existing) => existing.id !== item.id),
      item,
    ]);
  }

  private appendDelta(itemId: string, delta: string): void {
    this.liveItems.update((items) =>
      items.map((item) =>
        item.id === itemId ? { ...item, content: `${item.content ?? ''}${delta}` } : item,
      ),
    );
  }

  private async refreshHistory(): Promise<void> {
    const chat = this.currentChat();
    if (!chat) return;
    const history = (await firstValueFrom(
      this.agentApi.getHistory(chat.childSessionId, chat.provider),
    )) as ClaudeTranscriptItem[];
    this.historyItems.set(history);
    this.reconcileOptimistic(history);
    this.liveItems.set([]);
  }

  private reconcileOptimistic(history: ClaudeTranscriptItem[]): void {
    const historicalQuestions = new Set(
      history
        .filter((item) => item.kind === 'user')
        .map((item) => sanitizePlanChatUserContent(item.content)),
    );
    this.optimisticUserItems.update((items) =>
      items.filter((item) => !historicalQuestions.has(sanitizePlanChatUserContent(item.content))),
    );
  }

  private resetLocalState(clearDraft = true): void {
    this.disconnectCurrent();
    this.currentChat.set(null);
    this.loading.set(false);
    this.sending.set(false);
    this.historyItems.set([]);
    this.liveItems.set([]);
    this.optimisticUserItems.set([]);
    this.runPhase.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
    if (clearDraft) {
      this.draft.set('');
    }
  }

  private httpErrorMessage(error: unknown, fallback: string): string {
    return (
      (error as { error?: { message?: string } })?.error?.message ||
      (error instanceof Error ? error.message : null) ||
      fallback
    );
  }
}
