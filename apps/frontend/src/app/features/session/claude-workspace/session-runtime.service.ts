import { AgentConversation } from '@/shared/agent-chat/agent-conversation';
import { transcriptToolState } from '@/shared/agent-chat/transcript/transcript-view-state';
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
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentRuntimeProviderService } from '@/shared/services/agent-runtime-provider.service';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { ClaudeRuntimeApiService } from '@/shared/services/claude-runtime-api.service';
import { ClaudeRuntimeWebsocketService } from '@/shared/services/claude-runtime-websocket.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { ClaudeTerminalTranscriptWebsocketService } from '@/shared/services/claude-terminal-transcript-websocket.service';
import { SessionsService } from '@/shared/services/sessions.service';
import {
  DestroyRef,
  Injectable,
  SimpleChanges,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { toast } from 'ngx-sonner';
import { Observable, Subject, Subscription, firstValueFrom } from 'rxjs';
import { SessionWorkspaceEvent, SessionWorkspaceInputs } from './session-workspace-inputs';
import { getHttpErrorMessage } from './workspace-error';

/**
 * Providers gated behind a card in the workspace: Codex and Pi collect their
 * credentials here, Claude only needs its CLI installed. Antigravity is absent:
 * its auth status can't be verified from the backend yet (see
 * docs/antigravity-provider-flow.md), so gating on `authenticated === true`
 * would lock every Antigravity session out permanently — a failed prompt
 * surfaces its own error instead.
 */
const LOGIN_CARD_PROVIDERS = new Set(['claude', 'codex', 'pi']);

@Injectable()
export class SessionRuntime {
  private inputs?: SessionWorkspaceInputs;
  private transcriptRevision = 0;
  private rewindingVersion: number | null = null;

  beginConversationRewind(): void {
    this.transcriptRevision += 1;
    this.rewindingVersion = this.bootstrapVersion;
    this.historyRefresh = null;
    this.cancelInitialHistoryLoad();
  }

  endConversationRewind(version: number): void {
    if (this.rewindingVersion === version) this.rewindingVersion = null;
  }

  private readonly lifecycle = new Subject<SessionWorkspaceEvent>();
  readonly events = this.lifecycle.asObservable();

  readonly openTerminalFallback = new Subject<void>();

  readonly activeAgentProviderChange = new Subject<AgentProviderId>();

  readonly agentRuntimeStarted = new Subject<void>();

  private readonly destroyRef = inject(DestroyRef);

  private readonly api = inject(ClaudeRuntimeApiService);

  private readonly agentApi = inject(AgentRuntimeApiService);

  private readonly ws = inject(ClaudeRuntimeWebsocketService);

  private readonly terminalTranscriptWs = inject(ClaudeTerminalTranscriptWebsocketService);

  private readonly providerSelection = inject(AgentRuntimeProviderService);

  private readonly sessionsService = inject(SessionsService);

  private readonly claudeStatusService = inject(ClaudeStatusService);

  readonly appSettings = inject(AppSettingsService);

  readonly conversation = new AgentConversation();

  private historyRefresh: { version: number; promise: Promise<void> } | null = null;

  readonly toolState = computed(() => transcriptToolState(this.conversation));
  readonly loading = signal(true);

  readonly applyingPresetId = signal<string | null>(null);

  readonly modelPresets = computed(() => this.appSettings.settings().agentModelPresets);

  readonly hydrated = signal(false);

  readonly submitting = signal(false);

  readonly runPhase = this.conversation.runPhase.asReadonly();

  readonly warmState = signal<ClaudeRuntimeWarmState>('cold');

  readonly sessionState = signal<ClaudeSessionExecutionState>('idle');

  readonly canInterrupt = this.conversation.canInterrupt.asReadonly();

  readonly lastError = this.conversation.lastError.asReadonly();

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

  readonly availableModels = signal<ClaudeModelOption[]>([]);

  readonly contextUsage = signal<ClaudeContextUsage | null>(null);

  readonly planUsage = signal<AgentPlanUsage | null>(null);

  readonly historyItems = this.conversation.history.asReadonly();

  readonly liveItems = this.conversation.live.asReadonly();

  readonly optimisticUserItems = this.conversation.optimistic.asReadonly();

  readonly pendingPermissionRequest = this.conversation.pendingPermissionRequest.asReadonly();

  readonly pendingUserInputRequest = this.conversation.pendingUserInputRequest.asReadonly();

  readonly pendingPrompts = this.conversation.pendingPrompts.asReadonly();

  readonly queuePaused = this.conversation.queuePaused.asReadonly();

  private readonly cancelledPendingPromptIds = new Set<string>();

  private readonly autoApprovedPermissionRequestIds = new Set<string>();

  private bootstrappedProvider: AgentProviderId | null = null;

  readonly autocompleteItems = signal<ClaudeAutocompleteItem[]>([]);

  readonly tasks = signal<ClaudeTaskState[]>([]);

  readonly toolProgressByToolUseId = this.conversation.toolProgressByToolUseId.asReadonly();

  readonly sessionMetadata = signal<ClaudeRuntimeSessionMetadata | null>(null);

  readonly subagents = this.conversation.subagents.asReadonly();

  // Work still executing in the background after the visible turn returned to
  // idle. Comes straight from the backend's swept registry rather than being
  // re-derived from the subagent ring buffer here: a missed stop hook used to
  // leave this stuck non-empty, which silently queued every later message.
  readonly backgroundWork = this.conversation.backgroundWork.asReadonly();

  // True while the current run was started by background work reporting back
  // rather than by a user prompt. The turn itself behaves identically; this is
  // only used to label it in the UI.
  readonly backgroundRunActive = signal(false);

  readonly recentHookEvents = this.conversation.recentHookEvents.asReadonly();

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

  readonly runtimeStarted = linkedSignal(() => this.hasStartedAgentRuntime);

  readonly statusPhase = computed<ClaudeStatusBarPhase>(() => {
    const phase = this.runPhase();
    if (phase !== 'idle') return phase;
    if (this.warmState() === 'prewarming') return 'initializing';
    return this.runtimeStarted() ? 'idle' : 'ready';
  });

  readonly wsConnected = signal(false);

  private wsAutoReconnecting = false;

  private wsStateSub: Subscription | null = null;
  private transcriptEventsSub: Subscription | null = null;
  private initialHistoryRequest: { subscription: Subscription | null } | null = null;

  readonly isTranscriptReadOnly = computed(() => this.archived || this.readOnlyTranscript);

  /** True when the current provider is unavailable or needs credentials. */
  readonly showProviderLogin = computed(() => {
    if (this.readOnlyTranscript) return false;
    if (this.archived) return false;
    if (!LOGIN_CARD_PROVIDERS.has(this.currentProvider())) return false;
    const status = this.providerAuthStatus();
    if (!status) return false;
    return status.authenticated !== true;
  });

  readonly permissionMode = computed<ClaudePermissionMode>(() => {
    return this._permissionMode() ?? 'auto';
  });

  readonly planMode = computed(() => this._planMode());

  readonly showLoading = computed(() => this.loading() || !this.hydrated());

  bootstrapVersion = 0;

  private readonly pendingDeltas: Array<{ itemId: string; delta: string }> = [];

  private flushScheduled = false;

  private flushRafId: number | null = null;

  readonly transcriptItems = this.conversation.items;

  readonly pairedTranscript = this.conversation.units;

  readonly renderItems = this.conversation.renderItems;

  /** Only the streaming item pulses; everything else renders settled. */
  readonly streamingMessageId = this.conversation.streamingMessageId;

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
  constructor() {
    void this.appSettings.load().catch(() => undefined);

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

      this.disconnectTranscriptSocket(this.sessionId);
      this.ws.clearProvider?.(this.sessionId);
      this.api.clearProvider?.(this.sessionId);
    });
  }
  bindInputs(inputs: SessionWorkspaceInputs): void {
    this.inputs = inputs;
  }
  notify(event: SessionWorkspaceEvent): void {
    this.lifecycle.next(event);
  }
  get sessionId(): number {
    return this.inputs!.sessionId();
  }
  get repoId(): number {
    return this.inputs!.repoId();
  }
  get worktreePath(): string {
    return this.inputs!.worktreePath();
  }
  get hasInjectedWorktreeContext(): boolean {
    return this.inputs!.hasInjectedWorktreeContext();
  }
  get activeAgentProvider(): AgentProviderId {
    return this.inputs!.activeAgentProvider();
  }
  get hasStartedAgentRuntime(): boolean {
    return this.inputs!.hasStartedAgentRuntime();
  }
  get isVisible(): boolean {
    return this.inputs!.isVisible();
  }
  get archived(): boolean {
    return this.inputs!.archived();
  }
  get readOnlyTranscript(): boolean {
    return this.inputs!.readOnlyTranscript();
  }
  get terminalTranscriptMirror(): boolean {
    return this.inputs!.terminalTranscriptMirror();
  }
  initialize(): void {
    this.currentProvider.set(this.activeAgentProvider);
    this.syncSessionProvider(this.activeAgentProvider);
    if (this.isVisible) {
      this.providerSelection.setProvider(this.activeAgentProvider);
    }
    // Every open tab is kept warm, including background tabs. Its websocket
    // continues applying runtime events while another tab is selected.
    void this.bootstrapForMode();
    this.notify({ type: 'restore-draft' });
  }
  onInputsChanged(changes: SimpleChanges): void {
    const changed = (name: string) => !!changes[name] && !changes[name].firstChange;
    const sessionChanged = changed('sessionId');
    const providerChanged = changed('activeAgentProvider');
    if (sessionChanged) {
      const previousSessionId = changes['sessionId'].previousValue as number;
      this.notify({ type: 'session-change', previousSessionId });
      this.disconnectTranscriptSocket(previousSessionId);
      this.ws.clearProvider?.(previousSessionId);
      this.api.clearProvider?.(previousSessionId);
    }
    if (sessionChanged || providerChanged) {
      this.currentProvider.set(this.activeAgentProvider);
      this.syncSessionProvider(this.activeAgentProvider);
    }
    const becameVisible = changed('isVisible') && this.isVisible;
    if (
      this.isVisible &&
      (sessionChanged || providerChanged || becameVisible || changed('archived'))
    ) {
      this.providerSelection.setProvider(this.currentProvider());
    }
    const needsBootstrap =
      sessionChanged ||
      changed('archived') ||
      changed('readOnlyTranscript') ||
      changed('terminalTranscriptMirror') ||
      (providerChanged && this.bootstrappedProvider !== this.currentProvider()) ||
      (becameVisible && (!this.hydrated() || this.bootstrappedProvider !== this.currentProvider()));
    if (needsBootstrap) {
      this.reset();
      void this.bootstrapForMode();
      this.notify({ type: 'restore-draft' });
    } else if (
      becameVisible &&
      !this.archived &&
      (!this.readOnlyTranscript || this.terminalTranscriptMirror)
    ) {
      this.notify({ type: 'load-context' });
    }
  }
  reset(): void {
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
    this.applyingPresetId.set(null);

    this.sessionState.set('idle');

    this.backgroundRunActive.set(false);

    this.claudeSessionId.set(null);

    this.selectedModel.set(null);

    this.reasoningEffort.set(null);

    this.fastMode.set(false);

    this.availableModels.set([]);

    this.contextUsage.set(null);

    this.planUsage.set(null);

    this._permissionMode.set(null);

    this._planMode.set(false);

    this.cancelledPendingPromptIds.clear();

    this.autocompleteItems.set([]);

    this.tasks.set([]);

    this.sessionMetadata.set(null);

    this.authStatusByProvider.set({});

    this.bootstrappedProvider = null;

    this.runtimeStarted.set(this.hasStartedAgentRuntime);
    this.notify({ type: 'reset' });
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
      this.conversation.optimistic.update((items) => [
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
    this.conversation.pendingPrompts.set(next);
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

  acceptPrompt(content: string): boolean {
    const startsImmediately =
      this.runPhase() === 'idle' &&
      !this.backgroundWork().length &&
      !this.pendingPrompts().length &&
      !this.queuePaused();
    if (startsImmediately && this.submitting()) return false;
    if (startsImmediately) {
      this.submitting.set(true);
      this.conversation.addOptimisticPrompt(content);
    }
    this.notify({ type: 'prompt-submitted' });
    return true;
  }

  restoreRewoundConversation(history: ClaudeTranscriptItem[], state: ClaudeRuntimeState): void {
    this.conversation.history.set(
      [...history].sort((l, r) => l.timestamp.localeCompare(r.timestamp)),
    );
    this.applyRuntimeState(state);
    this.conversation.optimistic.set([]);
    this.conversation.live.set([]);
    this.conversation.pendingPermissionRequest.set(null);
    this.conversation.pendingUserInputRequest.set(null);
  }

  async onModelChange(model: string): Promise<void> {
    return this.updateRuntimeSetting(() =>
      this.api.setSelectedModel(this.sessionId, model || null),
    );
  }

  async applyModelPreset(preset: AgentModelPreset): Promise<void> {
    if (this.isTranscriptReadOnly() || this.runtimeStarted() || this.applyingPresetId()) return;
    let version = this.bootstrapVersion;
    const sessionId = this.sessionId;
    this.applyingPresetId.set(preset.id);
    try {
      if (preset.provider !== this.currentProvider()) {
        await firstValueFrom(
          this.sessionsService.updateActiveAgentProvider(sessionId, preset.provider),
        );
        if (!this.isCurrentConversation(version) || this.sessionId !== sessionId) return;
        this.disconnectTranscriptSocket(sessionId);
        this.providerSelection.setProvider(preset.provider);

        this.currentProvider.set(preset.provider);
        this.syncSessionProvider(preset.provider);
        this.activeAgentProviderChange.next(preset.provider);
        this.reset();
        const bootstrap = this.bootstrap();
        version = this.bootstrapVersion;
        this.applyingPresetId.set(preset.id);
        await bootstrap;
        if (!this.isCurrentConversation(version) || this.sessionId !== sessionId) return;
        this.notify({ type: 'restore-draft' });
      }

      const modelState = await firstValueFrom(
        this.agentApi.setSelectedModel(sessionId, preset.model, preset.provider),
      );
      if (!this.isCurrentConversation(version) || this.sessionId !== sessionId) return;
      this.applyRuntimeState(modelState);
      const effortState = await firstValueFrom(
        this.agentApi.setReasoningEffort(sessionId, preset.reasoningEffort, preset.provider),
      );
      if (!this.isCurrentConversation(version) || this.sessionId !== sessionId) return;
      this.applyRuntimeState(effortState);
      const fastMode =
        preset.fastMode === true &&
        this.availableModels().some(
          (model) => model.id === this.selectedModel() && model.supportsFastMode === true,
        );
      if (fastMode !== this.fastMode()) {
        const fastState = await firstValueFrom(
          this.agentApi.setFastMode(sessionId, fastMode, preset.provider),
        );
        if (!this.isCurrentConversation(version) || this.sessionId !== sessionId) return;
        this.applyRuntimeState(fastState);
      }
      queueMicrotask(() => this.notify({ type: 'focus-composer' }));
    } catch {
      if (this.isCurrentConversation(version) && this.sessionId === sessionId)
        toast.error(`Could not apply “${preset.name}”.`);
    } finally {
      if (this.isCurrentConversation(version) && this.sessionId === sessionId)
        this.applyingPresetId.set(null);
    }
  }

  isModelPresetSelected(preset: AgentModelPreset): boolean {
    return (
      preset.provider === this.currentProvider() &&
      preset.model === this.selectedModel() &&
      preset.reasoningEffort === this.reasoningEffort() &&
      (preset.fastMode ?? false) === this.fastMode()
    );
  }

  modelPresetIcon(provider: string): string {
    return AGENT_PROVIDER_ICONS[provider] || 'lucideSparkles';
  }

  modelPresetSummary(preset: AgentModelPreset): string {
    const provider = AGENT_PROVIDER_PRESENTATIONS.find((item) => item.id === preset.provider);
    const parts = [provider?.label ?? preset.provider, preset.model ?? 'Agent default'];
    if (preset.reasoningEffort) parts.push(this.reasoningEffortLabel(preset.reasoningEffort));
    if (preset.fastMode) parts.push('Fast mode');
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
    if (this.isTranscriptReadOnly()) return;
    const version = this.bootstrapVersion;
    try {
      const state = await firstValueFrom(request());
      if (this.isCurrentConversation(version)) this.applyRuntimeState(state);
    } catch (error) {
      if (this.isCurrentConversation(version)) {
        toast.error(getHttpErrorMessage(error, 'Could not update agent settings.'));
      }
    }
  }

  isCurrentConversation(version: number): boolean {
    return version === this.bootstrapVersion && !this.destroyRef.destroyed;
  }

  openTerminal(): void {
    if (this.isTranscriptReadOnly()) return;
    if (this.currentProvider() !== 'claude') {
      toast.message('Raw terminal fallback is only available for Claude Code.');
      return;
    }
    void firstValueFrom(this.api.openTerminalFallback(this.sessionId)).finally(() =>
      this.openTerminalFallback.next(),
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

    this.currentProvider.set(provider);
    this.syncSessionProvider(provider);
    this.activeAgentProviderChange.next(provider);
    void firstValueFrom(
      this.sessionsService.updateActiveAgentProvider(this.sessionId, provider),
    ).catch(() => undefined);
    this.reset();
    void this.bootstrap().then(() => this.notify({ type: 'restore-draft' }));
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
    const version = this.bootstrapVersion;
    return firstValueFrom(this.agentApi.getAuthStatus(provider))
      .then((status) => {
        if (this.isCurrentConversation(version)) this.setAuthStatus(provider, status);
      })
      .catch(() => undefined);
  }

  isStreamingMessage(itemId: string): boolean {
    return this.runPhase() === 'running' && this.lastLiveMessageId() === itemId;
  }

  private activeTranscriptSocket():
    | ClaudeRuntimeWebsocketService
    | ClaudeTerminalTranscriptWebsocketService {
    return this.terminalTranscriptMirror ? this.terminalTranscriptWs : this.ws;
  }

  private disconnectTranscriptSocket(sessionId: number): void {
    this.cancelInitialHistoryLoad();
    this.transcriptEventsSub?.unsubscribe();
    this.transcriptEventsSub = null;
    this.wsStateSub?.unsubscribe();
    this.wsStateSub = null;
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
    this.transcriptEventsSub = this.activeTranscriptSocket()
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (version === this.bootstrapVersion && !this.destroyRef.destroyed)
          this.handleRuntimeEvent(event);
      });
    this.subscribeConnectionState();
    this.activeTranscriptSocket().send(this.sessionId, { type: 'hydrate' });
  }

  sendRuntimeAction(message: AgentRuntimeCommand): void {
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

    this.transcriptEventsSub = this.activeTranscriptSocket()
      .connect(this.sessionId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (this.isCurrentConversation(version)) this.handleRuntimeEvent(event);
      });

    this.subscribeConnectionState();

    this.activeTranscriptSocket().send(this.sessionId, {
      type: 'hydrate',
      ...(!this.readOnlyTranscript ? { includeHistory: false } : {}),
    });

    // Persisted messages do not need a live runtime or a WebSocket handshake.
    // Start this before optional context, provider and autocomplete requests.
    if (!this.readOnlyTranscript) {
      this.loadInitialHistory(version);
      this.notify({ type: 'load-context' });
      void this.loadProviders();
    } else if (this.terminalTranscriptMirror) {
      this.notify({ type: 'load-context' });
    }

    if (!this.readOnlyTranscript) {
      void this.refreshAutocomplete(version).catch(() => undefined);
      this.notify({ type: 'load-actions' });
    }
    if (version === this.bootstrapVersion) this.loading.set(false);
  }

  private loadInitialHistory(version: number): void {
    this.cancelInitialHistoryLoad();
    const revision = this.transcriptRevision;
    const request = { subscription: null as Subscription | null };
    this.initialHistoryRequest = request;
    request.subscription = this.agentApi.getHistory(this.sessionId, this.currentProvider())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (history) => {
          if (this.initialHistoryRequest !== request || !this.isCurrentConversation(version) ||
            revision !== this.transcriptRevision) return;
          this.flushDeltas();
          this.handleRuntimeEvent({
            type: 'history_snapshot', payload: { sessionId: this.sessionId, history },
          });
        },
        error: () => {
          if (this.initialHistoryRequest !== request || !this.isCurrentConversation(version)) return;
          this.cancelInitialHistoryLoad();
          // Keep the socket hydration path as a fallback if HTTP fails.
          this.activeTranscriptSocket().send(this.sessionId, { type: 'hydrate' });
        },
      });
  }

  private cancelInitialHistoryLoad(): void {
    const request = this.initialHistoryRequest;
    this.initialHistoryRequest = null;
    request?.subscription?.unsubscribe();
  }

  private async bootstrapArchived(): Promise<void> {
    const version = ++this.bootstrapVersion;
    this.bootstrappedProvider = this.currentProvider();
    this.loading.set(true);
    this.hydrated.set(false);
    void this.loadProviders();

    try {
      const history = (await firstValueFrom(
        this.agentApi.getHistory(this.sessionId, this.currentProvider()),
      )) as ClaudeTranscriptItem[];
      if (version !== this.bootstrapVersion) return;
      this.conversation.history.set(history);
      this.notify({ type: 'load-actions' });
      this.conversation.live.set([]);
      this.conversation.optimistic.set([]);
      this.conversation.runPhase.set('idle');
      this.sessionState.set('idle');
      this.conversation.canInterrupt.set(false);
      this.conversation.pendingPermissionRequest.set(null);
      this.conversation.pendingUserInputRequest.set(null);
      this.conversation.pendingPrompts.set([]);
      this.conversation.queuePaused.set(false);
      this.conversation.lastError.set(null);
      this.hydrated.set(true);
    } catch (error) {
      if (version !== this.bootstrapVersion) return;
      this.conversation.lastError.set(
        getHttpErrorMessage(error, 'Could not load archived transcript.'),
      );
      this.hydrated.set(true);
    } finally {
      if (version === this.bootstrapVersion) this.loading.set(false);
    }
  }

  private bootstrapForMode(): Promise<void> {
    return this.archived ? this.bootstrapArchived() : this.bootstrap();
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
        this.cancelInitialHistoryLoad();
        this.conversation.applyHistoryRefresh(event.payload.history);
        this.applyRuntimeState(event.payload);
        this.hydrated.set(true);
        this.loading.set(false);
        return;
      case 'runtime_snapshot':
        this.applyRuntimeState(event.payload);
        return;
      case 'history_snapshot':
        this.cancelInitialHistoryLoad();
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
        this.agentRuntimeStarted.next();
        this.notify({ type: 'context-generation' });
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
        this.notify({ type: 'runtime-error' });
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
        this.notify({ type: 'complete' });
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
    // The rewind response owns the replacement transcript. Completion refreshes
    // from the old conversation must not restore messages removed by the edit.
    if (this.rewindingVersion === version) return;
    await this.syncHistoryAfterCompletion();
    if (version !== this.bootstrapVersion) return;

    this.notify({ type: 'context-generation' });
  }

  private async syncHistoryAfterCompletion(): Promise<void> {
    const version = this.bootstrapVersion;
    const revision = this.transcriptRevision;
    if (this.rewindingVersion === version) return;
    if (this.historyRefresh?.version === version) return this.historyRefresh.promise;
    this.flushDeltas();
    const promise = (async () => {
      try {
        const history = await firstValueFrom(this.api.getHistory(this.sessionId));
        if (version !== this.bootstrapVersion || revision !== this.transcriptRevision ||
          this.rewindingVersion === version || this.destroyRef.destroyed) return;
        this.flushDeltas();
        this.conversation.applyHistoryRefresh(history);
      } catch (error) {
        if (version === this.bootstrapVersion && revision === this.transcriptRevision &&
          this.rewindingVersion !== version && !this.destroyRef.destroyed) {
          this.conversation.lastError.set(
            getHttpErrorMessage(error, 'Could not refresh conversation history.'),
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

  applyRuntimeState(state: ClaudeRuntimeState): void {
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
      this.conversation.pendingPermissionRequest.set(null);
      return;
    }

    if (this.shouldAutoApprovePermission(req)) {
      this.conversation.pendingPermissionRequest.set(null);
      this.autoApprovePermission(req.requestId);
      return;
    }

    this.conversation.pendingPermissionRequest.set(req);
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

  private enqueueDelta(itemId: string, delta: string): void {
    this.pendingDeltas.push({ itemId, delta });
    this.scheduleFlush();
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
}
