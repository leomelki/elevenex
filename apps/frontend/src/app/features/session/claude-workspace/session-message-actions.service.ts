import {
  PlanFeedbackPayload,
  PlanReviewRequest,
  isSamePlanReview,
  planReviewFromPermissionRequest,
  planReviewFromTranscriptItem,
} from '@/features/plan-annotator';
import { ClaudeSubagentHistoryState } from '@/shared/agent-chat/activity/claude-agent-inspector.component';
import { type TranscriptMessageAffordances } from '@/shared/agent-chat/transcript/claude-transcript.component';
import { copyChatMessage } from '@/shared/agent-chat/transcript/message-clipboard';
import { TranscriptRenderItem } from '@/shared/agent-chat/transcript/transcript-render-items';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import {
  ClaudePermissionRequest,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import type { CreateSessionForkResponse, SessionFork } from '@/shared/models/session.model';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { parseDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { toast } from 'ngx-sonner';
import { Subject, firstValueFrom } from 'rxjs';
import { SessionDraftContext } from './session-draft-context.service';
import { SessionRuntime } from './session-runtime.service';
import { getHttpErrorMessage } from './workspace-error';

const EMPTY_FORKS: readonly SessionFork[] = [];

@Injectable()
export class SessionMessageActions {
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly sessionsService = inject(SessionsService);
  private readonly destroyRef = inject(DestroyRef);
  readonly runtime = inject(SessionRuntime);
  readonly draft = inject(SessionDraftContext);
  readonly focusRequested = new Subject<void>();

  readonly planReviewRequested = new Subject<PlanReviewRequest>();

  readonly planQuestionRequested = new Subject<PlanReviewRequest>();

  readonly planReviewClosed = new Subject<PlanReviewRequest>();

  readonly conversationForkCreated = new Subject<CreateSessionForkResponse>();

  readonly conversationForkOpened = new Subject<SessionFork>();

  private readonly reviewChats = inject(ReviewChatsService);

  /** Review discussions started from this session, grouped by their turn. */
  readonly reviewThreads = signal<readonly ReviewChat[]>([]);

  readonly unreadReviewThreadIds = signal<ReadonlySet<number>>(new Set<number>());

  readonly expandedTurns = signal<Record<string, boolean>>({});

  readonly expandedTurnChanges = signal<Record<string, boolean>>({});

  readonly armedEditMessageId = signal<string | null>(null);

  readonly rewindingMessageId = signal<string | null>(null);

  readonly forks = signal<SessionFork[]>([]);

  readonly expandedForkAnchors = signal<Record<string, boolean>>({});

  readonly forkingAnchorId = signal<string | null>(null);

  readonly agentInspectorTurnId = signal<string | null>(null);

  readonly agentInspectorSelectedAgentId = signal<string | null>(null);

  readonly agentHistoryById = signal<Record<string, ClaudeSubagentHistoryState>>({});

  readonly messageActionsDisabled = computed(
    () =>
      this.runtime.readOnlyTranscript ||
      this.runtime.archived ||
      this.runtime.loading() ||
      this.runtime.submitting() ||
      this.runtime.runPhase() !== 'idle' ||
      !!this.runtime.pendingPermissionRequest() ||
      !!this.runtime.pendingUserInputRequest() ||
      this.rewindingMessageId() !== null,
  );

  readonly forkActionsDisabled = computed(
    () =>
      this.runtime.readOnlyTranscript || this.runtime.loading() || this.forkingAnchorId() !== null,
  );

  readonly forkDisabledReason = computed(() => {
    if (this.runtime.readOnlyTranscript) return 'Forks are not available in terminal mirror mode.';
    if (this.forkingAnchorId()) return 'A fork is already being created.';
    if (this.runtime.loading()) return 'Transcript is still loading.';
    return '';
  });

  readonly forksByAnchor = computed(() => {
    const grouped: Record<string, SessionFork[]> = {};
    for (const fork of this.forks()) {
      grouped[fork.anchorMessageId] = [...(grouped[fork.anchorMessageId] ?? []), fork];
    }
    return grouped;
  });

  readonly reviewThreadsByTurnId = computed(() => {
    const grouped: Record<string, ReviewChat[]> = {};
    for (const thread of this.reviewThreads()) {
      if (!thread.turnKey || thread.status === 'resolved') continue;
      grouped[thread.turnKey] = [...(grouped[thread.turnKey] ?? []), thread];
    }
    return grouped;
  });

  /**
   * Per-message capabilities handed to the transcript view. Arrow properties so
   * the object identity stays stable while each lookup still reads live state.
   */
  readonly turnExpansion = computed(() => ({
    turns: this.expandedTurns(),
    changes: this.expandedTurnChanges(),
  }));
  readonly turnReviews = computed(() => ({
    threads: this.reviewThreadsByTurnId(),
    unreadIds: this.unreadReviewThreadIds(),
  }));

  readonly messageAffordances: TranscriptMessageAffordances = {
    canCopy: (item) => this.canCopyMessage(item),
    canEdit: (item) => this.canEditMessage(item),
    canFork: (item) => this.canForkMessage(item),
    isForking: (item) => this.isForkingItem(item),
    isEditArmed: (item) => this.isEditArmed(item),
    forks: (item) => this.forksForItem(item),
    forksExpanded: (item) => this.forksExpandedForItem(item),
    canReviewPlan: (item) => this.canReviewPlan(item),
    planReview: (item) => this.planReviewForMessage(item),
    actionsDisabled: () => this.messageActionsDisabled(),
    forkDisabled: () => this.forkActionsDisabled(),
    forkDisabledReason: () => this.forkDisabledReason(),
  };

  private planReviews = new WeakMap<
    ClaudeTranscriptItem,
    { sessionId: number; provider: AgentProviderId; review: PlanReviewRequest | null }
  >();

  readonly latestPlanReview = computed(() => {
    const permissionReview = this.planReviewForPermission(this.runtime.pendingPermissionRequest());
    if (permissionReview) return permissionReview;

    const items = this.runtime.transcriptItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const review = this.parsedPlanReview(items[i]);
      if (review) return review;
    }
    return null;
  });

  readonly selectedAgentInspectorTurn = computed(() => {
    const turnId = this.agentInspectorTurnId();
    if (!turnId) return null;
    const item = this.runtime
      .renderItems()
      .find(
        (entry): entry is Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> =>
          entry.kind === 'collapsed-turn' && entry.turnId === turnId,
      );
    return item?.agentSummary ?? null;
  });

  readonly copyMessage = copyChatMessage;
  constructor() {
    this.runtime.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      switch (event.type) {
        case 'reset':
          this.reset();
          break;
        case 'load-actions':
          void this.loadForks();
          void this.loadReviewThreads();
          break;
        case 'prompt-submitted':
          this.cancelArmedEdit();
          break;
      }
    });
  }
  reset(): void {
    this.planReviews = new WeakMap();
    this.reviewThreads.set([]);
    this.unreadReviewThreadIds.set(new Set());
    this.expandedTurns.set({});

    this.expandedTurnChanges.set({});

    this.armedEditMessageId.set(null);

    this.rewindingMessageId.set(null);

    this.forks.set([]);

    this.expandedForkAnchors.set({});

    this.forkingAnchorId.set(null);

    this.closeAgentInspector();

    this.agentHistoryById.set({});
  }

  private parsedPlanReview(item: ClaudeTranscriptItem): PlanReviewRequest | null {
    const sessionId = this.runtime.sessionId;
    const provider = this.runtime.currentProvider();
    const cached = this.planReviews.get(item);
    if (cached?.sessionId === sessionId && cached.provider === provider) return cached.review;
    const review = planReviewFromTranscriptItem(item, sessionId, provider);
    this.planReviews.set(item, { sessionId, provider, review });
    return review;
  }

  canReviewPlan(item: ClaudeTranscriptItem): boolean {
    if (this.runtime.isTranscriptReadOnly()) return false;
    const review = this.planReviewForMessage(item);
    if (!review) return false;
    if (this.runtime.runPhase() !== 'idle' || this.runtime.submitting()) return false;
    if (review.provider === 'codex' || review.provider === 'opencode') {
      return this.runtime.planMode();
    }
    return !review.readonly;
  }

  planReviewForMessage(item: ClaudeTranscriptItem): PlanReviewRequest | null {
    if (this.runtime.isStreamingMessage(item.id)) return null;
    const review = this.parsedPlanReview(item);
    if (!review) return null;
    const latest = this.latestPlanReview();
    return isSamePlanReview(review, latest) ? review : null;
  }

  planReviewForPermission(req: ClaudePermissionRequest | null): PlanReviewRequest | null {
    return planReviewFromPermissionRequest(
      req,
      this.runtime.sessionId,
      this.runtime.currentProvider(),
    );
  }

  openPlanReview(review: PlanReviewRequest): void {
    this.planReviewRequested.next(review);
  }

  openPlanQuestion(review: PlanReviewRequest): void {
    this.planQuestionRequested.next(review);
  }

  openPermissionPlanReview(req: ClaudePermissionRequest): void {
    const review = this.planReviewForPermission(req);
    if (review) this.openPlanReview(review);
  }

  async approvePlanReview(review: PlanReviewRequest): Promise<void> {
    if (
      this.runtime.isTranscriptReadOnly() ||
      review.sessionId !== this.runtime.sessionId ||
      review.readonly
    )
      return;
    if (review.source === 'exit-plan-permission') {
      this.approvePlanPermissionReview(review);
      return;
    }
    if (
      (review.provider !== 'codex' && review.provider !== 'opencode') ||
      this.runtime.runPhase() !== 'idle' ||
      this.runtime.submitting()
    )
      return;

    const version = this.runtime.bootstrapVersion;
    const sessionId = this.runtime.sessionId;
    try {
      const selectedMode = this.runtime.permissionMode();
      await firstValueFrom(this.api.setPermissionMode(sessionId, selectedMode));
      if (!this.runtime.isCurrentConversation(version)) return;
      const next = await firstValueFrom(this.api.setPlanMode(sessionId, false));
      if (!this.runtime.isCurrentConversation(version)) return;
      this.runtime.applyRuntimeState(next);
      await this.draft.submitPrompt({ text: 'implement plan', images: [] });
      this.planReviewClosed.next(review);
    } catch (error) {
      if (this.runtime.isCurrentConversation(version))
        toast.error(getHttpErrorMessage(error, 'Could not approve the plan.'));
    }
  }

  async sendPlanReviewFeedback(payload: PlanFeedbackPayload): Promise<void> {
    const message = payload.message.trim();
    const review = payload.review;
    if (
      !message ||
      this.runtime.isTranscriptReadOnly() ||
      review.sessionId !== this.runtime.sessionId ||
      review.readonly
    )
      return;

    if (review.source === 'exit-plan-permission') {
      this.denyPlanPermissionReview(review, message);
      this.planReviewClosed.next(review);
      return;
    }

    if (review.provider !== 'codex' && review.provider !== 'opencode') return;
    await this.draft.submitPrompt({ text: message, images: [] });
    this.planReviewClosed.next(review);
  }

  async rejectPlanReview(payload: PlanFeedbackPayload): Promise<void> {
    const review = payload.review;
    if (
      this.runtime.isTranscriptReadOnly() ||
      review.sessionId !== this.runtime.sessionId ||
      review.readonly
    )
      return;

    if (review.source === 'exit-plan-permission') {
      this.denyPlanPermissionReview(review, payload.message);
      this.planReviewClosed.next(review);
      return;
    }

    if (review.provider !== 'codex' && review.provider !== 'opencode') return;
    await this.draft.submitPrompt({ text: payload.message, images: [] });
    this.planReviewClosed.next(review);
  }

  private approvePlanPermissionReview(review: PlanReviewRequest): void {
    const req = this.runtime.pendingPermissionRequest();
    if (!req || req.requestId !== review.requestId) return;
    this.runtime.sendRuntimeAction({
      type: 'approve_permission',
      requestId: req.requestId,
      remember: false,
    });
    this.planReviewClosed.next(review);
  }

  private denyPlanPermissionReview(review: PlanReviewRequest, message: string): void {
    const req = this.runtime.pendingPermissionRequest();
    if (!req || req.requestId !== review.requestId) return;
    this.runtime.sendRuntimeAction({
      type: 'deny_permission',
      requestId: req.requestId,
      message: message.trim() || undefined,
    });
  }

  toggleTurn(turnId: string): void {
    this.expandedTurns.update((state) => ({ ...state, [turnId]: !state[turnId] }));
  }

  toggleTurnChanges(turnId: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [turnId]: !state[turnId] }));
  }

  closeTurnChanges(turnId: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [turnId]: false }));
  }

  openAgentInspector(turnId: string): void {
    const item = this.runtime
      .renderItems()
      .find(
        (entry): entry is Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> =>
          entry.kind === 'collapsed-turn' && entry.turnId === turnId,
      );
    const summary = item?.agentSummary;
    if (!summary?.agents.length) return;

    const firstAgentId = summary.agents[0]?.agentId ?? null;
    this.agentInspectorTurnId.set(turnId);
    this.agentInspectorSelectedAgentId.set(firstAgentId);
    if (firstAgentId) {
      void this.ensureAgentHistory(firstAgentId);
    }
  }

  closeAgentInspector(): void {
    this.agentInspectorTurnId.set(null);
    this.agentInspectorSelectedAgentId.set(null);
  }

  selectAgentInspectorAgent(agentId: string): void {
    this.agentInspectorSelectedAgentId.set(agentId);
    void this.ensureAgentHistory(agentId);
  }

  canCopyMessage(item: ClaudeTranscriptItem): boolean {
    return (item.kind === 'user' || item.kind === 'assistant') && Boolean(item.content?.trim());
  }

  canEditMessage(item: ClaudeTranscriptItem): boolean {
    return (
      !this.runtime.isTranscriptReadOnly() &&
      item.kind === 'user' &&
      !!item.sourceMessageId &&
      (this.runtime.currentProviderInfo()?.capabilities.rewindConversation ?? false)
    );
  }

  canShowMessageActions(item: ClaudeTranscriptItem): boolean {
    return !this.runtime.isTranscriptReadOnly() && item.kind === 'user' && !!item.sourceMessageId;
  }

  canForkMessage(item: ClaudeTranscriptItem): boolean {
    return (
      !this.runtime.readOnlyTranscript &&
      (item.kind === 'user' || item.kind === 'assistant') &&
      !!this.forkAnchorForItem(item) &&
      !this.runtime.isStreamingMessage(item.id)
    );
  }

  forkAnchorForItem(item: ClaudeTranscriptItem): string | null {
    return item.transcriptMessageId ?? null;
  }

  forksForItem(item: ClaudeTranscriptItem): readonly SessionFork[] {
    const anchor = this.forkAnchorForItem(item);
    return anchor ? (this.forksByAnchor()[anchor] ?? EMPTY_FORKS) : EMPTY_FORKS;
  }

  isForkingItem(item: ClaudeTranscriptItem): boolean {
    const anchor = this.forkAnchorForItem(item);
    return !!anchor && this.forkingAnchorId() === anchor;
  }

  forksExpandedForItem(item: ClaudeTranscriptItem): boolean {
    const anchor = this.forkAnchorForItem(item);
    return !!anchor && !!this.expandedForkAnchors()[anchor];
  }

  toggleForksForItem(item: ClaudeTranscriptItem): void {
    const anchor = this.forkAnchorForItem(item);
    if (!anchor) return;
    this.expandedForkAnchors.update((state) => ({
      ...state,
      [anchor]: !state[anchor],
    }));
  }

  async forkMessage(item: ClaudeTranscriptItem): Promise<void> {
    const anchorMessageId = this.forkAnchorForItem(item);
    if (
      !anchorMessageId ||
      (item.kind !== 'user' && item.kind !== 'assistant') ||
      this.forkActionsDisabled()
    ) {
      return;
    }

    const version = this.runtime.bootstrapVersion;
    this.forkingAnchorId.set(anchorMessageId);
    try {
      const response = await firstValueFrom(
        this.sessionsService.createFork(this.runtime.sessionId, {
          anchorMessageId,
          anchorMessageKind: item.kind,
          anchorExcerpt: this.forkExcerptForItem(item),
        }),
      );
      if (!this.runtime.isCurrentConversation(version)) return;
      this.forks.update((forks) => [...forks, response.fork]);
      this.expandedForkAnchors.update((state) => ({
        ...state,
        [anchorMessageId]: true,
      }));
      this.conversationForkCreated.next(response);
      toast.success('Conversation fork created');
    } catch (error) {
      if (this.runtime.isCurrentConversation(version))
        toast.error(getHttpErrorMessage(error, 'Could not create fork.'));
    } finally {
      if (this.runtime.isCurrentConversation(version)) this.forkingAnchorId.set(null);
    }
  }

  openFork(fork: SessionFork): void {
    if (!fork.childSession) return;
    this.conversationForkOpened.next(fork);
  }

  private forkExcerptForItem(item: ClaudeTranscriptItem): string {
    const withoutSessions = parseSessionMentions(item.content).text;
    return parseDiffSelectionMentions(withoutSessions).text.trim().slice(0, 500);
  }

  isEditArmed(item: ClaudeTranscriptItem): boolean {
    return !!item.sourceMessageId && this.armedEditMessageId() === item.sourceMessageId;
  }

  armEditMessage(item: ClaudeTranscriptItem): void {
    if (!item.sourceMessageId || this.messageActionsDisabled()) return;
    this.armedEditMessageId.set(item.sourceMessageId);
  }

  cancelArmedEdit(): void {
    this.armedEditMessageId.set(null);
  }

  async confirmEditMessage(item: ClaudeTranscriptItem): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    try {
      if (!item.sourceMessageId || this.messageActionsDisabled()) return;
      await this.restorePromptFromMessage(item);
      if (this.runtime.isCurrentConversation(version))
        toast.success('Message restored for editing');
    } catch (error) {
      if (!this.runtime.isCurrentConversation(version)) return;
      const message =
        (error as { error?: { message?: string } })?.error?.message ||
        (error instanceof Error ? error.message : null) ||
        'Could not rewind the conversation.';
      toast.error(message);
    }
  }

  private async restorePromptFromMessage(item: ClaudeTranscriptItem): Promise<void> {
    const messageId = item.sourceMessageId;
    const content = item.content ?? '';
    if (!messageId) return;

    const version = this.runtime.bootstrapVersion;
    const sessionId = this.runtime.sessionId;
    this.runtime.beginConversationRewind();
    this.rewindingMessageId.set(messageId);
    try {
      const history = await firstValueFrom(this.api.rewindConversation(sessionId, messageId));
      if (!this.runtime.isCurrentConversation(version)) return;
      const runtimeState = await firstValueFrom(this.api.getRuntimeState(sessionId));

      if (!this.runtime.isCurrentConversation(version)) return;
      this.runtime.restoreRewoundConversation(history, runtimeState);
      this.expandedTurns.set({});
      this.expandedTurnChanges.set({});
      this.draft.restoreMessage(content);
      this.cancelArmedEdit();
      this.closeAgentInspector();
      queueMicrotask(() => this.focusRequested.next());
    } finally {
      this.runtime.endConversationRewind(version);
      if (this.runtime.isCurrentConversation(version)) this.rewindingMessageId.set(null);
    }
  }

  onDocumentMousedown(event: MouseEvent): void {
    if (!this.armedEditMessageId()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-cw-edit-confirm-root]')) return;
    if (target?.closest('[data-cw-edit-action]')) return;
    this.cancelArmedEdit();
  }

  onEscape(): void {
    this.cancelArmedEdit();
  }

  private async loadForks(version: number = this.runtime.bootstrapVersion): Promise<void> {
    try {
      const forks = await firstValueFrom(this.sessionsService.getForks(this.runtime.sessionId));
      if (version !== this.runtime.bootstrapVersion) return;
      this.forks.set(forks);
    } catch {
      if (version !== this.runtime.bootstrapVersion) return;
      this.forks.set([]);
    }
  }

  /**
   * Discussions anchored to a given turn. A thread records both the assistant
   * uuid it forked from and the turn it belongs to, because the two differ.
   */
  private async loadReviewThreads(): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    if (this.runtime.readOnlyTranscript) return;
    try {
      const threads = await firstValueFrom(this.reviewChats.list(this.runtime.sessionId));
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.reviewThreads.set(threads);
    } catch {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      // A missing discussions list must never break the transcript.
      this.reviewThreads.set([]);
    }
  }

  private async ensureAgentHistory(agentId: string): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    const current = this.agentHistoryById()[agentId];
    if (current?.loading || current?.data) return;

    this.agentHistoryById.update((state) => ({
      ...state,
      [agentId]: { loading: true, data: null, error: null },
    }));

    try {
      const data = await firstValueFrom(
        this.api.getSubagentHistory(this.runtime.sessionId, agentId),
      );
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: {
          loading: false,
          data,
          error: data.transcriptAvailable ? null : data.transcriptError || null,
        },
      }));
    } catch (error) {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      const message =
        (error as { error?: { message?: string } })?.error?.message ||
        (error instanceof Error ? error.message : 'Could not load agent history.');
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: { loading: false, data: null, error: message },
      }));
    }
  }
}
