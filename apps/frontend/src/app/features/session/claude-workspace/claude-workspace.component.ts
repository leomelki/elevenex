import {
  PlanFeedbackPayload,
  PlanReviewRequest,
  isSamePlanReview,
  planReviewFromPermissionRequest,
  planReviewFromTranscriptItem,
} from '@/features/plan-annotator';
import {
  ClaudeAgentInspectorComponent,
  ClaudeSubagentHistoryState,
} from '@/shared/agent-chat/activity/claude-agent-inspector.component';
import { ClaudeBackgroundActivityComponent } from '@/shared/agent-chat/activity/claude-background-activity.component';
import { AgentConversation } from '@/shared/agent-chat/agent-conversation';
import {
  ClaudeComposerComponent,
  ComposerImageAttachment,
  ComposerSendPayload,
} from '@/shared/agent-chat/composer/claude-composer.component';
import { ComposerDraftService } from '@/shared/agent-chat/composer/composer-draft.service';
import { ClaudePermissionInlineComponent } from '@/shared/agent-chat/requests/claude-permission-inline.component';
import { ClaudeUserInputComponent } from '@/shared/agent-chat/requests/claude-user-input.component';
import { TranscriptLoadingSkeletonComponent } from '@/shared/agent-chat/transcript-loading-skeleton.component';
import { ClaudeContextNoteComponent } from '@/shared/agent-chat/transcript/claude-context-note.component';
import {
  ClaudeTranscriptComponent,
  type TranscriptMessageAffordances,
} from '@/shared/agent-chat/transcript/claude-transcript.component';
import { copyChatMessage } from '@/shared/agent-chat/transcript/message-clipboard';
import { TranscriptRenderItem } from '@/shared/agent-chat/transcript/transcript-render-items';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import type { AgentShow } from '@/shared/models/agent-channel.model';
import {
  AGENT_PROVIDER_ICONS,
  AGENT_PROVIDER_PRESENTATIONS,
} from '@/shared/models/agent-provider-presentation';
import type { AgentRuntimeCommand } from '@/shared/models/agent-runtime.model';
import {
  AgentAuthStatus,
  AgentPlanUsage,
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';
import type { AgentModelPreset } from '@/shared/models/app-settings.model';
import {
  ClaudeAutocompleteItem,
  ClaudeContextUsage,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
  ClaudeModelOption,
  ClaudePendingPrompt,
  ClaudePermissionApproval,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeReasoningEffort,
  ClaudeRuntimeEvent,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeState,
  ClaudeRuntimeWarmState,
  ClaudeSessionExecutionState,
  ClaudeStatusBarPhase,
  ClaudeTaskState,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import type { ReviewChat } from '@/shared/models/review-chat.model';
import type {
  SessionMention,
  SessionMentionCandidate,
} from '@/shared/models/session-mention.model';
import type { CreateSessionForkResponse, SessionFork } from '@/shared/models/session.model';
import { WorktreeContextSnapshot } from '@/shared/models/worktree-context.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeProviderService } from '@/shared/services/agent-runtime-provider.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { ClaudeTerminalTranscriptWebsocketService } from '@/shared/services/claude-terminal-transcript-websocket.service';
import { ConversationForkDraftService } from '@/shared/services/conversation-fork-draft.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import {
  appendDiffSelectionMentions,
  parseDiffSelectionMentions,
} from '@/shared/utils/diff-selection-mention';
import { appendSessionMentions, parseSessionMentions } from '@/shared/utils/session-mention';
import { parseTaskNotifications } from '@/shared/utils/task-notification';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Input,
  OnChanges,
  OnInit,
  SimpleChanges,
  ViewChild,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideArchiveRestore,
  lucideArrowUp,
  lucideCheck,
  lucideChevronDown,
  lucideChevronUp,
  lucideFileText,
  lucideGitBranch,
  lucideMessageSquareQuote,
  lucideNotebookPen,
  lucideOrbit,
  lucideRefreshCw,
  lucideSparkles,
  lucideTriangleAlert,
  lucideWandSparkles,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { Observable, Subscription, firstValueFrom } from 'rxjs';
import { AgentShowCardComponent } from './components/agent-show-card.component';
import {
  ClaudeExportDialogComponent,
  type ExportRequest,
} from './components/claude-export-dialog.component';
import { ClaudeInstallCardComponent } from './components/claude-install-card.component';
import { ClaudeMcpDrawerComponent } from './components/claude-mcp-drawer.component';
import { ClaudeStatusBarComponent } from './components/claude-status-bar.component';
import { ClaudeTasksDrawerComponent } from './components/claude-tasks-drawer.component';
import { CodexLoginCardComponent } from './components/codex-login-card.component';
import { PiLoginCardComponent } from './components/pi-login-card.component';

/**
 * Providers gated behind a card in the workspace: Codex and Pi collect their
 * credentials here, Claude only needs its CLI installed. Antigravity is absent:
 * its auth status can't be verified from the backend yet (see
 * docs/antigravity-provider-flow.md), so gating on `authenticated === true`
 * would lock every Antigravity session out permanently — a failed prompt
 * surfaces its own error instead.
 */
const LOGIN_CARD_PROVIDERS = new Set(['claude', 'codex', 'pi']);

@Component({
  selector: 'app-claude-workspace',
  standalone: true,
  imports: [
    CommonModule,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    ClaudeComposerComponent,
    ClaudeStatusBarComponent,
    ClaudeBackgroundActivityComponent,
    ClaudeExportDialogComponent,
    ClaudeTasksDrawerComponent,
    ClaudeMcpDrawerComponent,
    ClaudeAgentInspectorComponent,
    ClaudeTranscriptComponent,
    ClaudeContextNoteComponent,
    ClaudeInstallCardComponent,
    CodexLoginCardComponent,
    PiLoginCardComponent,
    AgentShowCardComponent,
    TranscriptLoadingSkeletonComponent,
    NgIcon,
    ZardButtonComponent,
  ],
  templateUrl: './claude-workspace.component.html',
  styleUrls: ['./claude-workspace.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideWandSparkles,
      lucideChevronDown,
      lucideChevronUp,
      lucideGitBranch,
      lucideTriangleAlert,
      lucideRefreshCw,
      lucideArchive,
      lucideArchiveRestore,
      lucideCheck,
      lucideFileText,
      lucideNotebookPen,
      lucideOrbit,
      lucideSparkles,
      lucideArrowUp,
      lucideMessageSquareQuote,
    }),
  ],
})
export class ClaudeWorkspaceComponent implements OnInit, OnChanges {
  @Input({ required: true }) sessionId!: number;
  @Input({ required: true }) repoId!: number;
  @Input({ required: true }) worktreePath!: string;
  @Input() hasInjectedWorktreeContext = false;
  @Input() activeAgentProvider: AgentProviderId = 'claude';
  @Input() hasStartedAgentRuntime = false;
  @Input() isVisible = true;
  @Input() archived = false;
  @Input() readOnlyTranscript = false;
  @Input() terminalTranscriptMirror = false;
  @Input() sessionName: string | null = null;
  @Input() unarchiveBusy = false;
  @ViewChild('transcriptContainer') private transcriptContainer?: ElementRef<HTMLDivElement>;
  @ViewChild(ClaudeComposerComponent) private composer?: ClaudeComposerComponent;

  readonly openTerminalFallback = output<void>();
  readonly openInBrowser = output<string>();
  readonly planReviewRequested = output<PlanReviewRequest>();
  readonly planQuestionRequested = output<PlanReviewRequest>();
  readonly planReviewClosed = output<PlanReviewRequest>();
  readonly activeAgentProviderChange = output<AgentProviderId>();
  readonly agentRuntimeStarted = output<void>();
  readonly conversationForkCreated = output<CreateSessionForkResponse>();
  /** Ask the container to open the review workspace, optionally deep-linked. */
  readonly openReviewWorkspace = output<{ path?: string; thread?: number }>();
  readonly openLocalFile = output<LocalFileTarget>();
  readonly conversationForkOpened = output<SessionFork>();
  readonly unarchive = output<void>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly ws = inject(ClaudeRuntimeWebsocketService);
  private readonly terminalTranscriptWs = inject(ClaudeTerminalTranscriptWebsocketService);
  private readonly providerSelection = inject(AgentRuntimeProviderService);
  private readonly sessionsService = inject(SessionsService);
  private readonly forkDrafts = inject(ConversationForkDraftService);
  private readonly reviewChats = inject(ReviewChatsService);

  /** Review discussions started from this session, grouped by their turn. */
  readonly reviewThreads = signal<readonly ReviewChat[]>([]);
  readonly unreadReviewThreadIds = signal<ReadonlySet<number>>(new Set<number>());
  private readonly claudeStatusService = inject(ClaudeStatusService);
  private readonly worktreeContextService = inject(WorktreeContextService);
  private readonly composerDrafts = inject(ComposerDraftService);
  private readonly agentShowsService = inject(AgentShowsService);
  private readonly navigationService = inject(NavigationService);
  readonly appSettings = inject(AppSettingsService);

  readonly liveShows = computed<AgentShow[]>(() =>
    this.agentShowsService.liveShows().filter((s) => s.agentSessionId === this.sessionId),
  );

  private readonly conversation = new AgentConversation();
  private historyRefresh: { version: number; promise: Promise<void> } | null = null;
  readonly loading = signal(true);
  readonly applyingPresetId = signal<string | null>(null);
  readonly modelPresets = computed(() => this.appSettings.settings().agentModelPresets);
  readonly hydrated = signal(false);
  readonly submitting = signal(false);
  readonly prompt = signal('');
  readonly pendingDiffMentions = signal<DiffSelectionMention[]>([]);
  readonly pendingSessionMentions = signal<SessionMention[]>([]);
  readonly loadingSessionMentionId = signal<number | null>(null);
  readonly composerImages = signal<ComposerImageAttachment[]>([]);
  readonly runPhase = this.conversation.runPhase;
  readonly warmState = signal<ClaudeRuntimeWarmState>('cold');
  readonly sessionState = signal<ClaudeSessionExecutionState>('idle');
  readonly canInterrupt = this.conversation.canInterrupt;
  readonly lastError = this.conversation.lastError;
  readonly claudeSessionId = signal<string | null>(null);
  readonly providers = signal<AgentRuntimeProviderInfo[]>([]);
  // Provider selection is session-local. Multiple open tabs stay mounted and
  // connected concurrently, so a background tab must not start using the
  // provider selected by whichever tab is currently visible.
  readonly currentProvider = signal<AgentProviderId>('claude');
  readonly currentProviderInfo = computed(
    () => this.providers().find((provider) => provider.id === this.currentProvider()) ?? null,
  );
  readonly currentProviderSupportsImages = computed(
    () => this.currentProviderInfo()?.capabilities.multimodalPrompts ?? false,
  );
  readonly composerPlaceholder = computed(() => {
    const name = this.currentProviderInfo()?.displayName;
    return name ? `Tell ${name} what to do…` : 'Tell the agent what to do…';
  });
  readonly selectedModel = signal<string | null>(null);
  readonly reasoningEffort = signal<ClaudeReasoningEffort | null>(null);
  readonly fastMode = signal(false);
  readonly worktreeContext = signal<WorktreeContextSnapshot | null>(null);
  readonly worktreeContextLoading = signal(false);
  readonly worktreeContextBusy = signal(false);
  readonly firstPromptContextEnabled = signal(true);
  readonly worktreeRootEditorOpen = signal(false);
  readonly draftRootRef = signal('');
  readonly availableModels = signal<ClaudeModelOption[]>([]);
  readonly contextUsage = signal<ClaudeContextUsage | null>(null);
  readonly planUsage = signal<AgentPlanUsage | null>(null);
  readonly historyItems = this.conversation.history;
  readonly liveItems = this.conversation.live;
  readonly optimisticUserItems = this.conversation.optimistic;
  readonly pendingPermissionRequest = this.conversation.pendingPermissionRequest;
  readonly pendingUserInputRequest = this.conversation.pendingUserInputRequest;
  readonly pendingPrompts = this.conversation.pendingPrompts;
  readonly queuePaused = this.conversation.queuePaused;
  private readonly cancelledPendingPromptIds = new Set<string>();
  private readonly autoApprovedPermissionRequestIds = new Set<string>();
  private bootstrappedProvider: AgentProviderId | null = null;
  private deferredContextGenerationTimer: number | null = null;
  private composerDraftRevision = 0;
  private composerDraftRestoreVersion = 0;
  private lastSubmittedPromptText = '';
  readonly autocompleteItems = signal<ClaudeAutocompleteItem[]>([]);
  readonly tasks = signal<ClaudeTaskState[]>([]);
  readonly toolProgressByToolUseId = this.conversation.toolProgressByToolUseId;
  readonly tasksDrawerOpen = signal(false);
  readonly mcpDrawerOpen = signal(false);
  readonly exportDialogOpen = signal(false);
  readonly exportBusy = signal(false);
  readonly mcpLoading = signal(false);
  readonly mcpSnapshot = signal<ClaudeMcpSnapshot | null>(null);
  readonly mcpBusyServerName = signal<string | null>(null);
  readonly sessionMetadata = signal<ClaudeRuntimeSessionMetadata | null>(null);
  readonly subagents = this.conversation.subagents;
  // Work still executing in the background after the visible turn returned to
  // idle. Comes straight from the backend's swept registry rather than being
  // re-derived from the subagent ring buffer here: a missed stop hook used to
  // leave this stuck non-empty, which silently queued every later message.
  readonly backgroundWork = this.conversation.backgroundWork;
  // True while the current run was started by background work reporting back
  // rather than by a user prompt. The turn itself behaves identically; this is
  // only used to label it in the UI.
  readonly backgroundRunActive = signal(false);
  readonly recentHookEvents = this.conversation.recentHookEvents;
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
  readonly _permissionMode = signal<ClaudePermissionMode | null>(null);
  readonly _planMode = signal(false);
  /**
   * Auth status per provider. Only the current provider's entry is ever shown,
   * but keeping a map means switching provider doesn't leak the previous one's
   * status into the login card, and a new provider needs no extra signal.
   */
  private readonly authStatusByProvider = signal<Record<string, AgentAuthStatus | null>>({});
  readonly providerAuthStatus = computed(
    () => this.authStatusByProvider()[this.currentProvider()] ?? null,
  );
  readonly runtimeStarted = signal(false);
  readonly statusPhase = computed<ClaudeStatusBarPhase>(() => {
    const phase = this.runPhase();
    if (phase !== 'idle') return phase;
    if (this.warmState() === 'prewarming') return 'initializing';
    return this.runtimeStarted() ? 'idle' : 'ready';
  });
  readonly wsConnected = signal(false);
  private wsAutoReconnecting = false;
  private wsStateSub: Subscription | null = null;
  // Private signals mirroring @Input() properties so computed() calls can track them reactively.
  // Plain @Input() properties are not tracked by Angular's signal graph, so computed() that only
  // read non-signal inputs evaluate once and never update when those inputs change.
  private readonly _archived = signal(false);
  private readonly _readOnlyTranscript = signal(false);
  private readonly _terminalTranscriptMirror = signal(false);
  readonly isTranscriptReadOnly = computed(() => this._archived() || this._readOnlyTranscript());
  /** True when the current provider is unavailable or needs credentials. */
  readonly showProviderLogin = computed(() => {
    if (this._readOnlyTranscript()) return false;
    if (this._archived()) return false;
    if (!LOGIN_CARD_PROVIDERS.has(this.currentProvider())) return false;
    const status = this.providerAuthStatus();
    if (!status) return false;
    return status.authenticated !== true;
  });
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
  readonly permissionMode = computed<ClaudePermissionMode>(() => {
    return this._permissionMode() ?? 'auto';
  });
  readonly planMode = computed(() => this._planMode());
  readonly showLoading = computed(() => this.loading() || !this.hydrated());
  readonly sessionMentionCandidates = computed<SessionMentionCandidate[]>(() => {
    const candidates: SessionMentionCandidate[] = [];
    for (const project of this.navigationService.tree()) {
      for (const repo of project.repos) {
        for (const workspace of repo.workspaces ?? []) {
          for (const session of [...workspace.sessions, ...(workspace.archivedSessions ?? [])]) {
            if (session.id === this.sessionId) continue;
            candidates.push({
              sessionId: session.id,
              title: session.name?.trim() || `Session ${session.id}`,
              branch: session.branchName,
              status: session.status,
            });
          }
        }
      }
    }
    return candidates.sort((a, b) => a.title.localeCompare(b.title));
  });
  readonly promptIsCommand = computed(() => this.prompt().trimStart().startsWith('/'));
  readonly canAppendContext = computed(
    () =>
      this.firstPromptContextEnabled() &&
      !this.hasInjectedContext() &&
      !this.promptIsCommand() &&
      this.worktreeContext()?.generationStatus === 'ready' &&
      !!this.worktreeContext()?.contextSentence,
  );
  readonly hasInjectedContext = signal(false);
  readonly contextExpanded = signal(false);

  readonly contextPinState = computed<
    'idle' | 'loading' | 'generating' | 'ready' | 'failed' | 'empty'
  >(() => {
    if (this.worktreeContextLoading()) return 'loading';
    const ctx = this.worktreeContext();
    if (!ctx) return 'idle';
    if (ctx.generationStatus === 'generating') return 'generating';
    if (ctx.generationStatus === 'failed') return 'failed';
    if (ctx.contextSentence) return 'ready';
    if (!ctx.hasChanges) return 'empty';
    return 'idle';
  });

  readonly showContextPin = computed(() => {
    if (this._readOnlyTranscript() && !this._terminalTranscriptMirror()) return false;
    if (this._archived()) return false;
    const hasTranscript = this.transcriptItems().length > 0 || this.submitting();
    if (hasTranscript) return false;
    if (this.worktreeContextLoading()) return true;
    const ctx = this.worktreeContext();
    if (!ctx) return false;
    if (ctx.generationStatus === 'failed') return true;
    if (ctx.generationStatus === 'generating') return true;
    if (ctx.contextSentence) return true;
    if (!ctx.hasChanges) return true;
    return false;
  });

  readonly contextPinLabel = computed(() => {
    switch (this.contextPinState()) {
      case 'loading':
        return 'Reading context…';
      case 'generating':
        return 'Summarizing…';
      case 'failed':
        return 'Context unavailable';
      case 'empty':
        return 'No changes';
      case 'ready':
        return 'Context';
      default:
        return 'Context';
    }
  });

  readonly contextPinSummary = computed(() => {
    const ctx = this.worktreeContext();
    if (!ctx) return '';
    if (ctx.contextSentence) return ctx.contextSentence;
    if (ctx.generationStatus === 'failed') return ctx.errorMessage ?? 'Generation failed';
    if (!ctx.hasChanges) return `No diff vs ${ctx.rootRef || 'auto'}`;
    return '';
  });

  readonly contextPinBadge = computed<{
    text: string;
    variant: 'accent' | 'muted' | 'warn';
  } | null>(() => {
    const ctx = this.worktreeContext();
    if (!ctx) return null;
    if (this.contextPinState() === 'failed') return { text: 'Failed', variant: 'warn' };
    if (this.hasInjectedContext() && this.firstPromptContextEnabled())
      return { text: 'Used', variant: 'muted' };
    if (!ctx.contextSentence) return null;
    if (this.promptIsCommand() && this.firstPromptContextEnabled())
      return { text: 'Skip', variant: 'muted' };
    return this.firstPromptContextEnabled()
      ? { text: 'On', variant: 'accent' }
      : { text: 'Off', variant: 'muted' };
  });

  readonly canToggleContextEnabled = computed(() => {
    const ctx = this.worktreeContext();
    return !!ctx?.contextSentence && !this.hasInjectedContext();
  });

  readonly firstMessageContext = computed(() => {
    if (!this.hasInjectedContext() || !this.firstPromptContextEnabled()) return null;
    const ctx = this.worktreeContext();
    const sentence = ctx?.contextSentence?.trim();
    if (!sentence) return null;
    return { sentence, rootRef: ctx?.rootRef ?? null };
  });

  toggleContextExpanded(): void {
    this.contextExpanded.update((v) => !v);
  }

  toggleContextEnabled(): void {
    if (!this.canToggleContextEnabled()) {
      this.toggleContextExpanded();
      return;
    }
    if (this.terminalTranscriptMirror) {
      this.firstPromptContextEnabled.set(false);
      void firstValueFrom(this.worktreeContextService.consume(this.sessionId, false)).catch(
        (err) => {
          console.warn('[worktree-context] failed to skip TUI context injection', err);
        },
      );
      void firstValueFrom(
        this.worktreeContextService.updateEnabled(this.repoId, this.worktreePath, false),
      ).catch((err) => {
        console.warn('[worktree-context] failed to persist context enabled state', err);
      });
      return;
    }
    this.firstPromptContextEnabled.update((v) => !v);
    void firstValueFrom(
      this.worktreeContextService.updateEnabled(
        this.repoId,
        this.worktreePath,
        this.firstPromptContextEnabled(),
      ),
    ).catch((err) => {
      console.warn('[worktree-context] failed to persist context enabled state', err);
    });
  }

  readonly messageActionsDisabled = computed(
    () =>
      this._readOnlyTranscript() ||
      this._archived() ||
      this.loading() ||
      this.submitting() ||
      this.runPhase() !== 'idle' ||
      !!this.pendingPermissionRequest() ||
      !!this.pendingUserInputRequest() ||
      this.rewindingMessageId() !== null,
  );
  readonly forkActionsDisabled = computed(
    () => this._readOnlyTranscript() || this.loading() || this.forkingAnchorId() !== null,
  );
  readonly forkDisabledReason = computed(() => {
    if (this._readOnlyTranscript()) return 'Forks are not available in terminal mirror mode.';
    if (this.forkingAnchorId()) return 'A fork is already being created.';
    if (this.loading()) return 'Transcript is still loading.';
    return '';
  });
  readonly forksByAnchor = computed(() => {
    const grouped: Record<string, SessionFork[]> = {};
    for (const fork of this.forks()) {
      grouped[fork.anchorMessageId] = [...(grouped[fork.anchorMessageId] ?? []), fork];
    }
    return grouped;
  });

  private bootstrapVersion = 0;

  private readonly pendingDeltas: Array<{ itemId: string; delta: string }> = [];
  private flushScheduled = false;
  private flushRafId: number | null = null;

  readonly transcriptItems = this.conversation.items;

  readonly userPromptIndex = computed(() => {
    const byId = new Map<string, ClaudeTranscriptItem>();
    let firstId: string | null = null;
    let lastId: string | null = null;
    const items = this.transcriptItems();
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

  readonly topLevelTranscriptItems = this.conversation.topLevelItems;

  readonly childTranscriptItemsByParentToolUseId = this.conversation.childItemsByParentToolUseId;

  readonly pairedTranscript = this.conversation.units;

  readonly renderItems = this.conversation.renderItems;

  readonly liveToolUseIds = this.conversation.liveToolUseIds;

  readonly reviewThreadsByTurnId = computed(() => {
    const grouped: Record<string, ReviewChat[]> = {};
    for (const thread of this.reviewThreads()) {
      if (!thread.turnKey || thread.status === 'resolved') continue;
      grouped[thread.turnKey] = [...(grouped[thread.turnKey] ?? []), thread];
    }
    return grouped;
  });

  /** Only the streaming item pulses; everything else renders settled. */
  readonly streamingMessageId = this.conversation.streamingMessageId;

  /**
   * Per-message capabilities handed to the transcript view. Arrow properties so
   * the object identity stays stable while each lookup still reads live state.
   */
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

  readonly lastLiveMessageId = this.conversation.lastLiveMessageId;

  readonly lastLiveAssistantMessageId = computed(() => {
    const live = this.liveItems();
    for (let i = live.length - 1; i >= 0; i--) {
      const item = live[i];
      if (item.kind === 'assistant') return item.id;
    }
    if (this.terminalTranscriptMirror && this.runPhase() === 'running') {
      const transcript = this.transcriptItems();
      for (let i = transcript.length - 1; i >= 0; i--) {
        const item = transcript[i];
        if (item.kind === 'assistant') return item.id;
      }
    }
    return null;
  });

  readonly latestPlanReview = computed(() => {
    const permissionReview = this.planReviewForPermission(this.pendingPermissionRequest());
    if (permissionReview) return permissionReview;

    const items = this.transcriptItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const review = planReviewFromTranscriptItem(items[i], this.sessionId, this.currentProvider());
      if (review) return review;
    }
    return null;
  });

  readonly isAwaitingFirstAssistantToken = computed(
    () =>
      (this.runPhase() === 'running' || this.runPhase() === 'waiting') &&
      !this.pendingPermissionRequest() &&
      !this.pendingUserInputRequest() &&
      !this.lastLiveAssistantMessageId(),
  );

  readonly hasPendingUserInput = computed(() => !!this.pendingUserInputRequest());
  readonly composerPermissionDisabledReason = computed(() =>
    this.pendingPermissionRequest()
      ? 'Approve or deny the pending request to resume the conversation.'
      : '',
  );

  readonly selectedAgentInspectorTurn = computed(() => {
    const turnId = this.agentInspectorTurnId();
    if (!turnId) return null;
    const item = this.renderItems().find(
      (entry): entry is Extract<TranscriptRenderItem, { kind: 'collapsed-turn' }> =>
        entry.kind === 'collapsed-turn' && entry.turnId === turnId,
    );
    return item?.agentSummary ?? null;
  });

  constructor() {
    void this.appSettings.load().catch(() => undefined);
    effect(() => {
      this.pairedTranscript();
      this.runPhase();
      this.userPromptIndex();
      queueMicrotask(() => {
        this.scrollTranscriptToBottomIfPinned();
        this.refreshUserPromptElements();
        this.updateContextualPrompt();
      });
    });

    // Re-hydrate the runtime WS after server reconnection to catch any missed events.
    // Guarded by hydrated() to skip the initial bootstrap — only fires on subsequent reconnects.
    effect(() => {
      const reconnectCount = this.claudeStatusService.onReconnect();
      if (reconnectCount > 0) {
        untracked(() => {
          if (this.hydrated()) {
            this.rehydrate();
          }
        });
      }
    });

    // While a login card is on screen, poll the auth-status endpoint as a
    // safety net: a CLI's completion event is occasionally delayed (long-poll)
    // or missed (WS reconnect race), and the user would otherwise be stuck on
    // a card whose dismissal never arrived. A provider that finishes OAuth
    // entirely in the browser has no other completion signal to rely on.
    effect((onCleanup) => {
      if (!this.showProviderLogin()) return;
      const provider = this.currentProvider();
      const id = window.setInterval(() => {
        void this.refreshAuthStatus(provider);
      }, 3000);
      onCleanup(() => window.clearInterval(id));
    });

    // Proactively fetch auth status when the provider needs a login card but no
    // status has arrived from the session snapshot yet (timing race guard).
    effect(() => {
      const provider = this.currentProvider();
      if (!LOGIN_CARD_PROVIDERS.has(provider)) return;
      if (this.authStatusByProvider()[provider] != null) return;
      void this.refreshAuthStatus(provider);
    });

    this.destroyRef.onDestroy(() => {
      this.bootstrapVersion += 1;
      if (this.flushRafId !== null) {
        cancelAnimationFrame(this.flushRafId);
      }
      if (this.deferredContextGenerationTimer !== null) {
        window.clearTimeout(this.deferredContextGenerationTimer);
      }
      // Write the debounced draft now rather than leaving it to a timer that
      // fires after the composer this text belongs to is gone.
      void this.composerDrafts.flush(this.sessionId);
      this.disconnectTranscriptSocket(this.sessionId);
      this.ws.clearProvider?.(this.sessionId);
      this.api.clearProvider?.(this.sessionId);
    });
  }

  ngOnInit(): void {
    this._archived.set(this.archived);
    this._readOnlyTranscript.set(this.readOnlyTranscript);
    this._terminalTranscriptMirror.set(this.terminalTranscriptMirror);
    this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    this.runtimeStarted.set(this.hasStartedAgentRuntime);
    this.currentProvider.set(this.activeAgentProvider);
    this.syncSessionProvider(this.activeAgentProvider);
    if (this.isVisible) {
      this.providerSelection.setProvider(this.activeAgentProvider);
    }
    // Every open tab is kept warm, including background tabs. Its websocket
    // continues applying runtime events while another tab is selected.
    void this.bootstrapForMode();
    this.restoreInitialComposerDraft();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Keep private signals in sync with @Input() changes so computed() calls stay reactive.
    if (changes['archived']) this._archived.set(this.archived);
    if (changes['readOnlyTranscript']) this._readOnlyTranscript.set(this.readOnlyTranscript);
    if (changes['terminalTranscriptMirror'])
      this._terminalTranscriptMirror.set(this.terminalTranscriptMirror);

    if (changes['sessionId'] && !changes['sessionId'].firstChange) {
      const previousSessionId = changes['sessionId'].previousValue as number;
      void this.composerDrafts.flush(previousSessionId);
      this.disconnectTranscriptSocket(previousSessionId);
      this.ws.clearProvider?.(previousSessionId);
      this.api.clearProvider?.(previousSessionId);
      this.syncSessionProvider(this.activeAgentProvider);
      this.reset();
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
      if (this.isVisible) {
        this.providerSelection.setProvider(this.activeAgentProvider);
      }
      void this.bootstrapForMode();
      this.restoreInitialComposerDraft();
    }
    if (
      changes['hasInjectedWorktreeContext'] &&
      !changes['hasInjectedWorktreeContext'].firstChange
    ) {
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    }
    if (changes['hasStartedAgentRuntime'] && !changes['hasStartedAgentRuntime'].firstChange) {
      this.runtimeStarted.set(this.hasStartedAgentRuntime);
    }
    if (changes['isVisible'] && this.isVisible && !changes['isVisible'].firstChange) {
      this.providerSelection.setProvider(this.activeAgentProvider);
      if (!this.hydrated() || this.bootstrappedProvider !== this.currentProvider()) {
        this.reset();
        this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
        void this.bootstrapForMode();
        this.restoreInitialComposerDraft();
      } else if (!this.archived && (!this.readOnlyTranscript || this.terminalTranscriptMirror)) {
        void this.loadWorktreeContext(false);
      }
    }
    // Skip archived-change bootstrap if sessionId already triggered a full reset+bootstrap above.
    if (changes['archived'] && !changes['archived'].firstChange && !changes['sessionId']) {
      this.reset();
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
      if (this.isVisible) {
        this.providerSelection.setProvider(this.activeAgentProvider);
      }
      void this.bootstrapForMode();
      this.restoreInitialComposerDraft();
    }
    const transcriptModeChanged =
      (changes['readOnlyTranscript'] && !changes['readOnlyTranscript'].firstChange) ||
      (changes['terminalTranscriptMirror'] && !changes['terminalTranscriptMirror'].firstChange);
    if (transcriptModeChanged) {
      this.disconnectTranscriptSocket(this.sessionId);
      this.reset();
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
      void this.bootstrapForMode();
    }
    if (changes['activeAgentProvider'] && !changes['activeAgentProvider'].firstChange) {
      const providerChangedSinceBootstrap = this.bootstrappedProvider !== this.activeAgentProvider;
      if (providerChangedSinceBootstrap) {
        this.ws.disconnect(this.sessionId);
      }
      this.currentProvider.set(this.activeAgentProvider);
      this.syncSessionProvider(this.activeAgentProvider);
      if (this.isVisible) {
        this.providerSelection.setProvider(this.activeAgentProvider);
      }
      if (providerChangedSinceBootstrap) {
        this.reset();
        this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
        void this.bootstrapForMode();
        this.restoreInitialComposerDraft();
      }
    }
  }

  onPromptChange(value: string): void {
    this.prompt.set(value);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  onComposerImagesChange(images: ComposerImageAttachment[]): void {
    this.composerImages.set(images);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  addDiffMentions(mentions: readonly DiffSelectionMention[]): void {
    if (this.isTranscriptReadOnly() || !mentions.length) return;
    this.pendingDiffMentions.update((items) => [...items, ...mentions]);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
    queueMicrotask(() => this.composer?.focusAtEnd());
  }

  removeDiffMention(id: string): void {
    this.pendingDiffMentions.update((items) => items.filter((mention) => mention.id !== id));
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  async addSessionMention(sessionId: number): Promise<void> {
    if (this.pendingSessionMentions().length >= 3) {
      toast.error('You can mention up to 3 sessions in one message.');
      return;
    }
    if (
      this.isTranscriptReadOnly() ||
      sessionId === this.sessionId ||
      this.loadingSessionMentionId() !== null ||
      this.pendingSessionMentions().some((mention) => mention.sessionId === sessionId)
    )
      return;
    this.loadingSessionMentionId.set(sessionId);
    try {
      const mention = await firstValueFrom(this.agentApi.getConversationMention(sessionId));
      this.pendingSessionMentions.update((items) => [...items, mention]);
      this.markComposerDraftChanged();
      this.persistComposerDraft();
      queueMicrotask(() => this.composer?.focusAtEnd());
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not mention that session.'));
    } finally {
      if (this.loadingSessionMentionId() === sessionId) this.loadingSessionMentionId.set(null);
    }
  }

  removeSessionMention(sessionId: number): void {
    this.pendingSessionMentions.update((items) =>
      items.filter((mention) => mention.sessionId !== sessionId),
    );
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  async submitPrompt(payload: ComposerSendPayload | string): Promise<void> {
    if (this.isTranscriptReadOnly()) return;
    const normalized: ComposerSendPayload =
      typeof payload === 'string'
        ? { text: payload, images: [], diffMentions: [], sessionMentions: [] }
        : payload;
    const trimmed = normalized.text.trim();
    const diffMentions = normalized.diffMentions ?? [];
    const sessionMentions = normalized.sessionMentions ?? [];
    const visiblePrompt =
      trimmed ||
      (sessionMentions.length
        ? 'Use the mentioned session context.'
        : diffMentions.length
          ? 'Review the mentioned diff selection.'
          : '');
    const promptWithDiffMentions = appendDiffSelectionMentions(visiblePrompt, diffMentions);
    const promptWithMentions = appendSessionMentions(promptWithDiffMentions, sessionMentions);
    const images = this.currentProviderSupportsImages() ? normalized.images : [];
    if (!promptWithMentions.trim() && !images.length) return;
    const startsImmediately =
      this.runPhase() === 'idle' &&
      this.backgroundWork().length === 0 &&
      this.pendingPrompts().length === 0 &&
      !this.queuePaused();
    if (startsImmediately && this.submitting()) return;
    if (startsImmediately) {
      this.submitting.set(true);
      const optimisticContent = images.length
        ? [promptWithMentions, ...images.map(() => '[image]')].filter(Boolean).join('\n')
        : promptWithMentions;
      this.conversation.addOptimisticPrompt(optimisticContent);
    }
    this.cancelArmedEdit();
    this.lastSubmittedPromptText = normalized.text;
    this.prompt.set('');
    this.pendingDiffMentions.set([]);
    this.pendingSessionMentions.set([]);
    this.composerImages.set([]);
    this.markComposerDraftChanged();
    this.clearComposerDraft();
    const prepared = this.prepareRuntimePrompt(promptWithMentions);
    this.sendRuntimeAction({
      type: 'submit_prompt',
      prompt: prepared.prompt,
      titlePrompt: visiblePrompt,
      ...(images.length ? { images: images.map((i) => this.toRuntimeImage(i)) } : {}),
    });
    if (prepared.consumedContextSentence) {
      this.markWorktreeContextConsumed(prepared.consumedContextSentence);
    }
  }

  canReviewPlan(item: ClaudeTranscriptItem): boolean {
    if (this.isTranscriptReadOnly()) return false;
    const review = this.planReviewForMessage(item);
    if (!review) return false;
    if (this.runPhase() !== 'idle' || this.submitting()) return false;
    if (review.provider === 'codex') {
      return this.planMode();
    }
    return !review.readonly;
  }

  planReviewForMessage(item: ClaudeTranscriptItem): PlanReviewRequest | null {
    if (this.isStreamingMessage(item.id)) return null;
    const review = planReviewFromTranscriptItem(item, this.sessionId, this.currentProvider());
    if (!review) return null;
    const latest = this.latestPlanReview();
    return isSamePlanReview(review, latest) ? review : null;
  }

  planReviewForPermission(req: ClaudePermissionRequest | null): PlanReviewRequest | null {
    return planReviewFromPermissionRequest(req, this.sessionId, this.currentProvider());
  }

  openPlanReview(review: PlanReviewRequest): void {
    this.planReviewRequested.emit(review);
  }

  openPlanQuestion(review: PlanReviewRequest): void {
    this.planQuestionRequested.emit(review);
  }

  openPermissionPlanReview(req: ClaudePermissionRequest): void {
    const review = this.planReviewForPermission(req);
    if (review) this.openPlanReview(review);
  }

  async approvePlanReview(review: PlanReviewRequest): Promise<void> {
    if (this.isTranscriptReadOnly() || review.sessionId !== this.sessionId || review.readonly)
      return;
    if (review.source === 'exit-plan-permission') {
      this.approvePlanPermissionReview(review);
      return;
    }
    if (review.provider !== 'codex' || this.runPhase() !== 'idle' || this.submitting()) return;

    try {
      const selectedMode = this.permissionMode();
      await firstValueFrom(this.api.setPermissionMode(this.sessionId, selectedMode));
      const next = await firstValueFrom(this.api.setPlanMode(this.sessionId, false));
      this.applyRuntimeState(next);
      await this.submitPrompt({ text: 'implement plan', images: [] });
      this.planReviewClosed.emit(review);
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not approve the plan.'));
    }
  }

  async sendPlanReviewFeedback(payload: PlanFeedbackPayload): Promise<void> {
    const message = payload.message.trim();
    const review = payload.review;
    if (
      !message ||
      this.isTranscriptReadOnly() ||
      review.sessionId !== this.sessionId ||
      review.readonly
    )
      return;

    if (review.source === 'exit-plan-permission') {
      this.denyPlanPermissionReview(review, message);
      this.planReviewClosed.emit(review);
      return;
    }

    if (review.provider !== 'codex') return;
    await this.submitPrompt({ text: message, images: [] });
    this.planReviewClosed.emit(review);
  }

  async rejectPlanReview(payload: PlanFeedbackPayload): Promise<void> {
    const review = payload.review;
    if (this.isTranscriptReadOnly() || review.sessionId !== this.sessionId || review.readonly)
      return;

    if (review.source === 'exit-plan-permission') {
      this.denyPlanPermissionReview(review, payload.message);
      this.planReviewClosed.emit(review);
      return;
    }

    if (review.provider !== 'codex') return;
    await this.submitPrompt({ text: payload.message, images: [] });
    this.planReviewClosed.emit(review);
  }

  private approvePlanPermissionReview(review: PlanReviewRequest): void {
    const req = this.pendingPermissionRequest();
    if (!req || req.requestId !== review.requestId) return;
    this.sendRuntimeAction({
      type: 'approve_permission',
      requestId: req.requestId,
      remember: false,
    });
    this.planReviewClosed.emit(review);
  }

  private denyPlanPermissionReview(review: PlanReviewRequest, message: string): void {
    const req = this.pendingPermissionRequest();
    if (!req || req.requestId !== review.requestId) return;
    this.sendRuntimeAction({
      type: 'deny_permission',
      requestId: req.requestId,
      message: message.trim() || undefined,
    });
  }

  private toRuntimeImage(img: ComposerImageAttachment): {
    mediaType: ComposerImageAttachment['mediaType'];
    data: string;
  } {
    const commaIdx = img.dataUrl.indexOf(',');
    const data = commaIdx >= 0 ? img.dataUrl.slice(commaIdx + 1) : img.dataUrl;
    return { mediaType: img.mediaType, data };
  }

  cancelPendingPrompt(id: string): void {
    if (this.isTranscriptReadOnly()) return;
    this.cancelledPendingPromptIds.add(id);
    this.sendRuntimeAction({ type: 'cancel_pending_prompt', id });
  }

  steerPendingPrompt(id: string): void {
    if (this.isTranscriptReadOnly()) return;
    this.sendRuntimeAction({ type: 'steer_pending_prompt', id });
  }

  resumePendingPrompts(): void {
    if (this.isTranscriptReadOnly() || !this.pendingPrompts().length) return;
    this.sendRuntimeAction({ type: 'resume_pending_prompts' });
  }

  clearPendingPrompts(): void {
    if (this.isTranscriptReadOnly() || !this.pendingPrompts().length) return;
    for (const prompt of this.pendingPrompts()) {
      this.cancelledPendingPromptIds.add(prompt.id);
    }
    this.sendRuntimeAction({ type: 'clear_pending_prompts' });
  }

  private updatePendingPrompts(next: ClaudePendingPrompt[]): void {
    const nextIds = new Set(next.map((p) => p.id));
    const prev = this.pendingPrompts();
    const consumed: ClaudePendingPrompt[] = [];
    for (const item of prev) {
      if (nextIds.has(item.id)) continue;
      if (this.cancelledPendingPromptIds.delete(item.id)) continue;
      consumed.push(item);
    }
    if (consumed.length) {
      const now = new Date().toISOString();
      this.optimisticUserItems.update((items) => [
        ...items,
        ...consumed.map<ClaudeTranscriptItem>((p) => ({
          id: `opt-${p.id}`,
          kind: 'user',
          content: p.prompt,
          timestamp: now,
          authoredAt: now,
        })),
      ]);
    }
    // Drop cancellation memory for ids no longer referenced (defensive cleanup).
    if (this.cancelledPendingPromptIds.size) {
      for (const id of [...this.cancelledPendingPromptIds]) {
        if (!nextIds.has(id)) this.cancelledPendingPromptIds.delete(id);
      }
    }
    this.pendingPrompts.set(next);
  }

  interrupt(): void {
    if (this.isTranscriptReadOnly()) return;
    this.sendRuntimeAction({ type: 'interrupt' });
  }

  private autoApprovePermission(requestId: string): void {
    if (this.autoApprovedPermissionRequestIds.has(requestId)) return;
    this.autoApprovedPermissionRequestIds.add(requestId);
    this.sendRuntimeAction({
      type: 'approve_permission',
      requestId,
      remember: false,
    });
  }

  approvePermission(approval: ClaudePermissionApproval): void {
    if (this.isTranscriptReadOnly()) return;
    const req = this.pendingPermissionRequest();
    if (!req) return;
    this.sendRuntimeAction({
      type: 'approve_permission',
      requestId: req.requestId,
      remember: approval.remember,
      content: approval.content,
    });
  }

  denyPermission(message?: string): void {
    if (this.isTranscriptReadOnly()) return;
    const req = this.pendingPermissionRequest();
    if (!req) return;
    this.sendRuntimeAction({
      type: 'deny_permission',
      requestId: req.requestId,
      message: message?.trim() || undefined,
    });
  }

  answerUserInput(payload: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }): void {
    if (this.isTranscriptReadOnly()) return;
    const req = this.pendingUserInputRequest();
    if (!req) return;
    this.sendRuntimeAction({
      type: 'answer_user_input',
      requestId: req.requestId,
      action: payload.action,
      content: payload.content,
    });
  }

  async onModelChange(model: string): Promise<void> {
    return this.updateRuntimeSetting(() =>
      this.api.setSelectedModel(this.sessionId, model || null),
    );
  }

  async applyModelPreset(preset: AgentModelPreset): Promise<void> {
    if (this.readOnlyTranscript || this.runtimeStarted() || this.applyingPresetId()) return;
    this.applyingPresetId.set(preset.id);
    try {
      if (preset.provider !== this.currentProvider()) {
        await firstValueFrom(
          this.sessionsService.updateActiveAgentProvider(this.sessionId, preset.provider),
        );
        this.disconnectTranscriptSocket(this.sessionId);
        this.providerSelection.setProvider(preset.provider);
        this.activeAgentProvider = preset.provider;
        this.currentProvider.set(preset.provider);
        this.syncSessionProvider(preset.provider);
        this.activeAgentProviderChange.emit(preset.provider);
        this.reset();
        this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
        await this.bootstrap();
        this.restoreInitialComposerDraft();
      }

      const modelState = await firstValueFrom(
        this.agentApi.setSelectedModel(this.sessionId, preset.model, preset.provider),
      );
      this.applyRuntimeState(modelState);
      const effortState = await firstValueFrom(
        this.agentApi.setReasoningEffort(this.sessionId, preset.reasoningEffort, preset.provider),
      );
      this.applyRuntimeState(effortState);
      queueMicrotask(() => this.composer?.focusAtEnd());
    } catch {
      toast.error(`Could not apply “${preset.name}”.`);
    } finally {
      this.applyingPresetId.set(null);
    }
  }

  isModelPresetSelected(preset: AgentModelPreset): boolean {
    return (
      preset.provider === this.currentProvider() &&
      preset.model === this.selectedModel() &&
      preset.reasoningEffort === this.reasoningEffort()
    );
  }

  modelPresetIcon(provider: string): string {
    return AGENT_PROVIDER_ICONS[provider] || 'lucideSparkles';
  }

  modelPresetSummary(preset: AgentModelPreset): string {
    const provider = AGENT_PROVIDER_PRESENTATIONS.find((item) => item.id === preset.provider);
    const parts = [provider?.label ?? preset.provider, preset.model ?? 'Agent default'];
    if (preset.reasoningEffort) parts.push(this.reasoningEffortLabel(preset.reasoningEffort));
    return parts.join(' · ');
  }

  private reasoningEffortLabel(effort: string): string {
    return effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1);
  }

  async onReasoningEffortChange(effort: ClaudeReasoningEffort | null): Promise<void> {
    return this.updateRuntimeSetting(() => this.api.setReasoningEffort(this.sessionId, effort));
  }

  async onFastModeChange(enabled: boolean): Promise<void> {
    return this.updateRuntimeSetting(() => this.api.setFastMode(this.sessionId, enabled));
  }

  async onPermissionModeChange(mode: ClaudePermissionMode): Promise<void> {
    return this.updateRuntimeSetting(() =>
      this.api.setPermissionMode(this.sessionId, mode || null),
    );
  }

  async onPlanModeChange(enabled: boolean): Promise<void> {
    return this.updateRuntimeSetting(() => this.api.setPlanMode(this.sessionId, enabled));
  }

  private async updateRuntimeSetting(request: () => Observable<ClaudeRuntimeState>): Promise<void> {
    if (this.readOnlyTranscript) return;
    const version = this.bootstrapVersion;
    try {
      const state = await firstValueFrom(request());
      if (this.isCurrentConversation(version)) this.applyRuntimeState(state);
    } catch (error) {
      if (this.isCurrentConversation(version)) {
        toast.error(this.getHttpErrorMessage(error, 'Could not update agent settings.'));
      }
    }
  }

  private isCurrentConversation(version: number): boolean {
    return version === this.bootstrapVersion && !this.destroyRef.destroyed;
  }

  openTerminal(): void {
    if (this.isTranscriptReadOnly()) return;
    if (this.currentProvider() !== 'claude') {
      toast.message('Raw terminal fallback is only available for Claude Code.');
      return;
    }
    void firstValueFrom(this.api.openTerminalFallback(this.sessionId)).finally(() =>
      this.openTerminalFallback.emit(),
    );
  }

  onProviderChange(provider: AgentProviderId): void {
    if (this.readOnlyTranscript) return;
    if (provider === this.currentProvider()) return;
    if (this.runtimeStarted()) {
      toast.message('Provider can only be changed before the session is started.');
      return;
    }
    this.disconnectTranscriptSocket(this.sessionId);
    this.providerSelection.setProvider(provider);
    this.activeAgentProvider = provider;
    this.currentProvider.set(provider);
    this.syncSessionProvider(provider);
    this.activeAgentProviderChange.emit(provider);
    void firstValueFrom(
      this.sessionsService.updateActiveAgentProvider(this.sessionId, provider),
    ).catch(() => undefined);
    this.reset();
    this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    void this.bootstrap().then(() => this.restoreInitialComposerDraft());
  }

  dismissShow(id: string): void {
    this.agentShowsService.dismiss(id);
  }

  openShowDeepLink(deepLink: string): void {
    const sessionMatch = /^\/sessions\/(\d+)/.exec(deepLink);
    if (sessionMatch) {
      this.navigationService.openSession(Number(sessionMatch[1]));
      return;
    }
    const projectMatch = /^\/projects\/(\d+)/.exec(deepLink);
    if (projectMatch) {
      this.navigationService.revealProject(Number(projectMatch[1]));
      return;
    }
    window.open(deepLink, '_blank', 'noopener');
  }

  openMcpDrawer(): void {
    this.mcpDrawerOpen.set(true);
    void this.loadMcpSnapshot();
  }

  openExportDialog(): void {
    this.exportDialogOpen.set(true);
  }

  async onExportCopy(request: ExportRequest): Promise<void> {
    if (this.exportBusy()) return;
    this.exportBusy.set(true);
    try {
      const markdown = await firstValueFrom(
        this.agentApi.exportConversation(this.sessionId, request, this.activeAgentProvider),
      );
      await navigator.clipboard.writeText(markdown);
      this.exportDialogOpen.set(false);
      toast.success('Conversation copied to clipboard');
    } catch {
      toast.error('Failed to export conversation');
    } finally {
      this.exportBusy.set(false);
    }
  }

  closeMcpDrawer(): void {
    this.mcpDrawerOpen.set(false);
    this.mcpBusyServerName.set(null);
  }

  refreshMcpSnapshot(): void {
    void this.loadMcpSnapshot(true);
  }

  toggleMcpServer(server: ClaudeMcpServerEntry): void {
    this.mcpBusyServerName.set(server.name);
    this.mcpLoading.set(true);
    void firstValueFrom(this.api.toggleMcpServer(this.sessionId, server.name))
      .then((snapshot) => {
        this.mcpSnapshot.set(snapshot);
        toast.success(`${server.enabled ? 'Disabled' : 'Enabled'} ${server.name}`);
      })
      .catch((error) => {
        toast.error(this.getHttpErrorMessage(error, `Could not update ${server.name}.`));
      })
      .finally(() => {
        this.mcpBusyServerName.set(null);
        this.mcpLoading.set(false);
      });
  }

  recheckMcpServer(server: ClaudeMcpServerEntry): void {
    this.mcpBusyServerName.set(server.name);
    this.mcpLoading.set(true);
    void firstValueFrom(this.api.recheckMcpServer(this.sessionId, server.name))
      .then((snapshot) => {
        this.mcpSnapshot.set(snapshot);
      })
      .catch((error) => {
        toast.error(this.getHttpErrorMessage(error, `Could not recheck ${server.name}.`));
      })
      .finally(() => {
        this.mcpBusyServerName.set(null);
        this.mcpLoading.set(false);
      });
  }

  /** A login card reported success — confirm it against the backend. */
  onProviderAuthenticated(): void {
    void this.refreshAuthStatus(this.currentProvider());
  }

  private setAuthStatus(provider: string, status: AgentAuthStatus | null): void {
    this.authStatusByProvider.update((current) => ({
      ...current,
      [provider]: status,
    }));
  }

  private refreshAuthStatus(provider: string): Promise<void> {
    return firstValueFrom(this.agentApi.getAuthStatus(provider))
      .then((status) => this.setAuthStatus(provider, status))
      .catch(() => undefined);
  }

  startMcpAuth(server: ClaudeMcpServerEntry): void {
    this.mcpBusyServerName.set(server.name);
    void firstValueFrom(this.api.startMcpAuth(this.sessionId, server.name))
      .then((result) => {
        this.openInBrowser.emit(result.url);
        toast.message(result.message);
      })
      .catch((error) => {
        toast.error(this.getHttpErrorMessage(error, `Could not start auth for ${server.name}.`));
      })
      .finally(() => {
        this.mcpBusyServerName.set(null);
      });
  }

  isStreamingMessage(itemId: string): boolean {
    return this.runPhase() === 'running' && this.lastLiveMessageId() === itemId;
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
    const item = this.renderItems().find(
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
      !this.isTranscriptReadOnly() &&
      item.kind === 'user' &&
      !!item.sourceMessageId &&
      (this.currentProviderInfo()?.capabilities.rewindConversation ?? false)
    );
  }

  canShowMessageActions(item: ClaudeTranscriptItem): boolean {
    return !this.isTranscriptReadOnly() && item.kind === 'user' && !!item.sourceMessageId;
  }

  canForkMessage(item: ClaudeTranscriptItem): boolean {
    return (
      !this.readOnlyTranscript &&
      (item.kind === 'user' || item.kind === 'assistant') &&
      !!this.forkAnchorForItem(item) &&
      !this.isStreamingMessage(item.id)
    );
  }

  forkAnchorForItem(item: ClaudeTranscriptItem): string | null {
    return item.transcriptMessageId ?? null;
  }

  forksForItem(item: ClaudeTranscriptItem): SessionFork[] {
    const anchor = this.forkAnchorForItem(item);
    return anchor ? (this.forksByAnchor()[anchor] ?? []) : [];
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

    this.forkingAnchorId.set(anchorMessageId);
    try {
      const response = await firstValueFrom(
        this.sessionsService.createFork(this.sessionId, {
          anchorMessageId,
          anchorMessageKind: item.kind,
          anchorExcerpt: this.forkExcerptForItem(item),
        }),
      );
      this.forks.update((forks) => [...forks, response.fork]);
      this.expandedForkAnchors.update((state) => ({
        ...state,
        [anchorMessageId]: true,
      }));
      this.conversationForkCreated.emit(response);
      toast.success('Conversation fork created');
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not create fork.'));
    } finally {
      this.forkingAnchorId.set(null);
    }
  }

  openFork(fork: SessionFork): void {
    if (!fork.childSession) return;
    this.conversationForkOpened.emit(fork);
  }

  private forkExcerptForItem(item: ClaudeTranscriptItem): string {
    const withoutSessions = parseSessionMentions(item.content).text;
    return parseDiffSelectionMentions(withoutSessions).text.trim().slice(0, 500);
  }

  isEditArmed(item: ClaudeTranscriptItem): boolean {
    return !!item.sourceMessageId && this.armedEditMessageId() === item.sourceMessageId;
  }

  readonly copyMessage = copyChatMessage;

  armEditMessage(item: ClaudeTranscriptItem): void {
    if (!item.sourceMessageId || this.messageActionsDisabled()) return;
    this.armedEditMessageId.set(item.sourceMessageId);
  }

  cancelArmedEdit(): void {
    this.armedEditMessageId.set(null);
  }

  async confirmEditMessage(item: ClaudeTranscriptItem): Promise<void> {
    try {
      if (!item.sourceMessageId || this.messageActionsDisabled()) return;
      await this.restorePromptFromMessage(item);
      toast.success('Message restored for editing');
    } catch (error) {
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
    const restoredSessions = parseSessionMentions(content);
    const restored = parseDiffSelectionMentions(restoredSessions.text);
    if (!messageId) return;

    this.rewindingMessageId.set(messageId);
    try {
      const [history, runtimeState] = await Promise.all([
        firstValueFrom(this.api.rewindConversation(this.sessionId, messageId)),
        firstValueFrom(this.api.getRuntimeState(this.sessionId)),
      ]);

      this.historyItems.set([...history].sort((l, r) => l.timestamp.localeCompare(r.timestamp)));
      this.applyRuntimeState(runtimeState);
      this.optimisticUserItems.set([]);
      this.liveItems.set([]);
      this.pendingPermissionRequest.set(null);
      this.pendingUserInputRequest.set(null);
      this.expandedTurns.set({});
      this.expandedTurnChanges.set({});
      this.prompt.set(restored.text);
      this.pendingDiffMentions.set(restored.mentions);
      this.pendingSessionMentions.set(restoredSessions.mentions);
      this.composerImages.set([]);
      this.markComposerDraftChanged();
      this.persistComposerDraft();
      this.cancelArmedEdit();
      this.closeAgentInspector();
      queueMicrotask(() => this.composer?.focusAtEnd());
    } finally {
      this.rewindingMessageId.set(null);
    }
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMousedown(event: MouseEvent): void {
    if (!this.armedEditMessageId()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-cw-edit-confirm-root]')) return;
    if (target?.closest('[data-cw-edit-action]')) return;
    this.cancelArmedEdit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancelArmedEdit();
  }

  private activeTranscriptSocket():
    | ClaudeRuntimeWebsocketService
    | ClaudeTerminalTranscriptWebsocketService {
    return this.terminalTranscriptMirror ? this.terminalTranscriptWs : this.ws;
  }

  private disconnectTranscriptSocket(sessionId: number): void {
    this.ws.disconnect(sessionId);
    this.terminalTranscriptWs.disconnect(sessionId);
  }

  private syncSessionProvider(provider: AgentProviderId): void {
    // Optional chaining keeps lightweight component test doubles compatible.
    this.ws.setProvider?.(this.sessionId, provider);
    this.api.setProvider?.(this.sessionId, provider);
  }

  private rehydrate(): void {
    const version = this.bootstrapVersion;
    this.disconnectTranscriptSocket(this.sessionId);
    this.activeTranscriptSocket()
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (version === this.bootstrapVersion && !this.destroyRef.destroyed)
          this.handleRuntimeEvent(event);
      });
    this.activeTranscriptSocket().send(this.sessionId, { type: 'hydrate' });
  }

  private sendRuntimeAction(message: AgentRuntimeCommand): void {
    if (this.readOnlyTranscript) return;
    const socket = this.activeTranscriptSocket();
    if (!socket.isConnected(this.sessionId)) {
      this.rehydrate();
    }
    this.activeTranscriptSocket().send(this.sessionId, message);
  }

  private subscribeConnectionState(): void {
    this.wsStateSub?.unsubscribe();
    this.wsStateSub = this.activeTranscriptSocket()
      .connectionState$(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((phase) => {
        if (phase === 'connected') {
          this.wsConnected.set(true);
          this.wsAutoReconnecting = false;
        } else if (phase === 'disconnected' && this.hydrated() && !this.wsAutoReconnecting) {
          this.wsConnected.set(false);
          this.wsAutoReconnecting = true;
          this.rehydrate();
        } else if (phase === 'connecting') {
          this.wsConnected.set(false);
        }
      });
  }

  private async bootstrap(): Promise<void> {
    const version = ++this.bootstrapVersion;
    this.bootstrappedProvider = this.currentProvider();
    this.loading.set(true);
    if (!this.readOnlyTranscript) {
      void this.loadWorktreeContext(false);
      void this.loadProviders();
    } else if (this.terminalTranscriptMirror) {
      void this.loadWorktreeContext(false);
    }

    this.activeTranscriptSocket()
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleRuntimeEvent(event));

    this.subscribeConnectionState();

    this.activeTranscriptSocket().send(this.sessionId, { type: 'hydrate' });

    if (!this.readOnlyTranscript) {
      void this.refreshAutocomplete(version).catch(() => undefined);
      void this.loadForks(version);
      void this.loadReviewThreads();
    }
    if (version === this.bootstrapVersion) this.loading.set(false);
  }

  private async bootstrapArchived(): Promise<void> {
    const version = ++this.bootstrapVersion;
    this.bootstrappedProvider = this.currentProvider();
    this.loading.set(true);
    this.hydrated.set(false);
    void this.loadProviders();

    try {
      const history = (await firstValueFrom(
        this.agentApi.getHistory(this.sessionId, this.activeAgentProvider),
      )) as ClaudeTranscriptItem[];
      if (version !== this.bootstrapVersion) return;
      this.historyItems.set(history);
      void this.loadForks(version);
      void this.loadReviewThreads();
      this.liveItems.set([]);
      this.optimisticUserItems.set([]);
      this.runPhase.set('idle');
      this.sessionState.set('idle');
      this.canInterrupt.set(false);
      this.pendingPermissionRequest.set(null);
      this.pendingUserInputRequest.set(null);
      this.pendingPrompts.set([]);
      this.queuePaused.set(false);
      this.lastError.set(null);
      this.hydrated.set(true);
    } catch (error) {
      if (version !== this.bootstrapVersion) return;
      this.lastError.set(this.getHttpErrorMessage(error, 'Could not load archived transcript.'));
      this.hydrated.set(true);
    } finally {
      if (version === this.bootstrapVersion) this.loading.set(false);
    }
  }

  private bootstrapForMode(): Promise<void> {
    return this.archived ? this.bootstrapArchived() : this.bootstrap();
  }

  private restoreInitialComposerDraft(): void {
    if (this.isTranscriptReadOnly()) return;
    if (this.applyPendingForkDraft()) return;
    this.restoreSavedComposerDraft();
  }

  private applyPendingForkDraft(): boolean {
    const draft = this.forkDrafts.consumeDraft(this.sessionId);
    if (!draft) return false;
    const parsedSessions = parseSessionMentions(draft);
    const parsed = parseDiffSelectionMentions(parsedSessions.text);
    this.prompt.set(parsed.text);
    this.pendingDiffMentions.set(parsed.mentions);
    this.pendingSessionMentions.set(parsedSessions.mentions);
    this.composerImages.set([]);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
    queueMicrotask(() => this.composer?.focusAtEnd());
    return true;
  }

  private restoreSavedComposerDraft(): void {
    const sessionId = this.sessionId;
    const restoreVersion = ++this.composerDraftRestoreVersion;
    const revision = this.composerDraftRevision;

    void this.composerDrafts.load(sessionId).then((draft) => {
      if (!draft) return;
      if (restoreVersion !== this.composerDraftRestoreVersion) return;
      if (sessionId !== this.sessionId || this.isTranscriptReadOnly()) return;
      if (revision !== this.composerDraftRevision) return;

      this.prompt.set(draft.text);
      this.pendingDiffMentions.set(draft.diffMentions);
      this.pendingSessionMentions.set(draft.sessionMentions);
      this.composerImages.set(draft.images);
      queueMicrotask(() => this.composer?.focusAtEnd());
    });
  }

  private markComposerDraftChanged(): void {
    this.composerDraftRevision += 1;
    this.composerDraftRestoreVersion += 1;
  }

  private persistComposerDraft(): void {
    if (this.isTranscriptReadOnly()) return;
    this.composerDrafts.save({
      sessionId: this.sessionId,
      text: this.prompt(),
      diffMentions: this.pendingDiffMentions(),
      sessionMentions: this.pendingSessionMentions(),
      images: this.composerImages(),
    });
  }

  private clearComposerDraft(): void {
    this.composerDrafts.delete(this.sessionId);
  }

  private async loadForks(version: number = this.bootstrapVersion): Promise<void> {
    try {
      const forks = await firstValueFrom(this.sessionsService.getForks(this.sessionId));
      if (version !== this.bootstrapVersion) return;
      this.forks.set(forks);
    } catch {
      if (version !== this.bootstrapVersion) return;
      this.forks.set([]);
    }
  }

  onRootRefInput(value: string): void {
    this.draftRootRef.set(value);
  }

  openRootRefEditor(): void {
    this.worktreeRootEditorOpen.set(true);
    this.draftRootRef.set(this.worktreeContext()?.rootRef ?? '');
  }

  cancelRootRefEditor(): void {
    this.worktreeRootEditorOpen.set(false);
    this.draftRootRef.set(this.worktreeContext()?.rootRef ?? '');
  }

  async saveRootRef(): Promise<void> {
    const version = this.bootstrapVersion;
    const rootRef = this.draftRootRef().trim() || null;
    this.worktreeContextBusy.set(true);
    try {
      await firstValueFrom(
        this.worktreeContextService.updateRootRef(this.repoId, this.worktreePath, rootRef),
      );
      if (!this.isCurrentConversation(version)) return;
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.repoId, this.worktreePath, {
          force: true,
          rootRef,
          provider: this.currentProvider(),
        }),
      );
      if (!this.isCurrentConversation(version)) return;
      this.worktreeContext.set(snapshot);
      this.worktreeRootEditorOpen.set(false);
    } catch (error) {
      if (this.isCurrentConversation(version))
        toast.error(this.getHttpErrorMessage(error, 'Could not update the comparison root.'));
    } finally {
      if (this.isCurrentConversation(version)) this.worktreeContextBusy.set(false);
    }
  }

  async recomputeWorktreeContext(): Promise<void> {
    const version = this.bootstrapVersion;
    if (this.worktreeContextBusy()) return;
    this.worktreeContextBusy.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.repoId, this.worktreePath, {
          force: true,
          provider: this.currentProvider(),
        }),
      );
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContext.set(snapshot);
    } catch (error) {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      toast.error(this.getHttpErrorMessage(error, 'Could not recompute worktree context.'));
    } finally {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContextBusy.set(false);
    }
  }

  private async loadWorktreeContext(triggerGenerate = true): Promise<void> {
    const version = this.bootstrapVersion;
    this.worktreeContextLoading.set(true);
    const deferGeneration =
      triggerGenerate &&
      (!this.runtimeStarted() || this.runPhase() !== 'idle' || this.submitting());
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.get(this.repoId, this.worktreePath, {
          cachedOnly: !triggerGenerate || deferGeneration,
        }),
      );
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContext.set(snapshot);
      this.draftRootRef.set(snapshot.rootRef ?? '');
      if (!this.hasInjectedContext()) {
        this.firstPromptContextEnabled.set(snapshot.contextEnabled ?? true);
      }

      const shouldAutoGenerate =
        triggerGenerate &&
        !deferGeneration &&
        !snapshot.hasRecord &&
        snapshot.canGenerate &&
        snapshot.generationStatus !== 'generating' &&
        !this.worktreeContextBusy();

      if (shouldAutoGenerate) {
        console.info(
          `[worktree-context] no prior record for ${this.worktreePath}; requesting first-time generation`,
        );
        this.worktreeContextBusy.set(true);
        const generated = await firstValueFrom(
          this.worktreeContextService.generate(this.repoId, this.worktreePath, {
            provider: this.currentProvider(),
          }),
        );
        if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
        this.worktreeContext.set(generated);
        console.info(
          `[worktree-context] first-time generation settled for ${this.worktreePath} (status=${generated.generationStatus})`,
        );
      } else if (triggerGenerate) {
        console.info(
          `[worktree-context] skipping auto-generate for ${this.worktreePath} (hasRecord=${snapshot.hasRecord}, canGenerate=${snapshot.canGenerate}, status=${snapshot.generationStatus})`,
        );
        if (deferGeneration) {
          this.scheduleDeferredContextGeneration();
        }
      }
    } catch (error) {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      toast.error(this.getHttpErrorMessage(error, 'Could not load worktree context.'));
    } finally {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContextLoading.set(false);
      this.worktreeContextBusy.set(false);
    }
  }

  private scheduleDeferredContextGeneration(): void {
    if (this.readOnlyTranscript) return;
    if (!this.runtimeStarted()) return;
    if (this.hasInjectedContext()) return;
    const context = this.worktreeContext();
    if (!context?.canGenerate || context.contextSentence) return;
    if (this.deferredContextGenerationTimer !== null) return;

    this.deferredContextGenerationTimer = window.setTimeout(() => {
      this.deferredContextGenerationTimer = null;
      if (
        !this.runtimeStarted() ||
        this.hasInjectedContext() ||
        this.runPhase() !== 'idle' ||
        this.submitting() ||
        this.worktreeContextBusy() ||
        this.worktreeContextLoading() ||
        this.worktreeContext()?.contextSentence
      ) {
        this.scheduleDeferredContextGeneration();
        return;
      }
      void this.loadWorktreeContext(true);
    }, 1500);
  }

  private async refreshAutocomplete(version: number = this.bootstrapVersion): Promise<void> {
    const autocompleteItems = await firstValueFrom(this.api.getAutocompleteItems(this.sessionId));
    if (version !== this.bootstrapVersion) return;
    this.autocompleteItems.set(autocompleteItems);
  }

  private async loadProviders(): Promise<void> {
    try {
      this.providers.set(await firstValueFrom(this.agentApi.listProviders()));
    } catch {
      this.providers.set([
        {
          id: 'claude',
          displayName: 'Claude Code',
          capabilities: {
            mcp: true,
            subagents: true,
            permissions: true,
            userInput: true,
            multimodalPrompts: true,
            terminalFallback: true,
            rewindConversation: true,
          },
        },
      ]);
    }
  }

  private handleRuntimeEvent(event: ClaudeRuntimeEvent): void {
    switch (event.type) {
      case 'session_snapshot':
        this.conversation.applyHistoryRefresh(event.payload.history);
        this.applyRuntimeState(event.payload);
        this.hydrated.set(true);
        this.loading.set(false);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.conversation.apply(event);
        this.hydrated.set(true);
        this.loading.set(false);
        return;
      case 'runtime_warm_state':
        this.warmState.set(event.payload.warmState);
        return;
      case 'session_created':
        this.claudeSessionId.set(event.payload.claudeSessionId);
        this.runtimeStarted.set(true);
        this.agentRuntimeStarted.emit();
        this.scheduleDeferredContextGeneration();
        return;
      case 'session_metadata':
        this.sessionMetadata.set(event.payload.metadata);
        void this.refreshAutocomplete().catch(() => undefined);
        return;
      case 'run_state':
        this.updatePendingPrompts(event.payload.pendingPrompts ?? []);
        this.conversation.apply(event);
        this.sessionState.set(event.payload.sessionState);
        this.backgroundRunActive.set(event.payload.backgroundRunActive ?? false);
        this.selectedModel.set(event.payload.selectedModel);
        this.reasoningEffort.set(event.payload.reasoningEffort ?? null);
        this.fastMode.set(event.payload.fastMode ?? false);
        this.availableModels.set(event.payload.availableModels);
        this.contextUsage.set(event.payload.contextUsage);
        if (event.payload.planUsage !== undefined) {
          this.planUsage.set(event.payload.planUsage);
        }
        this._permissionMode.set(event.payload.permissionMode);
        this._planMode.set(event.payload.planMode ?? false);
        this.applyPendingPermissionFromRuntime(event.payload.pendingPermissionRequest);
        if (event.payload.runPhase !== 'running') this.submitting.set(false);
        return;
      case 'plan_usage':
        this.planUsage.set(event.payload.planUsage);
        return;
      case 'task_started':
      case 'task_updated':
      case 'task_progress':
      case 'task_notification':
        this.tasks.update((items) => [
          event.payload.task,
          ...items.filter((t) => t.taskId !== event.payload.task.taskId),
        ]);
        return;
      case 'message_delta':
      case 'thinking_delta':
        this.enqueueDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'permission_request': {
        const req = event.payload.request;
        this.applyPendingPermissionFromRuntime(req);
        return;
      }
      case 'permission_resolved':
        this.autoApprovedPermissionRequestIds.delete(event.payload.requestId);
        this.conversation.apply(event);
        return;
      case 'error': {
        this.conversation.apply(event);
        if (this.lastSubmittedPromptText && !this.prompt()) {
          this.prompt.set(this.lastSubmittedPromptText);
          this.markComposerDraftChanged();
          this.persistComposerDraft();
        }
        this.submitting.set(false);
        // A history fetch can fail after its runtime snapshot has arrived. Stop
        // the initial skeleton so the actionable error is visible.
        if (!this.hydrated()) {
          this.hydrated.set(true);
          this.loading.set(false);
        }
        return;
      }
      case 'complete':
        this.flushDeltas();
        this.conversation.apply(event);
        this.autoApprovedPermissionRequestIds.clear();
        this.submitting.set(false);
        if (this.mcpDrawerOpen()) {
          void this.loadMcpSnapshot(true);
        }
        void this.handleCompletion();
        return;
      case 'auth_status':
        this.setAuthStatus(this.currentProvider(), event.payload.status as AgentAuthStatus);
        return;
      default:
        this.conversation.apply(event);
        return;
    }
  }

  private async handleCompletion(version: number = this.bootstrapVersion): Promise<void> {
    await this.syncHistoryAfterCompletion();
    if (version !== this.bootstrapVersion) return;

    this.scheduleDeferredContextGeneration();
  }

  private async syncHistoryAfterCompletion(): Promise<void> {
    const version = this.bootstrapVersion;
    if (this.historyRefresh?.version === version) return this.historyRefresh.promise;
    this.flushDeltas();
    const promise = (async () => {
      try {
        const history = await firstValueFrom(this.api.getHistory(this.sessionId));
        if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
        this.flushDeltas();
        this.conversation.applyHistoryRefresh(history);
      } catch (error) {
        if (version === this.bootstrapVersion && !this.destroyRef.destroyed) {
          this.lastError.set(
            this.getHttpErrorMessage(error, 'Could not refresh conversation history.'),
          );
        }
      }
    })();
    this.historyRefresh = { version, promise };
    try {
      await promise;
    } finally {
      if (this.historyRefresh?.promise === promise) this.historyRefresh = null;
    }
  }

  private applyRuntimeState(state: ClaudeRuntimeState): void {
    this.updatePendingPrompts(state.pendingPrompts ?? []);
    this.conversation.applyRuntimeState(state);
    this.warmState.set(state.warmState);
    this.sessionState.set(state.sessionState);
    this.backgroundRunActive.set(state.backgroundRunActive ?? false);
    this.claudeSessionId.set(state.claudeSessionId);
    if (state.claudeSessionId && state.claudeSessionId !== '-1') {
      this.runtimeStarted.set(true);
    }
    this.selectedModel.set(state.selectedModel);
    this.reasoningEffort.set(state.reasoningEffort ?? null);
    this.fastMode.set(state.fastMode ?? false);
    this.availableModels.set(state.availableModels);
    this.contextUsage.set(state.contextUsage);
    this.planUsage.set(state.planUsage ?? null);
    this._permissionMode.set(state.permissionMode);
    this._planMode.set(state.planMode ?? false);
    this.applyPendingPermissionFromRuntime(state.pendingPermissionRequest);
    this.tasks.set(state.tasks);
    this.sessionMetadata.set(state.sessionMetadata);
    if (state.authStatus != null) {
      this.setAuthStatus(this.currentProvider(), state.authStatus as AgentAuthStatus);
    }
  }

  private applyPendingPermissionFromRuntime(req: ClaudePermissionRequest | null): void {
    if (!req) {
      this.pendingPermissionRequest.set(null);
      return;
    }

    if (this.shouldAutoApprovePermission(req)) {
      this.pendingPermissionRequest.set(null);
      this.autoApprovePermission(req.requestId);
      return;
    }

    this.pendingPermissionRequest.set(req);
  }

  private shouldAutoApprovePermission(req: ClaudePermissionRequest): boolean {
    if (this.currentProvider() !== 'claude') return false;
    if (!this.planMode() || this.permissionMode() !== 'bypassPermissions') {
      return false;
    }
    const toolName = (req.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const noAutoApprove = new Set(['exitplanmode', 'askuserquestion']);
    return !noAutoApprove.has(toolName);
  }

  private reset(): void {
    this.conversation.reset();
    this.bootstrapVersion += 1;
    this.wsAutoReconnecting = false;
    this.wsConnected.set(false);
    if (this.flushRafId !== null) {
      cancelAnimationFrame(this.flushRafId);
      this.flushRafId = null;
      this.flushScheduled = false;
      this.pendingDeltas.length = 0;
    }
    this.disconnectTranscriptSocket(this.sessionId);
    this.autoApprovedPermissionRequestIds.clear();
    this.loading.set(true);
    this.hydrated.set(false);
    this.submitting.set(false);
    this.prompt.set('');
    this.pendingDiffMentions.set([]);
    this.pendingSessionMentions.set([]);
    this.loadingSessionMentionId.set(null);
    this.composerImages.set([]);
    this.sessionState.set('idle');
    this.backgroundRunActive.set(false);
    this.claudeSessionId.set(null);
    this.selectedModel.set(null);
    this.reasoningEffort.set(null);
    this.fastMode.set(false);
    this.worktreeContext.set(null);
    this.worktreeContextLoading.set(false);
    this.worktreeContextBusy.set(false);
    this.firstPromptContextEnabled.set(true);
    if (this.deferredContextGenerationTimer !== null) {
      window.clearTimeout(this.deferredContextGenerationTimer);
      this.deferredContextGenerationTimer = null;
    }
    this.worktreeRootEditorOpen.set(false);
    this.draftRootRef.set('');
    this.availableModels.set([]);
    this.contextUsage.set(null);
    this.planUsage.set(null);
    this._permissionMode.set(null);
    this._planMode.set(false);
    this.cancelledPendingPromptIds.clear();
    this.autocompleteItems.set([]);
    this.tasks.set([]);
    this.tasksDrawerOpen.set(false);
    this.mcpDrawerOpen.set(false);
    this.mcpLoading.set(false);
    this.mcpSnapshot.set(null);
    this.mcpBusyServerName.set(null);
    this.sessionMetadata.set(null);
    this.authStatusByProvider.set({});
    this.bootstrappedProvider = null;
    this.runtimeStarted.set(this.hasStartedAgentRuntime);
    this.expandedTurns.set({});
    this.expandedTurnChanges.set({});
    this.armedEditMessageId.set(null);
    this.rewindingMessageId.set(null);
    this.forks.set([]);
    this.expandedForkAnchors.set({});
    this.forkingAnchorId.set(null);
    this.closeAgentInspector();
    this.agentHistoryById.set({});
    this.shouldAutoScrollTranscript = true;
    this.userPromptElements = [];
    this.contextualPrompt.set(null);
    this.contextualPromptCollapsed.set(false);
  }

  onTranscriptScroll(): void {
    const el = this.transcriptContainer?.nativeElement;
    if (!el) return;
    this.shouldAutoScrollTranscript = this.isTranscriptScrolledToBottom(el);
    this.updateContextualPrompt();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateContextualPrompt();
  }

  scrollToContextualPrompt(): void {
    const container = this.transcriptContainer?.nativeElement;
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
    const el = this.transcriptContainer?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  private isTranscriptScrolledToBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= this.transcriptBottomThresholdPx;
  }

  private userPromptElements: HTMLElement[] = [];

  private refreshUserPromptElements(): void {
    const container = this.transcriptContainer?.nativeElement;
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
    const container = this.transcriptContainer?.nativeElement;
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

  private enqueueDelta(itemId: string, delta: string): void {
    this.pendingDeltas.push({ itemId, delta });
    this.scheduleFlush();
  }

  private prepareRuntimePrompt(prompt: string): {
    prompt: string;
    consumedContextSentence: string | null;
  } {
    if (
      this.hasInjectedContext() ||
      !this.firstPromptContextEnabled() ||
      prompt.trimStart().startsWith('/')
    ) {
      return { prompt, consumedContextSentence: null };
    }

    const localContextSentence = this.worktreeContext()?.contextSentence?.trim();
    if (this.worktreeContext()?.generationStatus !== 'ready' || !localContextSentence) {
      return { prompt, consumedContextSentence: null };
    }

    this.hasInjectedContext.set(true);
    this.worktreeContext.update((snapshot) =>
      snapshot ? { ...snapshot, lastUsedAt: new Date().toISOString() } : snapshot,
    );
    return {
      prompt: buildWorktreeContextPrompt(localContextSentence, prompt),
      consumedContextSentence: localContextSentence,
    };
  }

  private markWorktreeContextConsumed(contextSentence: string): void {
    void firstValueFrom(
      this.worktreeContextService.consume(this.sessionId, true, contextSentence),
    ).catch((error) => {
      console.warn('[worktree-context] failed to mark first-message context consumed', error);
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.flushRafId = requestAnimationFrame(() => this.flushDeltas());
  }

  private flushDeltas(): void {
    if (this.flushRafId !== null) cancelAnimationFrame(this.flushRafId);
    this.flushRafId = null;
    this.flushScheduled = false;
    const deltas = new Map<string, string>();
    for (const { itemId, delta } of this.pendingDeltas.splice(0)) {
      deltas.set(itemId, (deltas.get(itemId) ?? '') + delta);
    }
    if (deltas.size) this.conversation.appendDeltas(deltas);
  }

  /**
   * Discussions anchored to a given turn. A thread records both the assistant
   * uuid it forked from and the turn it belongs to, because the two differ.
   */
  private async loadReviewThreads(): Promise<void> {
    const version = this.bootstrapVersion;
    if (this.readOnlyTranscript) return;
    try {
      const threads = await firstValueFrom(this.reviewChats.list(this.sessionId));
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.reviewThreads.set(threads);
    } catch {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      // A missing discussions list must never break the transcript.
      this.reviewThreads.set([]);
    }
  }

  private async ensureAgentHistory(agentId: string): Promise<void> {
    const version = this.bootstrapVersion;
    const current = this.agentHistoryById()[agentId];
    if (current?.loading || current?.data) return;

    this.agentHistoryById.update((state) => ({
      ...state,
      [agentId]: { loading: true, data: null, error: null },
    }));

    try {
      const data = await firstValueFrom(this.api.getSubagentHistory(this.sessionId, agentId));
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: {
          loading: false,
          data,
          error: data.transcriptAvailable ? null : data.transcriptError || null,
        },
      }));
    } catch (error) {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      const message =
        (error as { error?: { message?: string } })?.error?.message ||
        (error instanceof Error ? error.message : 'Could not load agent history.');
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: { loading: false, data: null, error: message },
      }));
    }
  }

  private async loadMcpSnapshot(forceRefresh = false): Promise<void> {
    const version = this.bootstrapVersion;
    this.mcpLoading.set(true);
    try {
      const snapshot = await firstValueFrom(this.api.getMcpSnapshot(this.sessionId, forceRefresh));
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.mcpSnapshot.set(snapshot);
    } catch (error) {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      toast.error(this.getHttpErrorMessage(error, 'Could not load MCP servers.'));
    } finally {
      if (version !== this.bootstrapVersion || this.destroyRef.destroyed) return;
      this.mcpLoading.set(false);
    }
  }

  private getHttpErrorMessage(error: unknown, fallback: string): string {
    return (
      (error as { error?: { message?: string } })?.error?.message ||
      (error instanceof Error ? error.message : null) ||
      fallback
    );
  }
}

function buildWorktreeContextPrompt(contextSentence: string, prompt: string): string {
  return [
    '<elevenex-worktree-context>',
    `Context for this session: ${contextSentence}`,
    '</elevenex-worktree-context>',
    '',
    prompt,
  ].join('\n');
}
