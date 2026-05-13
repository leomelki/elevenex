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
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import {
  ClaudeAutocompleteItem,
  ClaudeContextUsage,
  ClaudeHookEvent,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
  ClaudeModelOption,
  ClaudePendingPrompt,
  ClaudePermissionApproval,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeRuntimeSessionMetadata,
  ClaudeRunPhase,
  ClaudeRuntimeEvent,
  ClaudeRuntimeState,
  ClaudeSessionExecutionState,
  ClaudeTaskState,
  ClaudeSubagentState,
  ClaudeToolProgress,
  ClaudeTranscriptItemKind,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '@/shared/models/claude-runtime.model';
import { WorktreeContextSnapshot } from '@/shared/models/worktree-context.model';
import {
  AgentAuthStatus,
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeProviderService } from '@/shared/services/agent-runtime-provider.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import { ClaudeMessageComponent } from './components/claude-message.component';
import { ClaudeThinkingComponent } from './components/claude-thinking.component';
import { ClaudeToolCallComponent } from './components/claude-tool-call.component';
import { ClaudePermissionInlineComponent } from './components/claude-permission-inline.component';
import { ClaudeUserInputComponent } from './components/claude-user-input.component';
import {
  ClaudeComposerComponent,
  ComposerImageAttachment,
  ComposerSendPayload,
} from './components/claude-composer.component';
import { ClaudeStatusBarComponent } from './components/claude-status-bar.component';
import { ClaudeTasksDrawerComponent } from './components/claude-tasks-drawer.component';
import { ClaudeMcpDrawerComponent } from './components/claude-mcp-drawer.component';
import { CodexLoginCardComponent } from './components/codex-login-card.component';
import { PiLoginCardComponent } from './components/pi-login-card.component';
import {
  ClaudeAgentInspectorComponent,
  ClaudeSubagentHistoryState,
} from './components/claude-agent-inspector.component';
import { ClaudeTurnChangesComponent } from './components/claude-turn-changes.component';
import { PairedTranscriptUnit, pairTranscript } from './util/paired-transcript';
import {
  TurnAgentSummary,
  buildTurnAgentSummary,
} from './util/agent-deep-dive';
import { TurnChangeDetails, computeTurnChangeDetails } from './util/turn-change-stats';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideWandSparkles,
  lucideChevronDown,
  lucideGitBranch,
  lucideTriangleAlert,
  lucideRefreshCw,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button/button.component';

type TranscriptRenderItem =
  | { kind: 'unit'; id: string; unit: PairedTranscriptUnit }
  | {
      kind: 'collapsed-turn';
      id: string;
      turnId: string;
      hiddenUnits: PairedTranscriptUnit[];
      durationLabel: string;
      changeDetails: TurnChangeDetails | null;
      stepCount: number;
      agentSummary: TurnAgentSummary | null;
    };

@Component({
  selector: 'app-claude-workspace',
  standalone: true,
  imports: [
    CommonModule,
    ClaudeMessageComponent,
    ClaudeThinkingComponent,
    ClaudeToolCallComponent,
    ClaudePermissionInlineComponent,
    ClaudeUserInputComponent,
    ClaudeComposerComponent,
    ClaudeStatusBarComponent,
    ClaudeTasksDrawerComponent,
    ClaudeMcpDrawerComponent,
    ClaudeAgentInspectorComponent,
    ClaudeTurnChangesComponent,
    CodexLoginCardComponent,
    PiLoginCardComponent,
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
      lucideGitBranch,
      lucideTriangleAlert,
      lucideRefreshCw,
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
  @ViewChild('transcriptContainer') private transcriptContainer?: ElementRef<HTMLDivElement>;
  @ViewChild(ClaudeComposerComponent) private composer?: ClaudeComposerComponent;

  readonly openTerminalFallback = output<void>();
  readonly openInBrowser = output<string>();
  readonly activeAgentProviderChange = output<AgentProviderId>();
  readonly agentRuntimeStarted = output<void>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly ws = inject(ClaudeRuntimeWebsocketService);
  private readonly providerSelection = inject(AgentRuntimeProviderService);
  private readonly sessionsService = inject(SessionsService);
  private readonly claudeStatusService = inject(ClaudeStatusService);
  private readonly worktreeContextService = inject(WorktreeContextService);

  readonly loading = signal(true);
  readonly hydrated = signal(false);
  readonly submitting = signal(false);
  readonly prompt = signal('');
  readonly runPhase = signal<ClaudeRunPhase>('idle');
  readonly sessionState = signal<ClaudeSessionExecutionState>('idle');
  readonly canInterrupt = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly claudeSessionId = signal<string | null>(null);
  readonly providers = signal<AgentRuntimeProviderInfo[]>([]);
  readonly currentProvider = this.providerSelection.selectedProvider;
  readonly currentProviderInfo = computed(() =>
    this.providers().find((provider) => provider.id === this.currentProvider()) ?? null,
  );
  readonly currentProviderSupportsImages = computed(
    () => this.currentProviderInfo()?.capabilities.multimodalPrompts ?? false,
  );
  readonly composerPlaceholder = computed(() => {
    const name = this.currentProviderInfo()?.displayName;
    return name ? `Tell ${name} what to do…` : 'Tell the agent what to do…';
  });
  readonly selectedModel = signal<string | null>(null);
  readonly worktreeContext = signal<WorktreeContextSnapshot | null>(null);
  readonly worktreeContextLoading = signal(false);
  readonly worktreeContextBusy = signal(false);
  readonly firstPromptContextEnabled = signal(true);
  readonly worktreeRootEditorOpen = signal(false);
  readonly draftRootRef = signal('');
  readonly availableModels = signal<ClaudeModelOption[]>([]);
  readonly contextUsage = signal<ClaudeContextUsage | null>(null);
  readonly historyItems = signal<ClaudeTranscriptItem[]>([]);
  readonly liveItems = signal<ClaudeTranscriptItem[]>([]);
  readonly optimisticUserItems = signal<ClaudeTranscriptItem[]>([]);
  readonly pendingPermissionRequest = signal<ClaudePermissionRequest | null>(null);
  readonly pendingUserInputRequest = signal<ClaudeUserInputRequest | null>(null);
  readonly pendingPrompts = signal<ClaudePendingPrompt[]>([]);
  private readonly cancelledPendingPromptIds = new Set<string>();
  private readonly autoApprovedPermissionRequestIds = new Set<string>();
  private interruptedRunShouldRestorePrompt = false;
  private currentRunHadSubstantiveOutput = false;
  private bootstrappedProvider: AgentProviderId | null = null;
  private deferredCodexContextGenerationTimer: number | null = null;
  readonly autocompleteItems = signal<ClaudeAutocompleteItem[]>([]);
  readonly tasks = signal<ClaudeTaskState[]>([]);
  readonly toolProgressByToolUseId = signal<Record<string, ClaudeToolProgress>>({});
  readonly tasksDrawerOpen = signal(false);
  readonly mcpDrawerOpen = signal(false);
  readonly mcpLoading = signal(false);
  readonly mcpSnapshot = signal<ClaudeMcpSnapshot | null>(null);
  readonly mcpBusyServerName = signal<string | null>(null);
  readonly sessionMetadata = signal<ClaudeRuntimeSessionMetadata | null>(null);
  readonly subagents = signal<ClaudeSubagentState[]>([]);
  readonly recentHookEvents = signal<ClaudeHookEvent[]>([]);
  readonly expandedTurns = signal<Record<string, boolean>>({});
  readonly expandedTurnChanges = signal<Record<string, boolean>>({});
  readonly armedEditMessageId = signal<string | null>(null);
  readonly rewindingMessageId = signal<string | null>(null);
  readonly agentInspectorTurnId = signal<string | null>(null);
  readonly agentInspectorSelectedAgentId = signal<string | null>(null);
  readonly agentHistoryById = signal<Record<string, ClaudeSubagentHistoryState>>({});
  readonly _permissionMode = signal<ClaudePermissionMode | null>(null);
  readonly codexAuthStatus = signal<AgentAuthStatus | null>(null);
  readonly piAuthStatus = signal<AgentAuthStatus | null>(null);
  readonly runtimeStarted = signal(false);
  readonly wsConnected = signal(false);
  private wsAutoReconnecting = false;
  private wsStateSub: Subscription | null = null;
  readonly showCodexLogin = computed(() => {
    if (this.currentProvider() !== 'codex') return false;
    const status = this.codexAuthStatus();
    if (!status) return false;
    return status.authenticated !== true;
  });
  readonly showPiLogin = computed(() => {
    if (this.currentProvider() !== 'pi') return false;
    const status = this.piAuthStatus();
    if (!status) return false;
    return status.authenticated !== true;
  });
  private shouldAutoScrollTranscript = true;
  private readonly transcriptBottomThresholdPx = 48;
  private readonly planBypassActive = signal(false);
  readonly permissionMode = computed<ClaudePermissionMode>(() => {
    const server = this._permissionMode() ?? this.sessionMetadata()?.permissionMode ?? 'auto';
    if (this.planBypassActive() && server === 'plan') return 'planBypass' as ClaudePermissionMode;
    return server;
  });
  readonly showLoading = computed(() => this.loading() || !this.hydrated());
  readonly promptIsCommand = computed(() => this.prompt().trimStart().startsWith('/'));
  readonly canAppendContext = computed(
    () =>
      this.firstPromptContextEnabled()
      && !this.hasInjectedContext()
      && !this.promptIsCommand()
      && this.worktreeContext()?.generationStatus === 'ready'
      && !!this.worktreeContext()?.contextSentence,
  );
  readonly hasInjectedContext = signal(false);
  readonly contextExpanded = signal(false);

  readonly contextPinState = computed<'idle' | 'loading' | 'generating' | 'ready' | 'failed' | 'empty'>(
    () => {
      if (this.worktreeContextLoading()) return 'loading';
      const ctx = this.worktreeContext();
      if (!ctx) return 'idle';
      if (ctx.generationStatus === 'generating') return 'generating';
      if (ctx.generationStatus === 'failed') return 'failed';
      if (ctx.contextSentence) return 'ready';
      if (!ctx.hasChanges) return 'empty';
      return 'idle';
    },
  );

  readonly showContextPin = computed(() => {
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
      case 'loading': return 'Reading context…';
      case 'generating': return 'Summarizing…';
      case 'failed': return 'Context unavailable';
      case 'empty': return 'No changes';
      case 'ready': return 'Context';
      default: return 'Context';
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

  readonly contextPinBadge = computed<{ text: string; variant: 'accent' | 'muted' | 'warn' } | null>(() => {
    const ctx = this.worktreeContext();
    if (!ctx) return null;
    if (this.contextPinState() === 'failed') return { text: 'Failed', variant: 'warn' };
    if (this.hasInjectedContext()) return { text: 'Used', variant: 'muted' };
    if (!ctx.contextSentence) return null;
    if (this.promptIsCommand() && this.firstPromptContextEnabled()) return { text: 'Skip', variant: 'muted' };
    return this.firstPromptContextEnabled()
      ? { text: 'On', variant: 'accent' }
      : { text: 'Off', variant: 'muted' };
  });

  readonly canToggleContextEnabled = computed(() => {
    const ctx = this.worktreeContext();
    return !!ctx?.contextSentence && !this.hasInjectedContext();
  });

  readonly firstMessageContext = computed(() => {
    if (!this.hasInjectedContext()) return null;
    const ctx = this.worktreeContext();
    const sentence = ctx?.contextSentence?.trim();
    if (!sentence) return null;
    return { sentence, rootRef: ctx?.rootRef ?? null };
  });

  readonly firstMessageContextExpanded = signal(false);

  toggleFirstMessageContext(): void {
    this.firstMessageContextExpanded.update((v) => !v);
  }

  toggleContextExpanded(): void {
    this.contextExpanded.update((v) => !v);
  }

  toggleContextEnabled(): void {
    if (!this.canToggleContextEnabled()) {
      this.toggleContextExpanded();
      return;
    }
    this.firstPromptContextEnabled.update((v) => !v);
  }

readonly messageActionsDisabled = computed(
    () =>
      this.loading()
      || this.submitting()
      || this.runPhase() !== 'idle'
      || !!this.pendingPermissionRequest()
      || !!this.pendingUserInputRequest()
      || this.rewindingMessageId() !== null,
  );

  private bootstrapVersion = 0;

  private readonly pendingDeltas: Array<{ itemId: string; delta: string }> = [];
  private flushScheduled = false;
  private flushRafId: number | null = null;

  readonly transcriptItems = computed(() =>
    [...this.historyItems(), ...this.optimisticUserItems(), ...this.liveItems()].sort((l, r) =>
      l.timestamp.localeCompare(r.timestamp),
    ),
  );

  readonly topLevelTranscriptItems = computed(() =>
    this.transcriptItems().filter((item) => !item.parentToolUseId),
  );

  readonly childTranscriptItemsByParentToolUseId = computed(() => {
    const grouped: Record<string, ClaudeTranscriptItem[]> = {};
    for (const item of this.transcriptItems()) {
      if (!item.parentToolUseId) continue;
      grouped[item.parentToolUseId] = [...(grouped[item.parentToolUseId] ?? []), item];
    }
    return grouped;
  });

  readonly pairedTranscript = computed<PairedTranscriptUnit[]>(() =>
    pairTranscript(this.topLevelTranscriptItems()),
  );

  readonly renderItems = computed<TranscriptRenderItem[]>(() => {
    const units = this.pairedTranscript();
    const out: TranscriptRenderItem[] = [];
    const isSessionSettled = this.runPhase() === 'idle';

    for (let i = 0; i < units.length; ) {
      const unit = units[i];
      if (!isUserMessageUnit(unit)) {
        out.push({ kind: 'unit', id: unit.id, unit });
        i += 1;
        continue;
      }

      const nextUserOffset = units.slice(i + 1).findIndex(isUserMessageUnit);
      const nextUserIndex = nextUserOffset === -1 ? units.length : i + 1 + nextUserOffset;

      const turnUnits = units.slice(i, nextUserIndex);
      const lastAssistantIndex = findLastAssistantIndex(turnUnits);
      if (lastAssistantIndex === -1) {
        for (const turnUnit of turnUnits) {
          out.push({ kind: 'unit', id: turnUnit.id, unit: turnUnit });
        }
        i = nextUserIndex;
        continue;
      }

      const lastAssistantUnit = turnUnits[lastAssistantIndex] as Extract<
        PairedTranscriptUnit,
        { kind: 'message' }
      >;
      // Split intermediate units two ways, preserving original chronological order
      // within each bucket:
      //   - sibling thinking shares the final assistant message's sourceMessageId, so
      //     it belongs right before that message as a content block of the same reply.
      //   - everything else (intermediate thinking, intermediate assistant text, tool
      //     calls, system messages) is the work that happened during the turn. When
      //     the turn settles it collapses into the "Worked for X" pill in natural
      //     order; expanding the pill replays the work as it actually happened.
      const lastAssistantSourceId = lastAssistantUnit.item.sourceMessageId;
      const intermediateUnits = turnUnits.slice(1, lastAssistantIndex);
      const siblingThinkingUnits: PairedTranscriptUnit[] = [];
      const collapsibleUnits: PairedTranscriptUnit[] = [];
      for (const intermediate of intermediateUnits) {
        if (
          intermediate.kind === 'thinking'
          && lastAssistantSourceId
          && intermediate.item.sourceMessageId === lastAssistantSourceId
        ) {
          siblingThinkingUnits.push(intermediate);
          continue;
        }
        collapsibleUnits.push(intermediate);
      }
      const tailUnits = turnUnits.slice(lastAssistantIndex + 1);
      const isCurrentTurn = nextUserIndex === units.length;
      const hasToolCalls = collapsibleUnits.some((u) => u.kind === 'tool');
      const canCollapse = hasToolCalls && (!isCurrentTurn || isSessionSettled);

      out.push({ kind: 'unit', id: unit.id, unit });

      if (canCollapse) {
        const changeUnits = this.collectTurnChangeUnits(collapsibleUnits);
        out.push({
          kind: 'collapsed-turn',
          id: `collapsed-${unit.id}`,
          turnId: unit.id,
          hiddenUnits: collapsibleUnits,
          durationLabel: formatTurnDuration(
            getItemStartTimestamp(unit.item),
            getItemCompletionTimestamp(lastAssistantUnit.item),
          ),
          changeDetails: computeTurnChangeDetails(changeUnits),
          stepCount: collapsibleUnits.length,
          agentSummary: buildTurnAgentSummary(
            unit.id,
            getItemStartTimestamp(unit.item),
            getItemCompletionTimestamp(lastAssistantUnit.item),
            collapsibleUnits.length,
            this.subagents(),
            this.recentHookEvents(),
          ),
        });
      } else {
        for (const hiddenUnit of collapsibleUnits) {
          out.push({ kind: 'unit', id: hiddenUnit.id, unit: hiddenUnit });
        }
      }

      for (const siblingThinkingUnit of siblingThinkingUnits) {
        out.push({ kind: 'unit', id: siblingThinkingUnit.id, unit: siblingThinkingUnit });
      }
      out.push({ kind: 'unit', id: lastAssistantUnit.id, unit: lastAssistantUnit });
      for (const tailUnit of tailUnits) {
        out.push({ kind: 'unit', id: tailUnit.id, unit: tailUnit });
      }

      i = nextUserIndex;
    }

    return out;
  });

  readonly lastLiveMessageId = computed(() => {
    const live = this.liveItems();
    for (let i = live.length - 1; i >= 0; i--) {
      const item = live[i];
      if (item.kind === 'assistant' || item.kind === 'thinking') return item.id;
    }
    return null;
  });

  readonly lastLiveAssistantMessageId = computed(() => {
    const live = this.liveItems();
    for (let i = live.length - 1; i >= 0; i--) {
      const item = live[i];
      if (item.kind === 'assistant') return item.id;
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
    effect(() => {
      this.pairedTranscript();
      this.runPhase();
      queueMicrotask(() => this.scrollTranscriptToBottomIfPinned());
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

    // While the Codex login card is on screen, poll the auth-status endpoint
    // as a safety net: the codex CLI's exit event is occasionally delayed
    // (long-poll) or missed (WS reconnect race), and the user would otherwise
    // be stuck on a card whose dismissal never arrived.
    effect((onCleanup) => {
      if (!this.showCodexLogin()) return;
      const id = window.setInterval(() => {
        firstValueFrom(this.agentApi.getAuthStatus('codex'))
          .then((status) => this.codexAuthStatus.set(status))
          .catch(() => undefined);
      }, 3000);
      onCleanup(() => window.clearInterval(id));
    });

    effect((onCleanup) => {
      if (!this.showPiLogin()) return;
      const id = window.setInterval(() => {
        firstValueFrom(this.agentApi.getAuthStatus('pi'))
          .then((status) => this.piAuthStatus.set(status))
          .catch(() => undefined);
      }, 3000);
      onCleanup(() => window.clearInterval(id));
    });

    // Proactively fetch PI auth status when the provider is PI but the status
    // hasn't arrived yet from the session snapshot (guards against timing races).
    effect(() => {
      if (this.currentProvider() !== 'pi') return;
      if (this.piAuthStatus() !== null) return;
      void firstValueFrom(this.agentApi.getAuthStatus('pi'))
        .then((status) => this.piAuthStatus.set(status))
        .catch(() => undefined);
    });

    this.destroyRef.onDestroy(() => {
      if (this.flushRafId !== null) {
        cancelAnimationFrame(this.flushRafId);
      }
      if (this.deferredCodexContextGenerationTimer !== null) {
        window.clearTimeout(this.deferredCodexContextGenerationTimer);
      }
      this.ws.disconnect(this.sessionId);
    });
  }

  ngOnInit(): void {
    this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    this.runtimeStarted.set(this.hasStartedAgentRuntime);
    if (this.isVisible) {
      this.providerSelection.setProvider(this.activeAgentProvider);
      void this.bootstrap();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sessionId'] && !changes['sessionId'].firstChange) {
      this.reset();
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
      if (this.isVisible) {
        this.providerSelection.setProvider(this.activeAgentProvider);
        void this.bootstrap();
      }
    }
    if (changes['hasInjectedWorktreeContext'] && !changes['hasInjectedWorktreeContext'].firstChange) {
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
        void this.bootstrap();
      } else {
        void this.loadWorktreeContext(false);
      }
    }
    if (
      changes['activeAgentProvider']
      && this.isVisible
      && !changes['activeAgentProvider'].firstChange
    ) {
      this.providerSelection.setProvider(this.activeAgentProvider);
      if (this.bootstrappedProvider !== this.currentProvider()) {
        this.reset();
        this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
        void this.bootstrap();
      }
    }
  }

  onPromptChange(value: string): void {
    this.prompt.set(value);
  }

  async submitPrompt(payload: ComposerSendPayload | string): Promise<void> {
    const normalized: ComposerSendPayload =
      typeof payload === 'string' ? { text: payload, images: [] } : payload;
    const trimmed = normalized.text.trim();
    const images = this.currentProviderSupportsImages() ? normalized.images : [];
    if (!trimmed && !images.length) return;
    const isIdle = this.runPhase() === 'idle';
    if (isIdle && this.submitting()) return;
    const now = new Date().toISOString();
    if (isIdle) {
      this.currentRunHadSubstantiveOutput = false;
      this.interruptedRunShouldRestorePrompt = false;
      this.submitting.set(true);
      const optimisticContent =
        images.length
          ? [trimmed, ...images.map(() => '[image]')].filter(Boolean).join('\n')
          : trimmed;
      this.optimisticUserItems.update((items) => [
        ...items,
        {
          id: `opt-${Date.now()}`,
          kind: 'user',
          content: optimisticContent,
          timestamp: now,
          authoredAt: now,
        },
      ]);
    }
    this.cancelArmedEdit();
    this.prompt.set('');
    const prepared = this.prepareRuntimePrompt(trimmed);
    this.sendRuntimeAction({
      type: 'submit_prompt',
      prompt: prepared.prompt,
      titlePrompt: trimmed,
      ...(images.length
        ? { images: images.map((i) => this.toRuntimeImage(i)) }
        : {}),
    });
    if (prepared.consumedContextSentence) {
      this.markWorktreeContextConsumed(prepared.consumedContextSentence);
    }
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
    this.cancelledPendingPromptIds.add(id);
    this.sendRuntimeAction({ type: 'cancel_pending_prompt', id });
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
    this.interruptedRunShouldRestorePrompt = true;
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
    const req = this.pendingPermissionRequest();
    if (!req) return;
    this.sendRuntimeAction({
      type: 'deny_permission',
      requestId: req.requestId,
      message: message?.trim() || undefined,
    });
  }

  answerUserInput(payload: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }): void {
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
    const next = await firstValueFrom(this.api.setSelectedModel(this.sessionId, model || null));
    this.applyRuntimeState(next);
  }

  async onPermissionModeChange(mode: ClaudePermissionMode): Promise<void> {
    if (this.currentProvider() === 'codex' && (mode === ('planBypass' as ClaudePermissionMode) || mode === 'auto')) {
      mode = 'default';
    }
    if (mode === ('planBypass' as ClaudePermissionMode)) {
      this.planBypassActive.set(true);
      const next = await firstValueFrom(this.api.setPermissionMode(this.sessionId, 'plan'));
      this.applyRuntimeState(next);
    } else {
      this.planBypassActive.set(false);
      const next = await firstValueFrom(this.api.setPermissionMode(this.sessionId, mode || null));
      this.applyRuntimeState(next);
    }
  }

  openTerminal(): void {
    if (this.currentProvider() !== 'claude') {
      toast.message('Raw terminal fallback is only available for Claude Code.');
      return;
    }
    void firstValueFrom(this.api.openTerminalFallback(this.sessionId)).finally(() =>
      this.openTerminalFallback.emit(),
    );
  }

  onProviderChange(provider: AgentProviderId): void {
    if (provider === this.currentProvider()) return;
    if (this.runtimeStarted()) {
      toast.message('Provider can only be changed before the session is started.');
      return;
    }
    this.ws.disconnect(this.sessionId);
    this.providerSelection.setProvider(provider);
    this.activeAgentProvider = provider;
    this.activeAgentProviderChange.emit(provider);
    void firstValueFrom(this.sessionsService.updateActiveAgentProvider(this.sessionId, provider))
      .catch(() => undefined);
    this.reset();
    this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    void this.bootstrap();
  }

  openMcpDrawer(): void {
    this.mcpDrawerOpen.set(true);
    void this.loadMcpSnapshot();
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

  onCodexAuthenticated(): void {
    void firstValueFrom(this.agentApi.getAuthStatus('codex'))
      .then((status) => this.codexAuthStatus.set(status))
      .catch(() => undefined);
  }

  onPiAuthenticated(): void {
    void firstValueFrom(this.agentApi.getAuthStatus('pi'))
      .then((status) => this.piAuthStatus.set(status))
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

  isLiveToolUse(toolUseId: string): boolean {
    return this.liveItems().some((item) => item.kind === 'tool_use' && item.toolUseId === toolUseId);
  }

  toolProgressForToolUse(toolUseId: string): ClaudeToolProgress | null {
    return this.toolProgressByToolUseId()[toolUseId] ?? null;
  }

  childItemsForToolUse(toolUseId: string): ClaudeTranscriptItem[] {
    return this.childTranscriptItemsByParentToolUseId()[toolUseId] ?? [];
  }

  private collectTurnChangeUnits(units: PairedTranscriptUnit[]): PairedTranscriptUnit[] {
    const collected: PairedTranscriptUnit[] = [];
    const childItemsByParent = this.childTranscriptItemsByParentToolUseId();
    const visit = (entries: PairedTranscriptUnit[]) => {
      for (const entry of entries) {
        collected.push(entry);
        if (entry.kind !== 'tool') continue;
        const children = childItemsByParent[entry.toolUseId] ?? [];
        if (children.length) {
          visit(pairTranscript(children));
        }
      }
    };
    visit(units);
    return collected;
  }

  isStreamingMessage(itemId: string): boolean {
    return this.runPhase() === 'running' && this.lastLiveMessageId() === itemId;
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

  canShowMessageActions(item: ClaudeTranscriptItem): boolean {
    return item.kind === 'user' && !!item.sourceMessageId;
  }

  isEditArmed(item: ClaudeTranscriptItem): boolean {
    return !!item.sourceMessageId && this.armedEditMessageId() === item.sourceMessageId;
  }

  async copyMessage(item: ClaudeTranscriptItem, selectedText?: string | null): Promise<void> {
    const selectedContent = typeof selectedText === 'string' ? selectedText.trim() : '';
    const itemContent = typeof item.content === 'string' ? item.content.trim() : '';
    const content = selectedContent || itemContent;
    if (!content || this.messageActionsDisabled()) return;
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard is not available.');
      return;
    }

    try {
      await navigator.clipboard.writeText(content);
      toast.success('Message copied');
    } catch {
      toast.error('Could not copy message.');
    }
  }

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
        (error as { error?: { message?: string } })?.error?.message
        || (error instanceof Error ? error.message : null)
        || 'Could not rewind the conversation.';
      toast.error(message);
    }
  }

  private async restorePromptFromMessage(
    item: ClaudeTranscriptItem,
  ): Promise<void> {
    const messageId = item.sourceMessageId;
    const content = item.content ?? '';
    if (!messageId) return;

    this.rewindingMessageId.set(messageId);
    try {
      const [history, runtimeState] = await Promise.all([
        firstValueFrom(this.api.rewindConversation(this.sessionId, messageId)),
        firstValueFrom(this.api.getRuntimeState(this.sessionId)),
      ]);

      this.historyItems.set(
        [...history].sort((l, r) => l.timestamp.localeCompare(r.timestamp)),
      );
      this.applyRuntimeState(runtimeState);
      this.optimisticUserItems.set([]);
      this.liveItems.set([]);
      this.pendingPermissionRequest.set(null);
      this.pendingUserInputRequest.set(null);
      this.expandedTurns.set({});
      this.expandedTurnChanges.set({});
      this.prompt.set(content);
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

  private rehydrate(): void {
    this.ws.disconnect(this.sessionId);
    this.ws
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleRuntimeEvent(event));
    this.ws.send(this.sessionId, { type: 'hydrate' });
  }

  private sendRuntimeAction(message: Record<string, unknown>): void {
    if (!this.ws.isConnected(this.sessionId)) {
      this.rehydrate();
    }
    this.ws.send(this.sessionId, message);
  }

  private subscribeConnectionState(): void {
    this.wsStateSub?.unsubscribe();
    this.wsStateSub = this.ws
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
    void this.loadWorktreeContext(true);
    void this.loadProviders();

    this.ws
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleRuntimeEvent(event));

    this.subscribeConnectionState();

    this.ws.send(this.sessionId, { type: 'hydrate' });

    try {
      await this.refreshAutocomplete(version);
    } finally {
      if (version === this.bootstrapVersion) this.loading.set(false);
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
    const rootRef = this.draftRootRef().trim() || null;
    this.worktreeContextBusy.set(true);
    try {
      await firstValueFrom(this.worktreeContextService.updateRootRef(this.repoId, this.worktreePath, rootRef));
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.repoId, this.worktreePath, {
          force: true,
          rootRef,
          provider: this.currentProvider(),
        }),
      );
      this.worktreeContext.set(snapshot);
      this.worktreeRootEditorOpen.set(false);
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not update the comparison root.'));
    } finally {
      this.worktreeContextBusy.set(false);
    }
  }

  async recomputeWorktreeContext(): Promise<void> {
    if (this.worktreeContextBusy()) return;
    this.worktreeContextBusy.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.repoId, this.worktreePath, {
          force: true,
          provider: this.currentProvider(),
        }),
      );
      this.worktreeContext.set(snapshot);
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not recompute worktree context.'));
    } finally {
      this.worktreeContextBusy.set(false);
    }
  }

  private async loadWorktreeContext(triggerGenerate = true): Promise<void> {
    this.worktreeContextLoading.set(true);
    const deferCodexGeneration =
      triggerGenerate
      && this.currentProvider() === 'codex'
      && !this.runtimeStarted();
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.get(this.repoId, this.worktreePath, {
          cachedOnly: deferCodexGeneration,
        }),
      );
      this.worktreeContext.set(snapshot);
      this.draftRootRef.set(snapshot.rootRef ?? '');

      const shouldAutoGenerate =
        triggerGenerate
        && !deferCodexGeneration
        && !snapshot.hasRecord
        && snapshot.canGenerate
        && snapshot.generationStatus !== 'generating'
        && !this.worktreeContextBusy();

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
        this.worktreeContext.set(generated);
        console.info(
          `[worktree-context] first-time generation settled for ${this.worktreePath} (status=${generated.generationStatus})`,
        );
      } else if (triggerGenerate) {
        console.info(
          `[worktree-context] skipping auto-generate for ${this.worktreePath} (hasRecord=${snapshot.hasRecord}, canGenerate=${snapshot.canGenerate}, status=${snapshot.generationStatus})`,
        );
        if (deferCodexGeneration) {
          this.scheduleDeferredCodexContextGeneration();
        }
      }
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not load worktree context.'));
    } finally {
      this.worktreeContextLoading.set(false);
      this.worktreeContextBusy.set(false);
    }
  }

  private scheduleDeferredCodexContextGeneration(): void {
    if (this.currentProvider() !== 'codex') return;
    if (!this.runtimeStarted()) return;
    if (this.hasInjectedContext()) return;
    const context = this.worktreeContext();
    if (!context?.canGenerate || context.contextSentence) return;
    if (this.deferredCodexContextGenerationTimer !== null) return;

    this.deferredCodexContextGenerationTimer = window.setTimeout(() => {
      this.deferredCodexContextGenerationTimer = null;
      if (
        this.currentProvider() !== 'codex'
        || !this.runtimeStarted()
        || this.hasInjectedContext()
        || this.runPhase() !== 'idle'
        || this.submitting()
        || this.worktreeContextBusy()
        || this.worktreeContextLoading()
        || this.worktreeContext()?.contextSentence
      ) {
        this.scheduleDeferredCodexContextGeneration();
        return;
      }
      void this.loadWorktreeContext(true);
    }, 1500);
  }

  private async refreshAutocomplete(version: number = this.bootstrapVersion): Promise<void> {
    const autocompleteItems = await firstValueFrom(
      this.api.getAutocompleteItems(this.sessionId),
    );
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
        this.historyItems.set(event.payload.history);
        this.applyRuntimeState(event.payload);
        this.hydrated.set(true);
        return;
      case 'session_created':
        this.claudeSessionId.set(event.payload.claudeSessionId);
        this.runtimeStarted.set(true);
        this.agentRuntimeStarted.emit();
        return;
      case 'session_metadata':
        this.sessionMetadata.set(event.payload.metadata);
        void this.refreshAutocomplete();
        return;
      case 'hook_event':
        this.recentHookEvents.update((items) => [event.payload.hookEvent, ...items].slice(0, 50));
        return;
      case 'subagent_lifecycle':
        this.subagents.update((items) => [
          event.payload.subagent,
          ...items.filter((agent) => agent.agentId !== event.payload.subagent.agentId),
        ]);
        return;
      case 'run_state':
        if (event.payload.runPhase === 'running' && this.runPhase() !== 'running') {
          this.currentRunHadSubstantiveOutput = false;
          this.interruptedRunShouldRestorePrompt = false;
        }
        this.runPhase.set(event.payload.runPhase);
        this.sessionState.set(event.payload.sessionState);
        this.canInterrupt.set(event.payload.canInterrupt);
        this.lastError.set(event.payload.lastError);
        this.selectedModel.set(event.payload.selectedModel);
        this.availableModels.set(event.payload.availableModels);
        this.contextUsage.set(event.payload.contextUsage);
        if (event.payload.permissionMode != null) {
          this._permissionMode.set(event.payload.permissionMode);
        }
        this.applyPendingPermissionFromRuntime(event.payload.pendingPermissionRequest);
        this.pendingUserInputRequest.set(event.payload.pendingUserInputRequest);
        this.updatePendingPrompts(event.payload.pendingPrompts ?? []);
        if (event.payload.runPhase !== 'running') this.submitting.set(false);
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
      case 'tool_progress':
        this.toolProgressByToolUseId.update((items) => ({
          ...items,
          [event.payload.progress.toolUseId]: event.payload.progress,
        }));
        return;
      case 'message_start':
        this.upsertLiveItem(event.payload.item);
        return;
      case 'tool_use':
      case 'tool_result':
        this.currentRunHadSubstantiveOutput = true;
        this.interruptedRunShouldRestorePrompt = false;
        this.upsertLiveItem(event.payload.item);
        return;
      case 'thinking_start':
        this.upsertLiveItem(event.payload.item);
        return;
      case 'message_delta':
        if (event.payload.delta.trim()) {
          this.currentRunHadSubstantiveOutput = true;
          this.interruptedRunShouldRestorePrompt = false;
        }
        this.enqueueDelta(event.payload.itemId, event.payload.delta);
        return;
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
        this.pendingPermissionRequest.set(null);
        this.liveItems.update((items) =>
          items.map((item) =>
            item.kind === 'tool_use' && item.toolUseId === event.payload.toolUseId
              ? { ...item, interaction: event.payload.interaction }
              : item,
          ),
        );
        return;
      case 'user_input_request':
        this.pendingUserInputRequest.set(event.payload.request);
        return;
      case 'error': {
        const now = new Date().toISOString();
        this.lastError.set(event.payload.message);
        this.liveItems.update((items) => [
          ...items,
          {
            id: `err-${Date.now()}`,
            kind: 'error',
            content: event.payload.message,
            timestamp: now,
            receivedAt: now,
          },
        ]);
        this.submitting.set(false);
        return;
      }
      case 'complete':
        this.autoApprovedPermissionRequestIds.clear();
        this.pendingPermissionRequest.set(null);
        this.pendingUserInputRequest.set(null);
        this.submitting.set(false);
        if (this.mcpDrawerOpen()) {
          void this.loadMcpSnapshot(true);
        }
        void this.handleCompletion();
        return;
      case 'auth_status':
        if (this.currentProvider() === 'codex') {
          this.codexAuthStatus.set(event.payload.status as AgentAuthStatus);
        } else if (this.currentProvider() === 'pi') {
          this.piAuthStatus.set(event.payload.status as AgentAuthStatus);
        }
        return;
      default:
        return;
    }
  }

  private async handleCompletion(version: number = this.bootstrapVersion): Promise<void> {
    await this.syncHistoryAfterCompletion();
    if (version !== this.bootstrapVersion) return;

    await this.restoreInterruptedPromptIfNothingSubstantiveHappened();
    this.scheduleDeferredCodexContextGeneration();
  }

  private upsertLiveItem(item: ClaudeTranscriptItem): void {
    this.liveItems.update((items) => [
      ...items.filter((existing) => existing.id !== item.id),
      item,
    ]);
  }

  private async restoreInterruptedPromptIfNothingSubstantiveHappened(): Promise<boolean> {
    if (!this.interruptedRunShouldRestorePrompt) return false;
    this.interruptedRunShouldRestorePrompt = false;
    if (this.currentRunHadSubstantiveOutput) return false;

    const transcriptItems = this.transcriptItems();
    const lastUser = findLastTopLevelUserMessage(transcriptItems);
    if (!lastUser?.sourceMessageId) return false;

    if (hasSubstantiveOutputAfterMessage(transcriptItems, lastUser.id)) {
      return false;
    }

    try {
      await this.restorePromptFromMessage(lastUser);
      return true;
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not restore the interrupted prompt.'));
      return false;
    }
  }

  private async syncHistoryAfterCompletion(): Promise<void> {
    const preSyncLiveItems = this.liveItems();
    const preSyncOptimisticUserItems = this.optimisticUserItems();
    const history = await firstValueFrom(this.api.getHistory(this.sessionId));

    // Streaming items and history items use different ID formats:
    //   Streaming text:    msg_abc:0              History text:    msg_abc:assistant:0
    //   Streaming thinking: msg_abc:1             History thinking: msg_abc:thinking:1
    //   Streaming tool:    msg_abc:tool:toolu_x   History tool:    msg_abc:tool_use:toolu_x
    // Exact-ID dedup fails for these, so we match by UUID prefix + kind + content block index
    // in addition to exact ID and toolUseId matching.
    const historyIds = new Set(history.map((i) => i.id));
    const historyToolUseIds = new Set(
      history.map((i) => i.toolUseId).filter((id): id is string => !!id),
    );

    type KindKey = `${string}:${ClaudeTranscriptItemKind}`;
    const historyKindKeys = new Set<KindKey>();
    const historyContentKeys = new Set<KindKey>();
    for (const item of history) {
      const colonIdx = item.id.indexOf(':');
      if (colonIdx >= 0) {
        historyKindKeys.add(`${item.id.slice(0, colonIdx)}:${item.kind}`);
      }
      const contentKey = this.transcriptContentKey(item);
      if (contentKey) {
        historyContentKeys.add(contentKey);
      }
    }

    // Keep live items not already represented in history so tool calls are never
    // lost when the JSONL hasn't flushed before this call resolves.
    const liveToMerge = preSyncLiveItems.filter((item) => {
      if (historyIds.has(item.id)) return false;
      if (item.toolUseId && historyToolUseIds.has(item.toolUseId)) return false;
      const colonIdx = item.id.indexOf(':');
      if (colonIdx >= 0) {
        const key: KindKey = `${item.id.slice(0, colonIdx)}:${item.kind}`;
        if (historyKindKeys.has(key)) return false;
      }
      const contentKey = this.transcriptContentKey(item);
      if (contentKey && historyContentKeys.has(contentKey)) return false;
      return true;
    });

    // Optimistic user items have ids like `opt-<ts>` that never appear in history,
    // so match by trimmed content as a multiset: each history user message consumes
    // at most one optimistic item, preserving legitimate duplicate prompts. Unmatched
    // optimistic items stay visible until the next sync picks them up — otherwise the
    // first user bubble disappears when the JSONL hasn't flushed yet.
    const historyUserCounts = new Map<string, number>();
    for (const item of history) {
      if (item.kind !== 'user') continue;
      const key = (item.content ?? '').trim();
      historyUserCounts.set(key, (historyUserCounts.get(key) ?? 0) + 1);
    }
    const optimisticToKeep = preSyncOptimisticUserItems.filter((item) => {
      const key = (item.content ?? '').trim();
      const remaining = historyUserCounts.get(key) ?? 0;
      if (remaining > 0) {
        historyUserCounts.set(key, remaining - 1);
        return false;
      }
      return true;
    });

    this.historyItems.set(
      [...history, ...liveToMerge].sort((l, r) => l.timestamp.localeCompare(r.timestamp)),
    );
    this.optimisticUserItems.set(optimisticToKeep);
    this.liveItems.set(preSyncLiveItems.filter((item) => item.kind === 'error'));
  }

  private transcriptContentKey(item: ClaudeTranscriptItem): `${string}:${ClaudeTranscriptItemKind}` | null {
    if (item.kind !== 'assistant' && item.kind !== 'thinking') {
      return null;
    }
    const content = item.content?.trim().replace(/\s+/g, ' ');
    return content ? `${content}:${item.kind}` : null;
  }

  private applyRuntimeState(state: ClaudeRuntimeState): void {
    this.liveItems.set(state.liveItems);
    this.runPhase.set(state.runPhase);
    this.sessionState.set(state.sessionState);
    this.canInterrupt.set(state.canInterrupt);
    this.claudeSessionId.set(state.claudeSessionId);
    this.selectedModel.set(state.selectedModel);
    this.availableModels.set(state.availableModels);
    this.contextUsage.set(state.contextUsage);
    this._permissionMode.set(state.permissionMode);
    this.applyPendingPermissionFromRuntime(state.pendingPermissionRequest);
    this.pendingUserInputRequest.set(state.pendingUserInputRequest);
    this.updatePendingPrompts(state.pendingPrompts ?? []);
    this.lastError.set(state.lastError);
    this.tasks.set(state.tasks);
    this.toolProgressByToolUseId.set(
      state.latestToolProgress
        ? { [state.latestToolProgress.toolUseId]: state.latestToolProgress }
        : {},
    );
    this.sessionMetadata.set(state.sessionMetadata);
    this.subagents.set(state.subagents);
    this.recentHookEvents.set(state.recentHookEvents);
    if (this.currentProvider() === 'codex') {
      this.codexAuthStatus.set((state.authStatus ?? null) as AgentAuthStatus | null);
      this.piAuthStatus.set(null);
    } else if (this.currentProvider() === 'pi') {
      this.piAuthStatus.set((state.authStatus ?? null) as AgentAuthStatus | null);
      this.codexAuthStatus.set(null);
    } else {
      this.codexAuthStatus.set(null);
      this.piAuthStatus.set(null);
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
    if (!this.planBypassActive()) return false;
    const toolName = (req.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const noAutoApprove = new Set(['exitplanmode', 'askuserquestion']);
    return !noAutoApprove.has(toolName);
  }

  private reset(): void {
    this.bootstrapVersion += 1;
    this.wsAutoReconnecting = false;
    this.wsConnected.set(false);
    if (this.flushRafId !== null) {
      cancelAnimationFrame(this.flushRafId);
      this.flushRafId = null;
      this.flushScheduled = false;
      this.pendingDeltas.length = 0;
    }
    this.ws.disconnect(this.sessionId);
    this.autoApprovedPermissionRequestIds.clear();
    this.loading.set(true);
    this.hydrated.set(false);
    this.submitting.set(false);
    this.prompt.set('');
    this.runPhase.set('idle');
    this.sessionState.set('idle');
    this.canInterrupt.set(false);
    this.lastError.set(null);
    this.claudeSessionId.set(null);
    this.selectedModel.set(null);
    this.worktreeContext.set(null);
    this.worktreeContextLoading.set(false);
    this.worktreeContextBusy.set(false);
    this.firstPromptContextEnabled.set(true);
    if (this.deferredCodexContextGenerationTimer !== null) {
      window.clearTimeout(this.deferredCodexContextGenerationTimer);
      this.deferredCodexContextGenerationTimer = null;
    }
    this.worktreeRootEditorOpen.set(false);
    this.draftRootRef.set('');
    this.availableModels.set([]);
    this.contextUsage.set(null);
    this._permissionMode.set(null);
    this.planBypassActive.set(false);
    this.historyItems.set([]);
    this.liveItems.set([]);
    this.optimisticUserItems.set([]);
    this.pendingPermissionRequest.set(null);
    this.pendingUserInputRequest.set(null);
    this.pendingPrompts.set([]);
    this.cancelledPendingPromptIds.clear();
    this.autocompleteItems.set([]);
    this.tasks.set([]);
    this.toolProgressByToolUseId.set({});
    this.tasksDrawerOpen.set(false);
    this.mcpDrawerOpen.set(false);
    this.mcpLoading.set(false);
    this.mcpSnapshot.set(null);
    this.mcpBusyServerName.set(null);
    this.sessionMetadata.set(null);
    this.subagents.set([]);
    this.recentHookEvents.set([]);
    this.codexAuthStatus.set(null);
    this.piAuthStatus.set(null);
    this.bootstrappedProvider = null;
    this.runtimeStarted.set(this.hasStartedAgentRuntime);
    this.expandedTurns.set({});
    this.expandedTurnChanges.set({});
    this.armedEditMessageId.set(null);
    this.rewindingMessageId.set(null);
    this.interruptedRunShouldRestorePrompt = false;
    this.currentRunHadSubstantiveOutput = false;
    this.closeAgentInspector();
    this.agentHistoryById.set({});
    this.shouldAutoScrollTranscript = true;
  }

  onTranscriptScroll(): void {
    const el = this.transcriptContainer?.nativeElement;
    if (!el) return;
    this.shouldAutoScrollTranscript = this.isTranscriptScrolledToBottom(el);
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

  private enqueueDelta(itemId: string, delta: string): void {
    this.pendingDeltas.push({ itemId, delta });
    this.scheduleFlush();
  }

  private prepareRuntimePrompt(prompt: string): {
    prompt: string;
    consumedContextSentence: string | null;
  } {
    if (
      this.hasInjectedContext()
      || !this.firstPromptContextEnabled()
      || prompt.trimStart().startsWith('/')
    ) {
      return { prompt, consumedContextSentence: null };
    }

    const localContextSentence = this.worktreeContext()?.contextSentence?.trim();
    if (
      this.worktreeContext()?.generationStatus !== 'ready'
      || !localContextSentence
    ) {
      return { prompt, consumedContextSentence: null };
    }

    this.hasInjectedContext.set(true);
    this.worktreeContext.update(snapshot =>
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
      console.warn(
        '[worktree-context] failed to mark first-message context consumed',
        error,
      );
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.flushRafId = requestAnimationFrame(() => this.flushDeltas());
  }

  private flushDeltas(): void {
    this.flushRafId = null;
    this.flushScheduled = false;
    const deltas = this.pendingDeltas.splice(0);
    if (deltas.length === 0) return;
    this.liveItems.update((items) => {
      let result = items;
      for (const { itemId, delta } of deltas) {
        result = result.map((item) =>
          item.id === itemId
            ? { ...item, content: `${item.content ?? ''}${delta}` }
            : item,
        );
      }
      return result;
    });
  }

  trackByRenderItem(_i: number, item: TranscriptRenderItem): string {
    return item.id;
  }

  private async ensureAgentHistory(agentId: string): Promise<void> {
    const current = this.agentHistoryById()[agentId];
    if (current?.loading || current?.data) return;

    this.agentHistoryById.update((state) => ({
      ...state,
      [agentId]: { loading: true, data: null, error: null },
    }));

    try {
      const data = await firstValueFrom(
        this.api.getSubagentHistory(this.sessionId, agentId),
      );
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
        (error as { error?: { message?: string } })?.error?.message
        || (error instanceof Error ? error.message : 'Could not load agent history.');
      this.agentHistoryById.update((state) => ({
        ...state,
        [agentId]: { loading: false, data: null, error: message },
      }));
    }
  }

  private async loadMcpSnapshot(forceRefresh = false): Promise<void> {
    this.mcpLoading.set(true);
    try {
      const snapshot = await firstValueFrom(this.api.getMcpSnapshot(this.sessionId, forceRefresh));
      this.mcpSnapshot.set(snapshot);
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not load MCP servers.'));
    } finally {
      this.mcpLoading.set(false);
    }
  }

  private getHttpErrorMessage(error: unknown, fallback: string): string {
    return (
      (error as { error?: { message?: string } })?.error?.message
      || (error instanceof Error ? error.message : null)
      || fallback
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

function isUserMessageUnit(unit: PairedTranscriptUnit): unit is Extract<PairedTranscriptUnit, { kind: 'message' }> {
  return unit.kind === 'message' && unit.item.kind === 'user';
}

function isAssistantMessageUnit(
  unit: PairedTranscriptUnit,
): unit is Extract<PairedTranscriptUnit, { kind: 'message' }> {
  return unit.kind === 'message' && unit.item.kind === 'assistant';
}

function findLastAssistantIndex(units: PairedTranscriptUnit[]): number {
  for (let i = units.length - 1; i >= 0; i--) {
    if (isAssistantMessageUnit(units[i])) return i;
  }
  return -1;
}

function findLastTopLevelUserMessage(items: ClaudeTranscriptItem[]): ClaudeTranscriptItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === 'user' && !item.parentToolUseId) return item;
  }
  return null;
}

function hasSubstantiveOutputAfterMessage(items: ClaudeTranscriptItem[], messageId: string): boolean {
  const index = items.findIndex((item) => item.id === messageId);
  if (index === -1) return true;

  return items.slice(index + 1).some((item) => {
    if (item.kind === 'assistant') return !!item.content?.trim();
    return item.kind === 'tool_use' || item.kind === 'tool_result';
  });
}

function formatTurnDuration(startedAt: string, completedAt: string): string {
  const ms = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${Math.max(1, totalSeconds)}s`;
  if (seconds === 0) return `${minutes}m`;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m ${seconds}s`;
}

function getItemStartTimestamp(item: ClaudeTranscriptItem): string {
  return item.authoredAt || item.receivedAt || item.timestamp;
}

function getItemCompletionTimestamp(item: ClaudeTranscriptItem): string {
  return item.receivedAt || item.authoredAt || item.timestamp;
}
