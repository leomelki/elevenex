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
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
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
  ClaudeTranscriptItemKind,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '@/shared/models/claude-runtime.model';
import { WorktreeContextSnapshot } from '@/shared/models/worktree-context.model';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import { ClaudeMessageComponent } from './components/claude-message.component';
import { ClaudeThinkingComponent } from './components/claude-thinking.component';
import { ClaudeToolCallComponent } from './components/claude-tool-call.component';
import { ClaudePermissionInlineComponent } from './components/claude-permission-inline.component';
import { ClaudeUserInputComponent } from './components/claude-user-input.component';
import { ClaudeComposerComponent } from './components/claude-composer.component';
import { ClaudeStatusBarComponent } from './components/claude-status-bar.component';
import { ClaudeTasksDrawerComponent } from './components/claude-tasks-drawer.component';
import { ClaudeMcpDrawerComponent } from './components/claude-mcp-drawer.component';
import {
  ClaudeAgentInspectorComponent,
  ClaudeSubagentHistoryState,
} from './components/claude-agent-inspector.component';
import { PairedTranscriptUnit, pairTranscript } from './util/paired-transcript';
import {
  TurnAgentSummary,
  buildTurnAgentSummary,
} from './util/agent-deep-dive';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideWandSparkles,
  lucideChevronDown,
  lucideGitBranch,
  lucideTriangleAlert,
  lucideRefreshCw,
} from '@ng-icons/lucide';

type TranscriptRenderItem =
  | { kind: 'unit'; id: string; unit: PairedTranscriptUnit }
  | {
      kind: 'collapsed-turn';
      id: string;
      turnId: string;
      hiddenUnits: PairedTranscriptUnit[];
      durationLabel: string;
      stepCount: number;
      agentSummary: TurnAgentSummary | null;
    };

const WORKTREE_CONTEXT_SEND_BUDGET_MS = 150;

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
    NgIcon,
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
  @Input() isVisible = false;
  @ViewChild('transcriptContainer') private transcriptContainer?: ElementRef<HTMLDivElement>;
  @ViewChild(ClaudeComposerComponent) private composer?: ClaudeComposerComponent;

  readonly openTerminalFallback = output<void>();
  readonly openInBrowser = output<string>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly api = inject(ClaudeRuntimeApiService);
  private readonly ws = inject(ClaudeRuntimeWebsocketService);
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
  readonly autocompleteItems = signal<ClaudeAutocompleteItem[]>([]);
  readonly tasks = signal<ClaudeTaskState[]>([]);
  readonly tasksDrawerOpen = signal(false);
  readonly mcpDrawerOpen = signal(false);
  readonly mcpLoading = signal(false);
  readonly mcpSnapshot = signal<ClaudeMcpSnapshot | null>(null);
  readonly mcpBusyServerName = signal<string | null>(null);
  readonly sessionMetadata = signal<ClaudeRuntimeSessionMetadata | null>(null);
  readonly subagents = signal<ClaudeSubagentState[]>([]);
  readonly recentHookEvents = signal<ClaudeHookEvent[]>([]);
  readonly expandedTurns = signal<Record<string, boolean>>({});
  readonly armedEditMessageId = signal<string | null>(null);
  readonly rewindingMessageId = signal<string | null>(null);
  readonly agentInspectorTurnId = signal<string | null>(null);
  readonly agentInspectorSelectedAgentId = signal<string | null>(null);
  readonly agentHistoryById = signal<Record<string, ClaudeSubagentHistoryState>>({});
  readonly _permissionMode = signal<ClaudePermissionMode | null>(null);
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
        out.push({
          kind: 'collapsed-turn',
          id: `collapsed-${unit.id}`,
          turnId: unit.id,
          hiddenUnits: collapsibleUnits,
          durationLabel: formatTurnDuration(
            getItemStartTimestamp(unit.item),
            getItemCompletionTimestamp(lastAssistantUnit.item),
          ),
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
      queueMicrotask(() => this.scrollToBottom());
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

    this.destroyRef.onDestroy(() => {
      if (this.flushRafId !== null) {
        cancelAnimationFrame(this.flushRafId);
      }
      this.ws.disconnect(this.sessionId);
    });
  }

  ngOnInit(): void {
    this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    void this.bootstrap();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['sessionId'] && !changes['sessionId'].firstChange) {
      this.reset();
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
      void this.bootstrap();
    }
    if (changes['hasInjectedWorktreeContext'] && !changes['hasInjectedWorktreeContext'].firstChange) {
      this.hasInjectedContext.set(this.hasInjectedWorktreeContext);
    }
    if (changes['isVisible'] && this.isVisible && !changes['isVisible'].firstChange) {
      void this.loadWorktreeContext(false);
    }
  }

  onPromptChange(value: string): void {
    this.prompt.set(value);
  }

  async submitPrompt(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const isIdle = this.runPhase() === 'idle';
    if (isIdle && this.submitting()) return;
    const now = new Date().toISOString();
    if (isIdle) {
      this.submitting.set(true);
      this.optimisticUserItems.update((items) => [
        ...items,
        {
          id: `opt-${Date.now()}`,
          kind: 'user',
          content: trimmed,
          timestamp: now,
          authoredAt: now,
        },
      ]);
    }
    this.cancelArmedEdit();
    this.prompt.set('');
    const runtimePrompt = await this.prepareRuntimePrompt(trimmed);
    this.ws.send(this.sessionId, { type: 'submit_prompt', prompt: runtimePrompt });
  }

  cancelPendingPrompt(id: string): void {
    this.ws.send(this.sessionId, { type: 'cancel_pending_prompt', id });
  }

  interrupt(): void {
    this.ws.send(this.sessionId, { type: 'interrupt' });
  }

  private autoApprovePermission(requestId: string): void {
    this.ws.send(this.sessionId, {
      type: 'approve_permission',
      requestId,
      remember: false,
    });
  }

  approvePermission(approval: ClaudePermissionApproval): void {
    const req = this.pendingPermissionRequest();
    if (!req) return;
    this.ws.send(this.sessionId, {
      type: 'approve_permission',
      requestId: req.requestId,
      remember: approval.remember,
      content: approval.content,
    });
  }

  denyPermission(message?: string): void {
    const req = this.pendingPermissionRequest();
    if (!req) return;
    this.ws.send(this.sessionId, {
      type: 'deny_permission',
      requestId: req.requestId,
      message: message?.trim() || undefined,
    });
  }

  answerUserInput(payload: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }): void {
    const req = this.pendingUserInputRequest();
    if (!req) return;
    this.ws.send(this.sessionId, {
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
    void firstValueFrom(this.api.openTerminalFallback(this.sessionId)).finally(() =>
      this.openTerminalFallback.emit(),
    );
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

  childItemsForToolUse(toolUseId: string): ClaudeTranscriptItem[] {
    return this.childTranscriptItemsByParentToolUseId()[toolUseId] ?? [];
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

  async copyMessage(item: ClaudeTranscriptItem): Promise<void> {
    const content = item.content?.trim();
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
    const messageId = item.sourceMessageId;
    const content = item.content ?? '';
    if (!messageId || this.messageActionsDisabled()) return;

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
      this.prompt.set(content);
      this.cancelArmedEdit();
      this.closeAgentInspector();
      toast.success('Message restored for editing');
      queueMicrotask(() => this.composer?.focusAtEnd());
    } catch (error) {
      const message =
        (error as { error?: { message?: string } })?.error?.message
        || (error instanceof Error ? error.message : null)
        || 'Could not rewind the conversation.';
      toast.error(message);
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

  private async bootstrap(): Promise<void> {
    const version = ++this.bootstrapVersion;
    this.loading.set(true);
    void this.loadWorktreeContext(true);

    this.ws
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleRuntimeEvent(event));

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
        this.worktreeContextService.generate(this.repoId, this.worktreePath, { force: true, rootRef }),
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
    this.worktreeContextBusy.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.repoId, this.worktreePath, { force: true }),
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
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.get(this.repoId, this.worktreePath),
      );
      this.worktreeContext.set(snapshot);
      this.draftRootRef.set(snapshot.rootRef ?? '');

      const shouldAutoGenerate =
        triggerGenerate
        && !snapshot.hasRecord
        && snapshot.canGenerate;

      if (shouldAutoGenerate) {
        console.info(
          `[worktree-context] no prior record for ${this.worktreePath}; requesting first-time generation`,
        );
        this.worktreeContextBusy.set(true);
        const generated = await firstValueFrom(
          this.worktreeContextService.generate(this.repoId, this.worktreePath),
        );
        this.worktreeContext.set(generated);
        console.info(
          `[worktree-context] first-time generation settled for ${this.worktreePath} (status=${generated.generationStatus})`,
        );
      } else if (triggerGenerate) {
        console.info(
          `[worktree-context] skipping auto-generate for ${this.worktreePath} (hasRecord=${snapshot.hasRecord}, canGenerate=${snapshot.canGenerate}, status=${snapshot.generationStatus})`,
        );
      }
    } catch (error) {
      toast.error(this.getHttpErrorMessage(error, 'Could not load worktree context.'));
    } finally {
      this.worktreeContextLoading.set(false);
      this.worktreeContextBusy.set(false);
    }
  }

  private async refreshAutocomplete(version: number = this.bootstrapVersion): Promise<void> {
    const autocompleteItems = await firstValueFrom(
      this.api.getAutocompleteItems(this.sessionId),
    );
    if (version !== this.bootstrapVersion) return;
    this.autocompleteItems.set(autocompleteItems);
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
        this.pendingPrompts.set(event.payload.pendingPrompts ?? []);
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
      case 'message_start':
      case 'thinking_start':
      case 'tool_use':
      case 'tool_result':
        this.liveItems.update((items) => [...items, event.payload.item]);
        return;
      case 'message_delta':
      case 'thinking_delta':
        this.enqueueDelta(event.payload.itemId, event.payload.delta);
        return;
      case 'permission_request': {
        const req = event.payload.request;
        if (this.planBypassActive()) {
          const toolName = (req.toolName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (toolName === 'exitplanmode') {
            this.pendingPermissionRequest.set(req);
          } else {
            this.autoApprovePermission(req.requestId);
          }
          return;
        }
        this.pendingPermissionRequest.set(req);
        return;
      }
      case 'permission_resolved':
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
        this.pendingPermissionRequest.set(null);
        this.pendingUserInputRequest.set(null);
        this.submitting.set(false);
        if (this.mcpDrawerOpen()) {
          void this.loadMcpSnapshot(true);
        }
        void this.syncHistoryAfterCompletion();
        return;
      default:
        return;
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
    for (const item of history) {
      const colonIdx = item.id.indexOf(':');
      if (colonIdx >= 0) {
        historyKindKeys.add(`${item.id.slice(0, colonIdx)}:${item.kind}`);
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
    this.pendingPermissionRequest.set(state.pendingPermissionRequest);
    this.pendingUserInputRequest.set(state.pendingUserInputRequest);
    this.pendingPrompts.set(state.pendingPrompts ?? []);
    this.lastError.set(state.lastError);
    this.tasks.set(state.tasks);
    this.sessionMetadata.set(state.sessionMetadata);
    this.subagents.set(state.subagents);
    this.recentHookEvents.set(state.recentHookEvents);
  }

  private reset(): void {
    this.bootstrapVersion += 1;
    if (this.flushRafId !== null) {
      cancelAnimationFrame(this.flushRafId);
      this.flushRafId = null;
      this.flushScheduled = false;
      this.pendingDeltas.length = 0;
    }
    this.ws.disconnect(this.sessionId);
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
    this.autocompleteItems.set([]);
    this.tasks.set([]);
    this.tasksDrawerOpen.set(false);
    this.mcpDrawerOpen.set(false);
    this.mcpLoading.set(false);
    this.mcpSnapshot.set(null);
    this.mcpBusyServerName.set(null);
    this.sessionMetadata.set(null);
    this.subagents.set([]);
    this.recentHookEvents.set([]);
    this.expandedTurns.set({});
    this.armedEditMessageId.set(null);
    this.rewindingMessageId.set(null);
    this.closeAgentInspector();
    this.agentHistoryById.set({});
  }

  private scrollToBottom(): void {
    const el = this.transcriptContainer?.nativeElement;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  private enqueueDelta(itemId: string, delta: string): void {
    this.pendingDeltas.push({ itemId, delta });
    this.scheduleFlush();
  }

  private async prepareRuntimePrompt(prompt: string): Promise<string> {
    if (this.hasInjectedContext() || prompt.trimStart().startsWith('/')) {
      return prompt;
    }

    try {
      const consume = await firstValueFrom(
        this.worktreeContextService
          .consume(this.sessionId, this.firstPromptContextEnabled())
          .pipe(timeout({ first: WORKTREE_CONTEXT_SEND_BUDGET_MS })),
      );
      if (consume.shouldInject && consume.contextSentence) {
        this.hasInjectedContext.set(true);
        this.worktreeContext.update(snapshot =>
          snapshot ? { ...snapshot, lastUsedAt: new Date().toISOString() } : snapshot,
        );
        return buildWorktreeContextPrompt(consume.contextSentence, prompt);
      }
      return prompt;
    } catch (error) {
      if (error instanceof TimeoutError) {
        return prompt;
      }
      toast.error(this.getHttpErrorMessage(error, 'Could not prepare worktree context.'));
      return prompt;
    }
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
