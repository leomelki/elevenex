import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { Subject, takeUntil } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideGitFork, lucideMessageSquare } from '@ng-icons/lucide';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type {
  ClaudeAutocompleteItem,
  ClaudePermissionApproval,
  ClaudeRuntimeEvent,
  ClaudeSubagentHistoryPayload,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import { ClaudeTranscriptComponent } from '@/features/session/claude-workspace/components/claude-transcript.component';
import { ClaudeContextNoteComponent } from '@/features/session/claude-workspace/components/claude-context-note.component';
import { ClaudeBackgroundActivityComponent } from '@/features/session/claude-workspace/components/claude-background-activity.component';
import { ClaudePermissionInlineComponent } from '@/features/session/claude-workspace/components/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/features/session/claude-workspace/components/claude-user-input.component';
import {
  ClaudeAgentInspectorComponent,
  type ClaudeSubagentHistoryState,
} from '@/features/session/claude-workspace/components/claude-agent-inspector.component';
import {
  ClaudeComposerComponent,
  type ComposerSendPayload,
} from '@/features/session/claude-workspace/components/claude-composer.component';
import type { TranscriptRenderItem } from '@/features/session/claude-workspace/util/transcript-render-items';
import {
  ForkedChatTranscript,
  type ForkedChatLens,
} from './forked-chat-transcript';

export interface ForkedChatTarget {
  sessionId: number;
  provider: AgentProviderId;
}

/**
 * Explains, above the first visible message, what the agent already knows.
 *
 * A fork inherits its parent's conversation but does not show it, which
 * otherwise reads as an agent that mysteriously knows things — or worse, as one
 * starting from nothing.
 */
export interface ForkedChatContextNote {
  summary: string;
  detail: string;
  /** Second line, for the limits of the inherited context. */
  caveat?: string;
}

/**
 * An embedded chat on a forked session.
 *
 * Renders with the same transcript components as the session workspace — tool
 * calls, thinking, collapsed turns, background activity and permission prompts
 * — so a discussion in the review dock reads exactly like the main chat.
 *
 * The caller owns *sending* (each surface wraps prompts in its own guard and
 * posts to its own endpoint); this component owns the socket, the transcript
 * and the composer.
 *
 * It attaches with `borrow()` rather than `connect()` because a fork's parent
 * may already be owned by another surface — see the WebSocket service.
 */
@Component({
  selector: 'app-forked-chat',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    ClaudeTranscriptComponent,
    ClaudeContextNoteComponent,
    ClaudeBackgroundActivityComponent,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    ClaudeAgentInspectorComponent,
    ClaudeComposerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideGitFork, lucideMessageSquare })],
  templateUrl: './forked-chat.component.html',
  styleUrl: './forked-chat.component.scss',
})
export class ForkedChatComponent {
  readonly target = input<ForkedChatTarget | null>(null);
  /**
   * Attaching a socket prewarms an agent process, so inactive threads stay
   * detached and only the focused one connects.
   */
  readonly connected = input(true);
  readonly lens = input.required<ForkedChatLens>();
  readonly placeholder = input('Ask a question…');
  readonly emptyState = input('Ask a focused question about this.');
  /** Set when the chat cannot accept input, e.g. its socket is down. */
  readonly disabled = input(false);
  /** Lets file paths in tool cards and messages render relative to the worktree. */
  readonly worktreePath = input<string | null>(null);
  /** Pinned above the transcript to explain the inherited conversation. */
  readonly contextNote = input<ForkedChatContextNote | null>(null);
  /** Set while the caller's own submit request is in flight. */
  readonly sending = input(false);
  /**
   * Text to drop into the composer for the user to edit and send. Each distinct
   * value is applied once, so re-seeding the same text does not re-fill a
   * composer the user has since cleared.
   */
  readonly draftSeed = input<string | null>(null);

  readonly submitPrompt = output<string>();

  private readonly messagesRef = viewChild<ElementRef<HTMLElement>>('messagesRef');
  private readonly composer = viewChild(ClaudeComposerComponent);

  private readonly ws = inject(AgentRuntimeWebsocketService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);

  readonly draft = signal('');
  readonly transcript = signal<ForkedChatTranscript | null>(null);
  /** Slash commands and skills for the composer, fetched per connection. */
  readonly autocompleteItems = signal<ClaudeAutocompleteItem[]>([]);

  readonly expandedTurns = signal<Record<string, boolean>>({});
  readonly expandedTurnChanges = signal<Record<string, boolean>>({});
  readonly agentInspectorTurnId = signal<string | null>(null);
  readonly agentInspectorSelectedAgentId = signal<string | null>(null);
  readonly agentHistoryById = signal<Record<string, ClaudeSubagentHistoryState>>({});

  /**
   * The placeholder reply bubble: shown from the moment a prompt is sent until
   * the first token lands, so the chat never looks like it swallowed the turn.
   */
  readonly showPendingReply = computed(() => {
    const chat = this.transcript();
    if (!chat) return false;
    if (chat.awaitingFirstToken()) return true;
    return (
      this.sending() &&
      !chat.live().some((item) => item.kind === 'assistant' || item.kind === 'thinking')
    );
  });

  readonly streamingMessageId = computed(
    () => this.transcript()?.streamingMessageId() ?? null,
  );

  readonly selectedAgentInspectorTurn = computed(() => {
    const turnId = this.agentInspectorTurnId();
    if (!turnId) return null;
    const item = this.transcript()
      ?.renderItems()
      .find(
        (entry): entry is Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> =>
          entry.kind === 'collapsed-turn' && entry.turnId === turnId,
      );
    return item?.agentSummary ?? null;
  });

  private connection: ForkedChatTarget | null = null;
  /**
   * Scoped to the *connection*, not the component: the dock swaps targets many
   * times over one component lifetime, and each swap must drop its subscription.
   */
  private connectionClosed$ = new Subject<void>();
  private stickToBottom = true;
  private appliedSeed: string | null = null;

  constructor() {
    effect(() => {
      const lens = this.lens();
      const target = this.target();
      const connected = this.connected();

      const desired = connected ? target : null;
      if (this.isSameConnection(desired)) return;

      this.detach();
      if (desired) {
        this.attach(desired, lens);
      }
    });

    // Follow the newest message while streaming, unless the user has scrolled
    // up to read something.
    effect(() => {
      const transcript = this.transcript();
      transcript?.renderItems();
      transcript?.runPhase();
      if (!this.stickToBottom) return;
      const element = this.messagesRef()?.nativeElement;
      if (!element) return;
      requestAnimationFrame(() => {
        element.scrollTop = element.scrollHeight;
      });
    });

    effect(() => {
      const seed = this.draftSeed();
      if (!seed || seed === this.appliedSeed) return;
      this.appliedSeed = seed;
      this.draft.update((current) =>
        current.trim() ? `${current.trimEnd()}\n\n${seed}` : seed,
      );
      requestAnimationFrame(() => this.composer()?.focusAtEnd());
    });

    this.destroyRef.onDestroy(() => this.detach());
  }

  isTurnExpanded(turnId: string): boolean {
    return !!this.expandedTurns()[turnId];
  }

  toggleTurn(turnId: string): void {
    this.expandedTurns.update((state) => ({ ...state, [turnId]: !state[turnId] }));
  }

  isTurnChangesExpanded(turnId: string): boolean {
    return !!this.expandedTurnChanges()[turnId];
  }

  toggleTurnChanges(turnId: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [turnId]: !state[turnId] }));
  }

  closeTurnChanges(turnId: string): void {
    this.expandedTurnChanges.update((state) => ({ ...state, [turnId]: false }));
  }

  openAgentInspector(turnId: string): void {
    const summary = this.transcript()
      ?.renderItems()
      .find(
        (entry): entry is Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> =>
          entry.kind === 'collapsed-turn' && entry.turnId === turnId,
      )?.agentSummary;
    if (!summary?.agents.length) return;

    const firstAgentId = summary.agents[0]?.agentId ?? null;
    this.agentInspectorTurnId.set(turnId);
    this.agentInspectorSelectedAgentId.set(firstAgentId);
    if (firstAgentId) void this.ensureAgentHistory(firstAgentId);
  }

  closeAgentInspector(): void {
    this.agentInspectorTurnId.set(null);
    this.agentInspectorSelectedAgentId.set(null);
  }

  selectAgentInspectorAgent(agentId: string): void {
    this.agentInspectorSelectedAgentId.set(agentId);
    void this.ensureAgentHistory(agentId);
  }

  onMessagesScroll(): void {
    const element = this.messagesRef()?.nativeElement;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    this.stickToBottom = distanceFromBottom < 48;
  }

  send(payload: ComposerSendPayload): void {
    const text = payload.text.trim();
    if (!text || this.disabled() || this.sending()) return;

    this.stickToBottom = true;
    this.transcript()?.addOptimisticPrompt(text);
    this.draft.set('');
    this.submitPrompt.emit(text);
  }

  /** Roll back the optimistic bubble when the caller's submit failed. */
  revertPrompt(text: string): void {
    const transcript = this.transcript();
    if (!transcript) return;
    const match = transcript.optimistic().find((item) => item.content === text);
    if (match) transcript.removeOptimistic(match.id);
    this.draft.set(text);
  }

  interrupt(): void {
    this.sendRuntimeAction({ type: 'interrupt' });
  }

  approvePermission(approval: ClaudePermissionApproval): void {
    const request = this.transcript()?.pendingPermissionRequest();
    if (!request) return;
    this.sendRuntimeAction({
      type: 'approve_permission',
      requestId: request.requestId,
      remember: approval.remember,
      content: approval.content,
    });
  }

  denyPermission(message?: string): void {
    const request = this.transcript()?.pendingPermissionRequest();
    if (!request) return;
    this.sendRuntimeAction({
      type: 'deny_permission',
      requestId: request.requestId,
      message: message?.trim() || undefined,
    });
  }

  answerUserInput(payload: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }): void {
    const request = this.transcript()?.pendingUserInputRequest();
    if (!request) return;
    this.sendRuntimeAction({
      type: 'answer_user_input',
      requestId: request.requestId,
      action: payload.action,
      content: payload.content,
    });
  }

  /** Pull the persisted history after a turn ends. */
  async refreshHistory(): Promise<void> {
    const target = this.connection;
    const transcript = this.transcript();
    if (!target || !transcript) return;
    const history = (await firstValueFrom(
      this.agentApi.getHistory(target.sessionId, target.provider),
    )) as ClaudeTranscriptItem[];
    if (this.connection?.sessionId !== target.sessionId) return;
    transcript.applyHistoryRefresh(history);
  }

  private sendRuntimeAction(message: Record<string, unknown>): void {
    const target = this.connection;
    if (!target) return;
    this.ws.send(target.sessionId, message, target.provider);
  }

  private async ensureAgentHistory(agentId: string): Promise<void> {
    const target = this.connection;
    if (!target) return;
    const current = this.agentHistoryById()[agentId];
    if (current?.loading || current?.data) return;

    this.agentHistoryById.update((state) => ({
      ...state,
      [agentId]: { loading: true, data: null, error: null },
    }));

    try {
      const data = (await firstValueFrom(
        this.agentApi.getSubagentHistory(target.sessionId, agentId, target.provider),
      )) as ClaudeSubagentHistoryPayload;
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: {
          loading: false,
          data,
          error: data.transcriptAvailable ? null : data.transcriptError || null,
        },
      }));
    } catch (error) {
      const message =
        (error as { error?: { message?: string } })?.error?.message ||
        (error instanceof Error ? error.message : 'Could not load agent history.');
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: { loading: false, data: null, error: message },
      }));
    }
  }

  private isSameConnection(target: ForkedChatTarget | null): boolean {
    if (!target || !this.connection) return target === this.connection;
    return (
      this.connection.sessionId === target.sessionId &&
      this.connection.provider === target.provider
    );
  }

  private attach(target: ForkedChatTarget, lens: ForkedChatLens): void {
    const transcript = new ForkedChatTranscript(lens);
    this.transcript.set(transcript);
    this.connection = target;
    this.connectionClosed$ = new Subject<void>();
    this.stickToBottom = true;

    this.ws
      .borrow(target.sessionId, target.provider)
      .pipe(takeUntil(this.connectionClosed$))
      .subscribe((event) => {
        const runtimeEvent = event as ClaudeRuntimeEvent;
        transcript.apply(runtimeEvent);
        if (runtimeEvent.type === 'complete') {
          void this.refreshHistory();
        }
      });

    this.ws.send(target.sessionId, { type: 'hydrate' }, target.provider);
    void this.refreshAutocomplete(target);
  }

  /** Commands and skills are per-session, so a stale response must not land. */
  private async refreshAutocomplete(target: ForkedChatTarget): Promise<void> {
    try {
      const items = (await firstValueFrom(
        this.agentApi.getAutocompleteItems(target.sessionId, target.provider),
      )) as ClaudeAutocompleteItem[];
      if (this.connection !== target) return;
      this.autocompleteItems.set(items);
    } catch {
      if (this.connection === target) this.autocompleteItems.set([]);
    }
  }

  private detach(): void {
    this.connectionClosed$.next();
    this.connectionClosed$.complete();
    if (this.connection) {
      this.ws.releaseBorrow(this.connection.sessionId, this.connection.provider);
    }
    this.connection = null;
    this.transcript.set(null);
    this.expandedTurns.set({});
    this.expandedTurnChanges.set({});
    this.agentInspectorTurnId.set(null);
    this.agentInspectorSelectedAgentId.set(null);
    this.agentHistoryById.set({});
    this.autocompleteItems.set([]);
  }
}
