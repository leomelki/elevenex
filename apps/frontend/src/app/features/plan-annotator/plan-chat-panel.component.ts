import { AgentChatConnection } from '@/shared/agent-chat/agent-chat-connection';
import { AgentConversation } from '@/shared/agent-chat/agent-conversation';
import {
  ClaudeComposerComponent,
  ComposerSendPayload,
} from '@/shared/agent-chat/composer/claude-composer.component';
import { ClaudePermissionInlineComponent } from '@/shared/agent-chat/requests/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/shared/agent-chat/requests/claude-user-input.component';
import { ClaudeTranscriptComponent } from '@/shared/agent-chat/transcript/claude-transcript.component';
import { copyChatMessage } from '@/shared/agent-chat/transcript/message-clipboard';
import type { AgentPermissionApproval, AgentProviderId } from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import { PlanReviewRequest } from '@/shared/models/plan-review.model';
import type { PlanChatFork } from '@/shared/models/session.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMessageSquare, lucideRefreshCw } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { firstValueFrom } from 'rxjs';
import { PlanChatService } from './plan-chat.service';

const QUESTION_RE = /<elevenex_plan_question>\s*([\s\S]*?)\s*<\/elevenex_plan_question>/i;

export function sanitizePlanChatUserContent(content: string | null | undefined): string {
  const text = content ?? '';
  const match = QUESTION_RE.exec(text);
  return (match?.[1] ?? text).trim();
}

@Component({
  selector: 'app-plan-chat-panel',
  standalone: true,
  imports: [
    CommonModule,
    ClaudeTranscriptComponent,
    ClaudeComposerComponent,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    NgIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideMessageSquare,
      lucideRefreshCw,
    }),
  ],
  templateUrl: './plan-chat-panel.component.html',
  styleUrl: './plan-chat-panel.component.scss',
})
export class PlanChatPanelComponent {
  readonly review = input<PlanReviewRequest | null>(null);
  readonly openLocalFile = output<LocalFileTarget>();
  readonly copyMessage = copyChatMessage;
  readonly expandedTurns = signal<Record<string, boolean>>({});
  readonly expandedTurnChanges = signal<Record<string, boolean>>({});

  private readonly messagesRef = viewChild<ElementRef<HTMLElement>>('messagesRef');

  private readonly planChats = inject(PlanChatService);
  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = new AgentChatConnection(this.ws, this.agentApi);

  readonly conversation = new AgentConversation({
    sanitizeUserContent: sanitizePlanChatUserContent,
    isOwnPrompt: (item) => QUESTION_RE.test(item.content ?? ''),
  });
  readonly currentChat = signal<PlanChatFork | null>(null);
  readonly loading = signal(false);
  readonly sending = signal(false);
  readonly resetting = signal(false);
  readonly draft = signal('');
  readonly runPhase = this.conversation.runPhase;
  readonly canInterrupt = this.conversation.canInterrupt;
  readonly lastError = this.conversation.lastError;

  private loadedReviewKey = '';
  private reviewVersion = 0;
  private connectedSessionId: number | null = null;
  private connectedProvider: AgentProviderId | null = null;

  constructor() {
    effect(() => {
      const review = this.review();
      const key = review ? `${review.sessionId}:${review.reviewId}` : '';
      if (key === this.loadedReviewKey) return;
      this.loadedReviewKey = key;
      this.reviewVersion += 1;
      this.resetLocalState();
      if (review) {
        void this.loadExistingChat(review);
      }
    });

    // Keep the conversation pinned to the latest message as content streams in,
    // but only when the user is already at the bottom so reading history is not
    // interrupted.
    effect(() => {
      this.conversation.renderItems();
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

  canAsk(review: PlanReviewRequest): boolean {
    return Boolean(
      (review.anchorMessageId && review.anchorMessageKind) ||
      (review.source === 'exit-plan-permission' && review.planMarkdown.trim()),
    );
  }

  async sendQuestion(review: PlanReviewRequest): Promise<void> {
    const question = this.draft().trim();
    if (!question || this.loading() || this.sending() || this.resetting() || !this.canAsk(review)) {
      return;
    }

    const optimistic = this.conversation.addOptimisticPrompt(question);
    this.stickToBottom = true;
    const version = this.reviewVersion;
    this.draft.set('');
    this.sending.set(true);
    this.lastError.set(null);

    try {
      const chat = await this.ensureChat(review);
      if (version !== this.reviewVersion || this.destroyRef.destroyed) return;
      await firstValueFrom(this.planChats.submitQuestion(review.sessionId, chat.id, { question }));
    } catch (error) {
      if (version !== this.reviewVersion || this.destroyRef.destroyed) return;
      this.conversation.removeOptimistic(optimistic.id);
      this.draft.update((draft) => (draft.trim() ? draft : question));
      this.lastError.set(this.httpErrorMessage(error, 'Could not ask about this plan.'));
    } finally {
      if (version === this.reviewVersion && !this.destroyRef.destroyed) this.sending.set(false);
    }
  }

  submit(payload: ComposerSendPayload, review: PlanReviewRequest): void {
    this.draft.set(payload.text);
    void this.sendQuestion(review);
  }

  toggleTurn(id: string): void {
    this.expandedTurns.update((state) => ({ ...state, [id]: !state[id] }));
  }
  toggleTurnChanges(id: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [id]: !state[id] }));
  }
  closeTurnChanges(id: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [id]: false }));
  }
  cancelPending(id: string): void {
    this.runtime.send({ type: 'cancel_pending_prompt', id });
  }
  steerPending(id: string): void {
    this.runtime.send({ type: 'steer_pending_prompt', id });
  }
  resumePending(): void {
    this.runtime.send({ type: 'resume_pending_prompts' });
  }
  clearPending(): void {
    this.runtime.send({ type: 'clear_pending_prompts' });
  }

  approvePermission(approval: AgentPermissionApproval): void {
    const request = this.conversation.pendingPermissionRequest();
    if (request)
      this.runtime.send({ type: 'approve_permission', requestId: request.requestId, ...approval });
  }
  denyPermission(message?: string): void {
    const request = this.conversation.pendingPermissionRequest();
    if (request)
      this.runtime.send({ type: 'deny_permission', requestId: request.requestId, message });
  }
  answerUserInput(payload: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }): void {
    const request = this.conversation.pendingUserInputRequest();
    if (request)
      this.runtime.send({ type: 'answer_user_input', requestId: request.requestId, ...payload });
  }

  interrupt(): void {
    const chat = this.currentChat();
    if (!chat?.childSessionId) return;
    this.ws.send(chat.childSessionId, { type: 'interrupt' }, chat.provider);
  }

  async startFresh(review: PlanReviewRequest): Promise<void> {
    const chat = this.currentChat();
    if (!chat || this.sending() || this.resetting()) return;
    const version = this.reviewVersion;
    this.resetting.set(true);
    try {
      await firstValueFrom(this.planChats.delete(review.sessionId, chat.id));
      if (version !== this.reviewVersion || this.destroyRef.destroyed) return;
      this.disconnectCurrent();
      this.resetLocalState(false);
    } catch (error) {
      if (version !== this.reviewVersion || this.destroyRef.destroyed) return;
      toast.error(this.httpErrorMessage(error, 'Could not reset plan Q&A.'));
    } finally {
      if (version === this.reviewVersion && !this.destroyRef.destroyed) this.resetting.set(false);
    }
  }

  private async loadExistingChat(review: PlanReviewRequest): Promise<void> {
    if (!this.canAsk(review)) return;
    this.loading.set(true);
    const version = this.reviewVersion;
    try {
      const chats = await firstValueFrom(
        this.planChats.getByReview(review.sessionId, review.reviewId),
      );
      if (version !== this.reviewVersion || this.destroyRef.destroyed) return;
      const chat = chats.find((candidate) => candidate.childSession) ?? null;
      this.currentChat.set(chat);
      if (chat?.childSessionId) {
        this.connectToChat(chat);
      }
    } catch {
      if (version === this.reviewVersion && !this.destroyRef.destroyed) {
        this.currentChat.set(null);
      }
    } finally {
      if (version === this.reviewVersion && !this.destroyRef.destroyed) {
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

    const version = this.reviewVersion;
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
    if (version !== this.reviewVersion || this.destroyRef.destroyed)
      throw new Error('Plan conversation changed.');
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
    this.runtime.attach(
      { sessionId: chat.childSessionId, provider: chat.provider },
      this.conversation,
    );
  }

  private hydrateChat(chat: PlanChatFork): void {
    this.ws.send(chat.childSessionId, { type: 'hydrate' }, chat.provider);
  }

  private disconnectCurrent(): void {
    this.runtime.detach();
    this.connectedSessionId = null;
    this.connectedProvider = null;
  }

  private resetLocalState(clearDraft = true): void {
    this.conversation.reset();
    this.expandedTurns.set({});
    this.expandedTurnChanges.set({});
    this.disconnectCurrent();
    this.currentChat.set(null);
    this.loading.set(false);
    this.sending.set(false);
    this.resetting.set(false);
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
