import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, extname, join } from 'path';
import { SessionsService } from '../sessions/sessions.service.js';
import type {
  AgentForkConversationRequest,
  AgentForkConversationResult,
  AgentImageInput,
} from '../agent-runtime/agent-runtime.types.js';
import { AGENT_REASONING_EFFORTS } from '../agent-runtime/agent-runtime.types.js';
import type { AgentProviderModelCatalogPayload } from '../agent-runtime/agent-runtime.types.js';
import { resolveAgentStartupSelection } from '../agent-runtime/agent-model-defaults.js';
import { canonicalizeAgentTool } from '../agent-runtime/agent-tool-normalization.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ClaudeHooksService,
  type ClaudeSessionActivity,
} from '../claude-hooks/claude-hooks.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import type {
  ClaudeAutocompleteItem,
  ClaudeModelOption,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
} from '../claude-runtime/claude-runtime.types.js';
import { PiAuthService } from './pi-auth.service.js';
import { PiSessionRuntime } from './pi-session-runtime.js';
import type {
  PiAuthStatus,
  PiRpcExtensionUiRequest,
  PiRuntimeSessionMetadata,
  PiRuntimeState,
  PiRuntimeStatePayload,
  PiSessionRuntimeEvent,
  PiSessionSnapshotPayload,
} from './pi-runtime.types.js';

const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_RUNTIME_CAP = 20;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_BACKGROUND_REFRESH_MS = 10 * 60 * 1000;

interface PiActiveRun {
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  interruptRequested: boolean;
  userInputRequests: Map<
    string,
    {
      request: ClaudeUserInputRequest;
      rpcRequestId: string;
      method: string;
    }
  >;
}

interface PiRuntimeEntry {
  runtime: PiSessionRuntime;
  sessionId: number;
  worktreePath: string;
  attachedClients: number;
  idleTimer: NodeJS.Timeout | null;
  lastIdleAt: number;
}

@Injectable()
export class PiRuntimeService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PiRuntimeService.name);
  private readonly activeRuns = new Map<number, PiActiveRun>();
  private readonly initializingRuns = new Set<number>();
  private readonly runtimeStates = new Map<number, PiRuntimeState>();
  private readonly runtimes = new Map<number, PiRuntimeEntry>();
  private readonly clientCounts = new Map<number, number>();
  private readonly idleShutdownMs =
    Number(process.env.PI_RUNTIME_IDLE_MS) || DEFAULT_IDLE_SHUTDOWN_MS;
  private readonly idleRuntimeCap =
    Number(process.env.PI_RUNTIME_IDLE_CAP) || DEFAULT_IDLE_RUNTIME_CAP;

  // Global, cross-session cache of the models Pi currently reports as
  // available for the authenticated account(s). This lets the UI show the
  // real model list immediately (e.g. in the model picker) without waiting
  // for a per-session Pi RPC process to spawn on first prompt. The cache is
  // warmed at startup, refreshed periodically in the background, and
  // refreshed whenever auth credentials change.
  private modelsCache: ClaudeModelOption[] | null = null;
  private modelsCacheAt = 0;
  private modelsRefreshPromise: Promise<ClaudeModelOption[]> | null = null;
  private modelsRefreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: PiAuthService,
    private readonly hooksService: ClaudeHooksService,
    private readonly titleService: SessionTitleService,
    private readonly settingsService: SettingsService,
  ) {
    super();
    this.authService.on('status', (status: PiAuthStatus) => {
      void this.handleAuthStatusChange(status);
    });
  }

  /**
   * Session-independent model catalog for the settings pickers. Pi only knows
   * its models once a signed-in CLI has reported them, so an empty list is a
   * normal state that the UI explains rather than an error.
   */
  getModelCatalog(): AgentProviderModelCatalogPayload {
    this.refreshGlobalModelsIfStale();
    const models = this.modelsCache ? [...this.modelsCache] : [];
    return {
      models,
      reasoningEfforts: [...AGENT_REASONING_EFFORTS],
      providerDefaultModelId: null,
      supportsModelSelection: true,
      unavailableReason: models.length
        ? null
        : 'Pi has not reported any models yet — check that its CLI is installed and signed in.',
    };
  }

  onModuleInit(): void {
    // Warm the model list cache in the background so it is ready before any
    // session runtime needs it, and keep it fresh without any user action.
    this.refreshGlobalModels('startup').catch(() => undefined);
    this.modelsRefreshTimer = setInterval(() => {
      this.refreshGlobalModels('interval').catch(() => undefined);
    }, MODELS_BACKGROUND_REFRESH_MS);
    this.modelsRefreshTimer.unref?.();
  }

  private async handleAuthStatusChange(status: PiAuthStatus): Promise<void> {
    if (status.isAuthenticating) return;
    // Credentials changed: the model list may have changed too (new provider,
    // different account, etc.), so force a background refresh of the global
    // cache regardless of whether any session runtime is currently active.
    this.refreshGlobalModels('auth_status_change', true).catch(() => undefined);
    const sessionIds = Array.from(this.runtimes.keys());
    if (sessionIds.length === 0) return;
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        const state = this.ensureRuntimeState(sessionId);
        const previous = state.authStatus;
        const credentialsChanged =
          (status.authenticated && !previous?.authenticated) ||
          (status.authenticated &&
            previous?.authenticated &&
            previous.authMethod !== status.authMethod);
        state.authStatus = status;

        // The Pi child process reads ~/.pi/agent/auth.json at startup, so an
        // already-running runtime keeps reporting "not logged in" even after
        // the user authenticates via the UI. Stop the runtime so the next
        // prompt respawns it with the fresh credentials.
        if (credentialsChanged && this.runtimes.has(sessionId)) {
          if (this.activeRuns.has(sessionId)) {
            this.logger.log(
              `Skipping Pi runtime restart after auth change because a run is active session=${sessionId}`,
            );
          } else {
            try {
              await this.stopRuntime(sessionId);
            } catch (error) {
              this.logger.warn(
                `Failed to stop Pi runtime after auth change session=${sessionId}: ${String(error)}`,
              );
            }
            this.emitRunState(sessionId);
            return;
          }
        }

        try {
          await this.refreshModels(sessionId);
          this.emitRunState(sessionId);
        } catch (error) {
          this.logger.warn(
            `Failed to refresh models after auth change session=${sessionId}: ${String(error)}`,
          );
        }
      }),
    );
  }

  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);

    if (state.piSessionPath) {
      try {
        const persisted = await this.readHistoryFromSessionFile(
          state.piSessionPath,
        );
        return this.overlayLiveItems(state, persisted);
      } catch (error) {
        // Pi only writes its session file once the first assistant message of
        // the session completes, so during the first turn the recorded path
        // legitimately does not exist on disk yet. Fall back to the live RPC
        // process instead of reporting an empty transcript while the run is
        // still streaming.
        this.logger.warn(
          `Pi session file not readable session=${sessionId} path=${JSON.stringify(state.piSessionPath)}: ${String(error)}`,
        );
      }
    }

    return this.readLiveHistory(sessionId, state);
  }

  async getRuntimeState(sessionId: number): Promise<PiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.cachedWorktreePath = session.worktreePath;
    state.authStatus = await this.authService.getStatus();

    // No live Pi RPC process for this session yet (e.g. before the first
    // prompt is sent): fall back to the globally cached model list instead
    // of showing an empty picker until a runtime spawns.
    if (!state.availableModels.length && this.modelsCache?.length) {
      state.availableModels = this.modelsCache;
    }
    if (!this.runtimes.has(sessionId)) {
      this.refreshGlobalModelsIfStale();
    }

    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSnapshot(sessionId: number): Promise<PiSessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);
    return { ...runtimeState, history };
  }

  async getAutocompleteItems(
    sessionId: number,
  ): Promise<ClaudeAutocompleteItem[]> {
    // Only query a runtime that is already running. Spawning one here via
    // ensureRuntime() would persist a real piSessionPath before the user
    // ever sends a prompt (the composer calls this on every session open),
    // which makes submitPrompt() think the session already has history and
    // permanently skips auto-generating its title.
    const entry = this.runtimes.get(sessionId);
    if (!entry) return [];
    try {
      const response = await entry.runtime.send<{ commands?: unknown[] }>({
        type: 'get_commands',
      });
      return (Array.isArray(response?.commands) ? response.commands : [])
        .map((command) => this.toAutocompleteItem(command))
        .filter((item): item is ClaudeAutocompleteItem => Boolean(item));
    } catch (error) {
      this.logger.warn(
        `Failed to load Pi autocomplete session=${sessionId}: ${String(error)}`,
      );
      return [];
    }
  }

  async forkConversation(
    request: AgentForkConversationRequest,
  ): Promise<AgentForkConversationResult> {
    if (!request.anchorMessageId || !request.anchorMessageKind) {
      throw new BadRequestException('A Pi fork anchor message is required.');
    }
    const anchorMessageId = request.anchorMessageId;
    const anchorMessageKind = request.anchorMessageKind;
    const session = await this.sessionsService.findOne(request.parentSessionId);
    const sessionPath = session.piSessionPath;
    if (!sessionPath || sessionPath === '-1') {
      throw new NotFoundException('Pi session file not found.');
    }

    const records = await this.readPiSessionRecords(sessionPath);
    const targetIndex = records.findIndex((entry, index) =>
      this.isForkAnchorEntry(entry, index, anchorMessageId, anchorMessageKind),
    );
    if (targetIndex === -1) {
      throw new NotFoundException('Message not found in Pi session.');
    }

    const target = records[targetIndex];
    const draft =
      anchorMessageKind === 'user'
        ? this.stripInjectedWorktreeContext(
            this.contentToText(asRecord(target.message)?.content),
          )
        : null;
    const anchorExcerpt =
      anchorMessageKind === 'user'
        ? draft
        : this.contentToText(asRecord(target.message)?.content);
    const retainedRecords = records.slice(
      0,
      anchorMessageKind === 'user' ? targetIndex : targetIndex + 1,
    );

    if (retainedRecords.length === 0) {
      return {
        providerSessionId: null,
        draft,
        anchorExcerpt,
      };
    }

    const forkPath = this.buildForkSessionPath(sessionPath);
    await this.writePiSessionRecords(forkPath, retainedRecords);

    return {
      providerSessionId: forkPath,
      draft,
      anchorExcerpt,
    };
  }

  async setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<PiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.selectedModel = model;
    const parsed = this.parseModelRef(model);
    if (parsed) {
      const runtime = await this.ensureRuntime(sessionId);
      await runtime.send({
        type: 'set_model',
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      await this.refreshStateFromRpc(sessionId);
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setReasoningEffort(
    sessionId: number,
    effort: string | null,
  ): Promise<PiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.reasoningEffort = effort;
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setFastMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<PiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.fastMode = enabled;
    if (state.sessionMetadata) {
      state.sessionMetadata = {
        ...state.sessionMetadata,
        fastModeState: enabled ? 'on' : 'off',
      };
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ): Promise<void> {
    const trimmedPrompt = prompt.trim();
    const normalizedImages = this.normalizeImages(images);
    if (!trimmedPrompt && normalizedImages.length === 0) return;

    if (
      this.activeRuns.has(sessionId) ||
      this.initializingRuns.has(sessionId)
    ) {
      this.queuePendingPrompt(sessionId, trimmedPrompt, images);
      return;
    }

    this.initializingRuns.add(sessionId);
    let state: PiRuntimeState | null = null;
    let runRegistered = false;
    try {
      const session = await this.sessionsService.findOne(sessionId);
      const isNewSession =
        (!session.piSessionPath || session.piSessionPath === '-1') &&
        this.titleService.isAutoGeneratedName(session.name);
      this.logger.log(
        `Pi session title eligibility checked session=${sessionId} hasPiSessionPath=${Boolean(session.piSessionPath && session.piSessionPath !== '-1')} currentName=${JSON.stringify(session.name)} shouldGenerate=${isNewSession}`,
      );

      state = this.ensureRuntimeState(sessionId, session.piSessionPath);
      state.cachedWorktreePath = session.worktreePath;
      state.runPhase = 'running';
      state.sessionState = 'running';
      state.canInterrupt = true;
      state.lastError = null;
      state.liveItems = [];
      state.streamingAssistantMessageId = null;
      this.emitRunState(sessionId);

      const runtime = await this.ensureRuntime(sessionId);

      if (isNewSession) {
        const effectiveTitlePrompt = (titlePrompt ?? trimmedPrompt).trim();
        if (effectiveTitlePrompt) {
          this.logger.log(
            `Pi session title generation scheduled session=${sessionId} worktreePath=${JSON.stringify(session.worktreePath)} promptLength=${effectiveTitlePrompt.length}`,
          );
          setImmediate(() => {
            void this.generateAndSaveSessionTitle(
              sessionId,
              session.worktreePath,
              effectiveTitlePrompt,
            );
          });
        } else {
          this.logger.warn(
            `Pi session title generation skipped session=${sessionId} reason=empty_prompt`,
          );
        }
      }

      let resolveCompletion = () => {};
      const completionPromise = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      this.activeRuns.set(sessionId, {
        completionPromise,
        resolveCompletion,
        interruptRequested: false,
        userInputRequests: new Map(),
      });
      runRegistered = true;
      this.initializingRuns.delete(sessionId);

      try {
        await this.sessionsService.updateStatus(sessionId, 'active');
        await runtime.send({
          type: 'prompt',
          message: trimmedPrompt,
          ...(state.reasoningEffort
            ? { reasoningEffort: state.reasoningEffort }
            : {}),
          ...(state.fastMode ? { fastMode: true } : {}),
          ...(normalizedImages.length ? { images: normalizedImages } : {}),
        });
        await completionPromise;
        this.finishRun(sessionId);
      } catch (error) {
        const run = this.activeRuns.get(sessionId);
        if (run?.interruptRequested) {
          this.finalizeInterruptedRun(sessionId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = message;
        state.runPhase = 'error';
        state.sessionState = 'idle';
        state.canInterrupt = false;
        this.emitEvent({ type: 'error', payload: { sessionId, message } });
        this.emitRunState(sessionId);
      } finally {
        this.activeRuns.delete(sessionId);
        this.scheduleIdleShutdown(sessionId);
        if (!state.lastError && state.pendingPrompts.length > 0) {
          const [next, ...rest] = state.pendingPrompts;
          state.pendingPrompts = rest;
          this.emitRunState(sessionId);
          setImmediate(() => {
            this.submitPrompt(
              sessionId,
              next.prompt,
              undefined,
              next.images,
            ).catch((error) => {
              this.logger.error(
                `Pending Pi prompt failed session=${sessionId}: ${String(error)}`,
              );
            });
          });
        }
      }
    } catch (error) {
      this.initializingRuns.delete(sessionId);
      if (!runRegistered && state) {
        const message = error instanceof Error ? error.message : String(error);
        state.lastError = message;
        state.runPhase = 'error';
        state.sessionState = 'idle';
        state.canInterrupt = false;
        this.emitEvent({ type: 'error', payload: { sessionId, message } });
        this.emitRunState(sessionId);
      }
      throw error;
    }
  }

  private queuePendingPrompt(
    sessionId: number,
    prompt: string,
    images?: AgentImageInput[],
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.pendingPrompts = [
      ...state.pendingPrompts,
      {
        id: randomUUID(),
        prompt,
        queuedAt: new Date().toISOString(),
        ...(images?.length ? { images } : {}),
      },
    ];
    this.emitRunState(sessionId);
  }

  async interrupt(sessionId: number): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    run.interruptRequested = true;
    const runtime = this.runtimes.get(sessionId)?.runtime;
    for (const request of run.userInputRequests.values()) {
      runtime?.respondToExtensionUi({
        type: 'extension_ui_response',
        id: request.rpcRequestId,
        cancelled: true,
      });
    }
    run.userInputRequests.clear();
    await runtime?.send({ type: 'abort' }).catch(() => undefined);
  }

  async cancelPendingPrompt(sessionId: number, id: string): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    state.pendingPrompts = state.pendingPrompts.filter(
      (prompt) => prompt.id !== id,
    );
    this.emitRunState(sessionId);
  }

  async answerUserInput(
    sessionId: number,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel' = 'accept',
    content?: Record<string, string | number | boolean | string[]>,
  ): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    const pending = run?.userInputRequests.get(requestId);
    if (!pending) return;
    if (!run) return;
    run.userInputRequests.delete(requestId);
    const state = this.ensureRuntimeState(sessionId);
    state.pendingUserInputRequest = null;
    this.emitRunState(sessionId);

    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return;
    runtime.respondToExtensionUi(
      this.toExtensionUiResponse(
        pending.rpcRequestId,
        pending.method,
        action,
        content,
      ),
    );
  }

  async cleanupSession(sessionId: number): Promise<void> {
    await this.stopRuntime(sessionId);
    this.runtimeStates.delete(sessionId);
    this.clientCounts.delete(sessionId);
  }

  onClientAttached(sessionId: number): void {
    this.clientCounts.set(
      sessionId,
      (this.clientCounts.get(sessionId) ?? 0) + 1,
    );
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    entry.attachedClients = this.clientCounts.get(sessionId) ?? 0;
    this.clearIdleTimer(entry);
  }

  onClientDetached(sessionId: number): void {
    this.clientCounts.set(
      sessionId,
      Math.max(0, (this.clientCounts.get(sessionId) ?? 0) - 1),
    );
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    entry.attachedClients = this.clientCounts.get(sessionId) ?? 0;
    this.scheduleIdleShutdown(sessionId);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.modelsRefreshTimer) {
      clearInterval(this.modelsRefreshTimer);
      this.modelsRefreshTimer = null;
    }
    await Promise.all(
      [...this.runtimes.keys()].map((id) => this.stopRuntime(id)),
    );
  }

  private async ensureRuntime(sessionId: number): Promise<PiSessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      this.clearIdleTimer(existing);
      return existing.runtime;
    }

    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.cachedWorktreePath = session.worktreePath;
    const runtime = new PiSessionRuntime({
      cwd: session.worktreePath,
      sessionPath: state.piSessionPath,
    });
    const entry: PiRuntimeEntry = {
      runtime,
      sessionId,
      worktreePath: session.worktreePath,
      attachedClients: this.clientCounts.get(sessionId) ?? 0,
      idleTimer: null,
      lastIdleAt: Date.now(),
    };
    this.runtimes.set(sessionId, entry);

    runtime.on('event', (event: PiSessionRuntimeEvent) => {
      this.handlePiEvent(sessionId, event);
    });
    runtime.on('extension_ui_request', (request: PiRpcExtensionUiRequest) => {
      this.handleExtensionUiRequest(sessionId, request);
    });
    runtime.on('exit', (details: { message?: string; stderr?: string }) => {
      this.handleRuntimeExit(sessionId, details);
    });

    await runtime.start();
    await this.applyConfiguredDefaultModel(sessionId, runtime);
    await this.refreshStateFromRpc(sessionId);
    this.enforceIdleRuntimeCap();
    return runtime;
  }

  /**
   * Pi only changes model on an explicit `set_model` RPC, so the configured
   * default has to be pushed to a freshly started process — seeding runtime
   * state alone would display a model the process isn't actually using.
   * Resuming an existing Pi session keeps whatever model it was left on.
   */
  private async applyConfiguredDefaultModel(
    sessionId: number,
    runtime: PiSessionRuntime,
  ): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    if (state.piSessionPath) {
      return;
    }

    const configured =
      this.settingsService.getAgentProviderDefaults('pi').model;
    const parsed = this.parseModelRef(configured);
    if (!parsed) {
      return;
    }

    try {
      await runtime.send({
        type: 'set_model',
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
    } catch (error) {
      // A default that Pi rejects (renamed/unavailable model) must not stop the
      // session from starting; it just falls back to Pi's own choice.
      this.logger.warn(
        `Could not apply the default Pi model session=${sessionId} model=${JSON.stringify(configured)}: ${String(error)}`,
      );
    }
  }

  private async refreshStateFromRpc(sessionId: number): Promise<void> {
    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return;
    const state = this.ensureRuntimeState(sessionId);
    const rpcState = await runtime.send<Record<string, unknown>>({
      type: 'get_state',
    });
    const sessionFile =
      typeof rpcState.sessionFile === 'string' ? rpcState.sessionFile : null;
    if (sessionFile && state.piSessionPath !== sessionFile) {
      state.piSessionPath = sessionFile;
      this.emitEvent({
        type: 'session_created',
        payload: { sessionId, claudeSessionId: sessionFile },
      });
      await this.sessionsService.updatePiSessionPath(sessionId, sessionFile);
    }
    const model = this.modelRefFromModelObject(rpcState.model);
    if (model) state.selectedModel = model;
    state.authStatus = await this.authService.getStatus();
    this.emitSessionMetadata(sessionId);
    await this.refreshModels(sessionId);
  }

  private async generateAndSaveSessionTitle(
    sessionId: number,
    worktreePath: string,
    prompt: string,
  ): Promise<void> {
    try {
      this.logger.log(
        `Pi session title generation started session=${sessionId} worktreePath=${JSON.stringify(worktreePath)} promptLength=${prompt.length}`,
      );
      const title = await this.titleService.generate(
        worktreePath,
        prompt,
        'pi',
      );
      if (!title) {
        this.logger.warn(
          `Pi session title generation produced no title session=${sessionId}`,
        );
        return;
      }
      const updated = await this.sessionsService.renameFromGeneratedTitle(
        sessionId,
        title,
      );
      this.logger.log(
        `Pi session title generation saved session=${sessionId} title=${JSON.stringify(title)} persistedName=${JSON.stringify(updated?.name ?? null)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Session title generation failed session=${sessionId}: ${String(error)}`,
      );
    }
  }

  private async refreshModels(sessionId: number): Promise<void> {
    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return;
    const state = this.ensureRuntimeState(sessionId);
    try {
      const response = await runtime.send<{ models?: unknown[] }>({
        type: 'get_available_models',
      });
      const models = (Array.isArray(response?.models) ? response.models : [])
        .map((model) => this.toModelOption(model))
        .filter((model): model is ClaudeModelOption => Boolean(model));
      state.availableModels = models;
      // A running Pi RPC process is the freshest source of truth for the
      // current account's models, so opportunistically update the global
      // cache other sessions/pickers read from.
      if (models.length) {
        this.modelsCache = models;
        this.modelsCacheAt = Date.now();
      }
    } catch {
      state.availableModels = this.modelsCache ? [...this.modelsCache] : [];
    }
  }

  /**
   * Refreshes the process-wide model list cache by spawning a short-lived Pi
   * RPC process, independent of any session's worktree/runtime. Concurrent
   * calls are coalesced into a single in-flight refresh.
   */
  private async refreshGlobalModels(
    reason: string,
    force = false,
  ): Promise<ClaudeModelOption[]> {
    if (this.modelsRefreshPromise) return this.modelsRefreshPromise;
    if (!force && Date.now() - this.modelsCacheAt < MODELS_CACHE_TTL_MS) {
      return this.modelsCache ?? [];
    }

    const refreshPromise = (async () => {
      const runtime = new PiSessionRuntime({
        cwd: tmpdir(),
        timeoutMs: 15_000,
      });
      try {
        await runtime.start();
        const response = await runtime.send<{ models?: unknown[] }>({
          type: 'get_available_models',
        });
        const models = (Array.isArray(response?.models) ? response.models : [])
          .map((model) => this.toModelOption(model))
          .filter((model): model is ClaudeModelOption => Boolean(model));
        if (models.length) {
          this.modelsCache = models;
        }
        this.modelsCacheAt = Date.now();
        this.logger.debug(
          `Refreshed Pi models cache reason=${reason} count=${models.length}`,
        );
        return this.modelsCache ?? [];
      } catch (error) {
        // Keep serving the last known-good list rather than clearing it out
        // on a transient failure (e.g. Pi CLI briefly unavailable).
        this.modelsCacheAt = Date.now();
        this.logger.debug(
          `Failed to refresh Pi models cache reason=${reason}: ${String(error)}`,
        );
        return this.modelsCache ?? [];
      } finally {
        await runtime.stop().catch(() => undefined);
      }
    })();

    this.modelsRefreshPromise = refreshPromise.finally(() => {
      this.modelsRefreshPromise = null;
    });
    return this.modelsRefreshPromise;
  }

  private refreshGlobalModelsIfStale(): void {
    if (Date.now() - this.modelsCacheAt < MODELS_CACHE_TTL_MS) return;
    this.refreshGlobalModels('stale_on_read').catch(() => undefined);
  }

  private handlePiEvent(sessionId: number, event: PiSessionRuntimeEvent): void {
    switch (event.type) {
      case 'agent_start':
        return;
      case 'agent_end':
        this.resolveActiveRun(sessionId);
        return;
      case 'message_start':
      case 'message_end':
        this.handleMessageEvent(sessionId, event);
        return;
      case 'message_update':
        this.handleMessageUpdate(sessionId, event);
        return;
      case 'tool_execution_start': {
        const toolUseId = String(event.toolCallId ?? randomUUID());
        const toolName = String(event.toolName ?? 'Tool');
        const providerToolInput = this.normalizePiToolInput(
          toolName,
          event.args,
        );
        const canonicalTool = canonicalizeAgentTool(
          toolName,
          providerToolInput,
        );
        this.pushItem(
          sessionId,
          {
            id: `${toolUseId}:tool_use`,
            kind: 'tool_use',
            toolUseId,
            toolName,
            providerToolName: toolName,
            toolKind: canonicalTool.toolKind,
            toolDisplayName: canonicalTool.toolDisplayName,
            toolInput: canonicalTool.toolInput,
            providerToolInput,
            sourceMessageId: toolUseId,
            timestamp: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
          },
          'tool_use',
        );
        return;
      }
      case 'tool_execution_update':
        return;
      case 'tool_execution_end':
        this.pushItem(
          sessionId,
          {
            id: `${String(event.toolCallId ?? randomUUID())}:tool_result`,
            kind: 'tool_result',
            toolUseId: String(event.toolCallId ?? ''),
            toolName: String(event.toolName ?? 'Tool'),
            content: this.stringifyToolResult(event.result),
            isError: Boolean(event.isError),
            timestamp: new Date().toISOString(),
            authoredAt: new Date().toISOString(),
          },
          'tool_result',
        );
        return;
      case 'extension_error':
        this.emitError(
          sessionId,
          `Pi extension error: ${String(event.error ?? 'unknown error')}`,
        );
        return;
      case 'error':
        this.emitError(sessionId, String(event.message ?? 'Pi runtime error'));
        return;
      default:
        return;
    }
  }

  private handleMessageEvent(
    sessionId: number,
    event: PiSessionRuntimeEvent,
  ): void {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || event.type !== 'message_end') return;
    if (message.role === 'user') return;
    const state = this.ensureRuntimeState(sessionId);
    // Reuse the exact id assigned to this message while it was streaming (if
    // any) so the final snapshot reconciles with the in-progress
    // text/thinking items instead of appending duplicates. Passed as
    // `precomputedId` (rather than `fallbackId`) so it is used verbatim
    // instead of being combined again with the message timestamp.
    for (const item of this.messageToTranscriptItems(
      message,
      randomUUID(),
      undefined,
      state.streamingAssistantMessageId ?? undefined,
    )) {
      const type =
        item.kind === 'tool_result'
          ? 'tool_result'
          : item.kind === 'tool_use'
            ? 'tool_use'
            : item.kind === 'thinking'
              ? 'thinking_start'
              : 'message_start';
      this.pushItem(sessionId, item, type);
    }
    state.streamingAssistantMessageId = null;
  }

  private handleMessageUpdate(
    sessionId: number,
    event: PiSessionRuntimeEvent,
  ): void {
    const update = event.assistantMessageEvent as
      | Record<string, unknown>
      | undefined;
    if (!update) return;
    const message = event.message as Record<string, unknown> | undefined;
    const state = this.ensureRuntimeState(sessionId);
    // Assign the id once per streamed assistant message and reuse it for
    // every subsequent update (and the final message_end snapshot). Calling
    // messageId(message) again on every event would mint a fresh random
    // fallback id whenever the provider doesn't attach a stable signature
    // (e.g. non-Anthropic reasoning), breaking delta accumulation and
    // leaving both a stale streamed item and a duplicate final item.
    const sourceMessageId =
      state.streamingAssistantMessageId ??
      (state.streamingAssistantMessageId = this.messageId(
        message,
        randomUUID(),
      ));
    const contentIndex = Number(update.contentIndex ?? 0);
    const itemId = `${sourceMessageId}:${update.type}:${contentIndex}`;

    if (update.type === 'text_start') {
      this.pushItem(sessionId, {
        id: itemId,
        kind: 'assistant',
        content: '',
        sourceMessageId,
        timestamp: this.timestampFromMessage(message),
        receivedAt: new Date().toISOString(),
      });
      return;
    }
    if (update.type === 'thinking_start') {
      this.pushItem(
        sessionId,
        {
          id: itemId,
          kind: 'thinking',
          content: '',
          sourceMessageId,
          timestamp: this.timestampFromMessage(message),
          receivedAt: new Date().toISOString(),
        },
        'thinking_start',
      );
      return;
    }
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      this.appendDelta(
        sessionId,
        itemId.replace('text_delta', 'text_start'),
        update.delta,
        'message_delta',
      );
      return;
    }
    if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
      this.appendDelta(
        sessionId,
        itemId.replace('thinking_delta', 'thinking_start'),
        update.delta,
        'thinking_delta',
      );
      return;
    }
    if (update.type === 'toolcall_end') {
      const toolCall = update.toolCall as Record<string, unknown> | undefined;
      if (!toolCall) return;
      const toolUseId = String(toolCall.id ?? randomUUID());
      const toolName = String(toolCall.name ?? 'Tool');
      const providerToolInput = this.normalizePiToolInput(
        toolName,
        toolCall.arguments,
      );
      const canonicalTool = canonicalizeAgentTool(toolName, providerToolInput);
      this.pushItem(
        sessionId,
        {
          id: `${sourceMessageId}:tool:${toolUseId}`,
          kind: 'tool_use',
          toolUseId,
          toolName,
          providerToolName: toolName,
          toolKind: canonicalTool.toolKind,
          toolDisplayName: canonicalTool.toolDisplayName,
          toolInput: canonicalTool.toolInput,
          providerToolInput,
          sourceMessageId,
          timestamp: this.timestampFromMessage(message),
          receivedAt: new Date().toISOString(),
        },
        'tool_use',
      );
    }
  }

  private handleExtensionUiRequest(
    sessionId: number,
    request: PiRpcExtensionUiRequest,
  ): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (request.method === 'notify') {
      const message =
        typeof request.message === 'string'
          ? request.message
          : 'Pi notification';
      this.emitEvent({
        type: 'notification',
        payload: {
          sessionId,
          notification: {
            key: request.id,
            text: message,
            priority: request.notifyType === 'error' ? 'high' : 'low',
            timestamp: new Date().toISOString(),
          },
        },
      });
      return;
    }
    if (!['select', 'confirm', 'input', 'editor'].includes(request.method)) {
      return;
    }
    const now = new Date().toISOString();
    const uiRequest: ClaudeUserInputRequest = {
      requestId: request.id,
      serverName: 'pi',
      message: this.extensionUiMessage(request),
      mode: 'form',
      title: typeof request.title === 'string' ? request.title : 'Pi input',
      displayName: 'Pi',
      description: request.method,
      requestedSchema: this.extensionUiSchema(request),
      createdAt: now,
    };
    run.userInputRequests.set(request.id, {
      request: uiRequest,
      rpcRequestId: request.id,
      method: request.method,
    });
    const state = this.ensureRuntimeState(sessionId);
    state.pendingUserInputRequest = uiRequest;
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';
    this.emitRunState(sessionId);
    this.emitEvent({
      type: 'user_input_request',
      payload: { sessionId, request: uiRequest },
    });
  }

  private resolveActiveRun(sessionId: number): void {
    this.refreshStateFromRpc(sessionId).catch(() => undefined);
    const run = this.activeRuns.get(sessionId);
    run?.resolveCompletion();
  }

  private finishRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = state.lastError ? 'error' : 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.pendingUserInputRequest = null;
    this.emitRunState(sessionId);
    this.emitEvent({ type: 'complete', payload: { sessionId } });
  }

  private finalizeInterruptedRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.lastError = null;
    state.pendingUserInputRequest = null;
    this.emitRunState(sessionId);
    this.emitEvent({ type: 'complete', payload: { sessionId } });
  }

  private handleRuntimeExit(
    sessionId: number,
    details: { message?: string; stderr?: string },
  ): void {
    this.runtimes.delete(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    if (this.activeRuns.has(sessionId)) {
      const message =
        details.stderr?.trim() || details.message || 'Pi RPC process exited';
      state.lastError = message;
      state.runPhase = 'error';
      state.sessionState = 'idle';
      state.canInterrupt = false;
      this.emitError(sessionId, message);
      this.activeRuns.get(sessionId)?.resolveCompletion();
    }
    this.emitRunState(sessionId);
  }

  private async stopRuntime(sessionId: number): Promise<void> {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    this.clearIdleTimer(entry);
    this.runtimes.delete(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (run) {
      run.interruptRequested = true;
      run.resolveCompletion();
    }
    await entry.runtime.stop();
  }

  private scheduleIdleShutdown(sessionId: number): void {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    if (this.activeRuns.has(sessionId) || entry.attachedClients > 0) return;
    this.clearIdleTimer(entry);
    entry.lastIdleAt = Date.now();
    entry.idleTimer = setTimeout(() => {
      this.stopRuntime(sessionId).catch((error) =>
        this.logger.warn(
          `Failed to stop idle Pi runtime ${sessionId}: ${String(error)}`,
        ),
      );
    }, this.idleShutdownMs);
    this.enforceIdleRuntimeCap();
  }

  private enforceIdleRuntimeCap(): void {
    const idleDetached = [...this.runtimes.values()]
      .filter(
        (entry) =>
          !this.activeRuns.has(entry.sessionId) && entry.attachedClients === 0,
      )
      .sort((a, b) => a.lastIdleAt - b.lastIdleAt);
    const excess = idleDetached.length - this.idleRuntimeCap;
    if (excess <= 0) return;
    for (const entry of idleDetached.slice(0, excess)) {
      this.stopRuntime(entry.sessionId).catch(() => undefined);
    }
  }

  private clearIdleTimer(entry: PiRuntimeEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private ensureRuntimeState(
    sessionId: number,
    piSessionPath?: string | null,
  ): PiRuntimeState {
    const existing = this.runtimeStates.get(sessionId);
    if (existing) {
      if (piSessionPath && piSessionPath !== '-1')
        existing.piSessionPath = piSessionPath;
      return existing;
    }
    const availableModels = this.modelsCache ? [...this.modelsCache] : [];
    const startup = resolveAgentStartupSelection(
      this.settingsService.getAgentProviderDefaults('pi'),
      availableModels,
    );

    const state: PiRuntimeState = {
      piSessionPath:
        piSessionPath && piSessionPath !== '-1' ? piSessionPath : null,
      cachedWorktreePath: null,
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPrompts: [],
      liveItems: [],
      streamingAssistantMessageId: null,
      pendingUserInputRequest: null,
      lastError: null,
      selectedModel: startup.selectedModel,
      reasoningEffort: startup.reasoningEffort,
      fastMode: false,
      availableModels,
      contextUsage: null,
      sessionMetadata: null,
      authStatus: null,
    };
    this.runtimeStates.set(sessionId, state);
    return state;
  }

  private emitSessionMetadata(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    const metadata: PiRuntimeSessionMetadata = {
      cwd: state.cachedWorktreePath ?? '',
      model: state.selectedModel ?? 'default',
      permissionMode: 'default',
      piVersion: state.authStatus?.version ?? 'unknown',
      authMethod: state.authStatus?.authMethod ?? 'unknown',
      outputStyle: 'default',
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Find', 'Ls'],
      slashCommands: [],
      skills: [],
      fastModeState: state.fastMode ? 'on' : 'off',
      mcpServers: [],
      agents: [],
      plugins: [],
    };
    state.sessionMetadata = metadata;
    this.emitEvent({
      type: 'session_metadata',
      payload: { sessionId, metadata: metadata as never },
    });
  }

  private emitRunState(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    this.hooksService.updateRuntimeActivity(
      sessionId,
      this.toSidebarActivity(state),
    );
    this.emitEvent({
      type: 'run_state',
      payload: {
        sessionId,
        runPhase: state.runPhase,
        sessionState: state.sessionState,
        canInterrupt: state.canInterrupt,
        lastError: state.lastError,
        selectedModel: state.selectedModel,
        reasoningEffort: state.reasoningEffort,
        fastMode: state.fastMode,
        permissionMode: null,
        planMode: false,
        availableModels: state.availableModels,
        contextUsage: state.contextUsage,
        pendingPermissionRequest: null,
        pendingUserInputRequest: state.pendingUserInputRequest,
        pendingPrompts: state.pendingPrompts,
      },
    });
  }

  private toSidebarActivity(state: PiRuntimeState): ClaudeSessionActivity {
    if (state.pendingUserInputRequest) {
      return {
        activityStatus: 'waiting',
        actionKind: 'user_input',
        actionLabel: 'Input needed',
      backgroundActive: false,
      };
    }
    return {
      activityStatus:
        state.runPhase === 'running' || state.runPhase === 'waiting'
          ? state.runPhase
          : 'idle',
      actionKind: null,
      actionLabel: null,
      backgroundActive: false,
    };
  }

  private toRuntimeStatePayload(
    sessionId: number,
    state: PiRuntimeState,
  ): PiRuntimeStatePayload {
    return {
      sessionId,
      claudeSessionId: state.piSessionPath,
      runPhase: state.runPhase,
      sessionState: state.sessionState,
      canInterrupt: state.canInterrupt,
      pendingPermissionRequest: null,
      pendingUserInputRequest: state.pendingUserInputRequest,
      pendingPrompts: state.pendingPrompts,
      liveItems: state.liveItems,
      lastError: state.lastError,
      selectedModel: state.selectedModel,
      reasoningEffort: state.reasoningEffort,
      fastMode: state.fastMode,
      permissionMode: null,
      planMode: false,
      availableModels: state.availableModels,
      contextUsage: state.contextUsage,
      sessionMetadata: state.sessionMetadata,
      runtimeStatus: null,
      authStatus: state.authStatus,
      rateLimit: null,
      notifications: [],
      hooks: [],
      recentHookEvents: [],
      tasks: [],
      taskLifecycle: [],
      subagents: [],
      latestToolProgress: null,
      latestToolSummary: null,
      latestApiRetry: null,
      latestPluginInstall: null,
      latestMemoryRecall: null,
      latestFilesPersisted: null,
      latestElicitationCompletion: null,
      latestPromptSuggestion: null,
      latestCompactBoundary: null,
      latestMirrorError: null,
      warmState: this.runtimes.has(sessionId) ? 'warm' : 'cold',
      lastWarmedAt: this.runtimes.has(sessionId)
        ? new Date(this.runtimes.get(sessionId)!.lastIdleAt).toISOString()
        : null,
      lastPromptTiming: null,
    };
  }

  private pushItem(
    sessionId: number,
    item: ClaudeTranscriptItem,
    eventType:
      | 'message_start'
      | 'thinking_start'
      | 'tool_use'
      | 'tool_result' = 'message_start',
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.liveItems = [
      ...state.liveItems.filter((existing) => existing.id !== item.id),
      item,
    ];
    this.emitEvent({
      type: eventType,
      payload: { sessionId, item },
    });
  }

  private appendDelta(
    sessionId: number,
    itemId: string,
    delta: string,
    eventType: 'message_delta' | 'thinking_delta',
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.liveItems = state.liveItems.map((item) =>
      item.id === itemId
        ? { ...item, content: `${item.content ?? ''}${delta}` }
        : item,
    );
    this.emitEvent({
      type: eventType,
      payload: { sessionId, itemId, delta },
    });
  }

  private emitError(sessionId: number, message: string): void {
    const state = this.ensureRuntimeState(sessionId);
    state.lastError = message;
    state.runPhase = 'error';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    this.emitEvent({ type: 'error', payload: { sessionId, message } });
    this.emitRunState(sessionId);
  }

  private emitEvent(event: Record<string, unknown>): void {
    this.emit('event', event);
  }

  private async readHistoryFromSessionFile(
    path: string,
  ): Promise<ClaudeTranscriptItem[]> {
    if (!path || path === '-1') return [];
    const entries = await this.readPiSessionRecords(path);
    return this.transcriptItemsFromEntries(entries);
  }

  /**
   * Recovers history for a session whose file is missing (pi defers the
   * first write until an assistant message completes) or whose path is not
   * recorded yet: reads the in-memory entries from the already-running RPC
   * process and overlays whatever is currently streaming. Never spawns a
   * runtime on its own.
   */
  private async readLiveHistory(
    sessionId: number,
    state: PiRuntimeState,
  ): Promise<ClaudeTranscriptItem[]> {
    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return this.overlayLiveItems(state, []);
    try {
      const response = await runtime.send<{ entries?: unknown }>({
        type: 'get_entries',
      });
      const entries = Array.isArray(response?.entries)
        ? (response.entries as Record<string, unknown>[])
        : [];
      return this.overlayLiveItems(
        state,
        this.transcriptItemsFromEntries(entries),
      );
    } catch (error) {
      this.logger.warn(
        `Pi live entries unavailable session=${sessionId}: ${String(error)}`,
      );
      return this.overlayLiveItems(state, []);
    }
  }

  /**
   * Overlays in-memory streamed items on persisted history. The session file
   * lags the stream while a run is active (pi appends entries as messages
   * complete), and streamed items deliberately reuse the ids of their
   * persisted counterparts so the final message_end snapshot reconciles with
   * the in-progress one. Merging by id with the live copy winning therefore
   * yields one copy of each item with the freshest content. Unlike the old
   * behavior this never clears `liveItems`: reattaching clients receive them
   * through runtime snapshots, and clearing them mid-run would blank the
   * in-flight assistant message until the next delta arrives.
   */
  private overlayLiveItems(
    state: PiRuntimeState,
    history: ClaudeTranscriptItem[],
  ): ClaudeTranscriptItem[] {
    if (!state.liveItems.length) return history;
    const byId = new Map(history.map((item) => [item.id, item]));
    for (const item of state.liveItems) byId.set(item.id, item);
    return [...byId.values()].sort((l, r) =>
      l.timestamp.localeCompare(r.timestamp),
    );
  }

  private transcriptItemsFromEntries(
    entries: Record<string, unknown>[],
  ): ClaudeTranscriptItem[] {
    const result: ClaudeTranscriptItem[] = [];
    for (const [index, entry] of entries.entries()) {
      const type = entry.type;
      // Accept both Pi SDK format ("message") and Claude Code CLI format ("user"/"assistant").
      if (type !== 'message' && type !== 'user' && type !== 'assistant')
        continue;
      const rawMessage = asRecord(entry.message);
      if (!rawMessage) continue;
      // Claude Code CLI entries carry timestamp on the top-level entry, not inside message.
      const message =
        typeof entry.timestamp === 'string' && !rawMessage['timestamp']
          ? { ...rawMessage, timestamp: entry.timestamp }
          : rawMessage;
      const entryId = this.piEntryAnchorId(entry, index);
      result.push(...this.messageToTranscriptItems(message, entryId, entryId));
    }
    return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private async readPiSessionRecords(
    path: string,
  ): Promise<Record<string, unknown>[]> {
    const content = await fs.readFile(path, 'utf8');
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  private async writePiSessionRecords(
    path: string,
    records: Record<string, unknown>[],
  ): Promise<void> {
    const serialized =
      records.map((record) => JSON.stringify(record)).join('\n') +
      (records.length ? '\n' : '');
    await fs.writeFile(path, serialized, 'utf8');
  }

  private isForkAnchorEntry(
    entry: Record<string, unknown>,
    index: number,
    anchorMessageId: string,
    anchorKind: 'user' | 'assistant',
  ): boolean {
    if (entry.type !== 'message') return false;
    if (this.piEntryAnchorId(entry, index) !== anchorMessageId) return false;
    const role = asRecord(entry.message)?.role;
    return role === anchorKind;
  }

  private piEntryAnchorId(
    entry: Record<string, unknown>,
    index: number,
  ): string {
    if (typeof entry.id === 'string' && entry.id) return entry.id;
    // Claude Code CLI entries use "uuid" rather than "id".
    if (typeof entry.uuid === 'string' && entry.uuid) return entry.uuid;
    return `pi-entry:${index}`;
  }

  private buildForkSessionPath(sourcePath: string): string {
    const ext = extname(sourcePath) || '.jsonl';
    const base = basename(sourcePath, ext);
    return join(dirname(sourcePath), `${base}-fork-${randomUUID()}${ext}`);
  }

  private messageToTranscriptItems(
    message: Record<string, unknown>,
    fallbackId: string,
    transcriptMessageId?: string,
    precomputedId?: string,
  ): ClaudeTranscriptItem[] {
    // `precomputedId` is used verbatim (e.g. the id already assigned to an
    // assistant message while it was streaming) instead of being re-derived
    // via messageId(), which would otherwise combine it with the message
    // timestamp again and produce a different id than the one used for the
    // in-progress streamed transcript items.
    const id = precomputedId ?? this.messageId(message, fallbackId);
    const timestamp = this.timestampFromMessage(message);
    if (message.role === 'user') {
      return [
        {
          id: `${id}:user`,
          kind: 'user',
          content: this.stripInjectedWorktreeContext(
            this.contentToText(message.content),
          ),
          sourceMessageId: id,
          transcriptMessageId,
          timestamp,
          authoredAt: timestamp,
        },
      ];
    }
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const items: ClaudeTranscriptItem[] = [];
      content.forEach((part, index) => {
        if (!part || typeof part !== 'object') return;
        const block = part as Record<string, unknown>;
        if (block.type === 'text') {
          items.push({
            // Id must match the streaming `text_start` item id
            // (`${sourceMessageId}:text_start:${contentIndex}`) so that the
            // final message_end snapshot replaces the in-progress streamed
            // item instead of being appended as a duplicate transcript entry.
            id: `${id}:text_start:${index}`,
            kind: 'assistant',
            content: typeof block.text === 'string' ? block.text : '',
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          });
        } else if (block.type === 'thinking') {
          items.push({
            // Same rationale as the text block above: align with the
            // streaming `thinking_start` item id so message_end reconciles
            // the streamed reasoning instead of duplicating it.
            id: `${id}:thinking_start:${index}`,
            kind: 'thinking',
            content: typeof block.thinking === 'string' ? block.thinking : '',
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          });
        } else if (block.type === 'toolCall' || block.type === 'tool_use') {
          const toolUseId = String(block.id ?? `${id}:${index}`);
          const toolName = String(block.name ?? 'Tool');
          // Pi SDK uses "arguments"; Claude Code CLI uses "input".
          const rawInput =
            block.type === 'tool_use' ? block['input'] : block['arguments'];
          const providerToolInput = this.normalizePiToolInput(
            toolName,
            rawInput,
          );
          const canonicalTool = canonicalizeAgentTool(
            toolName,
            providerToolInput,
          );
          items.push({
            id: `${id}:tool:${toolUseId}`,
            kind: 'tool_use',
            toolUseId,
            toolName,
            providerToolName: toolName,
            toolKind: canonicalTool.toolKind,
            toolDisplayName: canonicalTool.toolDisplayName,
            toolInput: canonicalTool.toolInput,
            providerToolInput,
            sourceMessageId: id,
            transcriptMessageId,
            timestamp,
            receivedAt: timestamp,
          });
        }
      });
      return items;
    }
    if (message.role === 'toolResult') {
      const toolUseId = String(message.toolCallId ?? id);
      return [
        {
          id: `${id}:tool_result:${toolUseId}`,
          kind: 'tool_result',
          toolUseId,
          toolName:
            typeof message.toolName === 'string' ? message.toolName : undefined,
          content: this.contentToText(message.content),
          isError: Boolean(message.isError),
          sourceMessageId: id,
          transcriptMessageId,
          timestamp,
          authoredAt: timestamp,
        },
      ];
    }
    return [];
  }

  private messageId(
    message?: Record<string, unknown>,
    fallback: string = randomUUID(),
  ): string {
    const signature = Array.isArray(message?.content)
      ? (message.content[0] as Record<string, unknown> | undefined)
          ?.textSignature
      : undefined;
    if (typeof signature === 'string' && signature) return signature;
    const timestamp =
      typeof message?.timestamp === 'number' ? message.timestamp : Date.now();
    return `${fallback}-${timestamp}`;
  }

  private timestampFromMessage(message?: Record<string, unknown>): string {
    if (typeof message?.timestamp === 'number') {
      return new Date(message.timestamp).toISOString();
    }
    if (typeof message?.timestamp === 'string' && message.timestamp) {
      return message.timestamp;
    }
    return new Date().toISOString();
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const block = part as Record<string, unknown>;
        if (block.type === 'text')
          return typeof block.text === 'string' ? block.text : '';
        if (block.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private stripInjectedWorktreeContext(text: string): string {
    const trimmed = text.trimStart();
    const openTag = '<elevenex-worktree-context>';
    const closeTag = '</elevenex-worktree-context>';
    if (!trimmed.startsWith(openTag)) {
      return text;
    }
    const closingIndex = trimmed.indexOf(closeTag);
    if (closingIndex === -1) {
      return text;
    }
    const afterClose = trimmed.slice(closingIndex + closeTag.length);
    return afterClose.replace(/^\s+/, '');
  }

  private stringifyToolResult(result: unknown): string {
    if (!result || typeof result !== 'object') return String(result ?? '');
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content))
      return this.contentToText(record.content);
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  private normalizeImages(
    images?: AgentImageInput[],
  ): Array<Record<string, string>> {
    return (images ?? []).map((image) => ({
      type: 'image',
      data: image.data,
      mimeType: image.mediaType,
    }));
  }

  private toAutocompleteItem(command: unknown): ClaudeAutocompleteItem | null {
    if (!command || typeof command !== 'object') return null;
    const record = command as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!name) return null;
    const source = record.source === 'skill' ? 'runtime' : 'runtime';
    return {
      id: `pi:${name}`,
      kind: name.startsWith('skill:') ? 'skill' : 'command',
      trigger: '/',
      label: name,
      insertText: `/${name}`,
      description:
        typeof record.description === 'string'
          ? record.description
          : 'Pi command',
      source,
    };
  }

  private toModelOption(model: unknown): ClaudeModelOption | null {
    if (!model || typeof model !== 'object') return null;
    const record = model as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider : '';
    const id = typeof record.id === 'string' ? record.id : '';
    if (!provider || !id) return null;
    const modelRef = `${provider}/${id}`;
    return {
      id: modelRef,
      displayName:
        typeof record.name === 'string' && record.name.trim()
          ? record.name
          : modelRef,
      description: `${provider} model`,
      supportsEffort: Boolean(record.reasoning),
    };
  }

  private modelRefFromModelObject(model: unknown): string | null {
    if (!model || typeof model !== 'object') return null;
    const record = model as Record<string, unknown>;
    const provider = typeof record.provider === 'string' ? record.provider : '';
    const id = typeof record.id === 'string' ? record.id : '';
    return provider && id ? `${provider}/${id}` : null;
  }

  private parseModelRef(
    model: string | null,
  ): { provider: string; modelId: string } | null {
    if (!model) return null;
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) return null;
    return {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    };
  }

  private extensionUiMessage(request: PiRpcExtensionUiRequest): string {
    if (typeof request.message === 'string' && request.message.trim()) {
      return request.message;
    }
    if (typeof request.title === 'string' && request.title.trim()) {
      return request.title;
    }
    return 'Pi is requesting input.';
  }

  private extensionUiSchema(
    request: PiRpcExtensionUiRequest,
  ): Record<string, unknown> {
    if (request.method === 'select' && Array.isArray(request.options)) {
      return {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            enum: request.options.filter(
              (option) => typeof option === 'string',
            ),
          },
        },
        required: ['value'],
      };
    }
    if (request.method === 'confirm') {
      return {
        type: 'object',
        properties: { confirmed: { type: 'boolean' } },
        required: ['confirmed'],
      };
    }
    return {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    };
  }

  private normalizePiToolInput(toolName: string, args: unknown): unknown {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const normalized = toolName.toLowerCase().replace(/[_\-\s]/g, '');
    const input = args as Record<string, unknown>;
    if (
      normalized === 'read' ||
      normalized === 'readfile' ||
      normalized === 'fileread'
    ) {
      return {
        ...input,
        file_path:
          typeof input['file_path'] === 'string'
            ? input['file_path']
            : input['path'],
      };
    }
    if (
      normalized === 'write' ||
      normalized === 'create' ||
      normalized === 'filewrite'
    ) {
      return {
        ...input,
        file_path:
          typeof input['file_path'] === 'string'
            ? input['file_path']
            : input['path'],
      };
    }
    if (
      normalized === 'bash' ||
      normalized === 'shell' ||
      normalized === 'shellcommand'
    ) {
      return {
        ...input,
        command:
          typeof input['command'] === 'string'
            ? input['command']
            : typeof input['cmd'] === 'string'
              ? input['cmd']
              : input['input'],
      };
    }
    if (normalized !== 'edit' && normalized !== 'multiedit') return args;
    const edits = input['edits'];
    if (!Array.isArray(edits) || edits.length === 0) return args;
    const filePath =
      typeof input['path'] === 'string' ? input['path'] : input['file_path'];
    if (edits.length === 1) {
      const edit = edits[0] as Record<string, unknown>;
      return {
        file_path: filePath,
        old_string: typeof edit['oldText'] === 'string' ? edit['oldText'] : '',
        new_string: typeof edit['newText'] === 'string' ? edit['newText'] : '',
      };
    }
    return {
      file_path: filePath,
      edits: edits.map((edit) => {
        const e = edit as Record<string, unknown>;
        return {
          old_string: typeof e['oldText'] === 'string' ? e['oldText'] : '',
          new_string: typeof e['newText'] === 'string' ? e['newText'] : '',
        };
      }),
    };
  }

  private toExtensionUiResponse(
    id: string,
    method: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): Record<string, unknown> {
    if (action === 'cancel') {
      return { type: 'extension_ui_response', id, cancelled: true };
    }
    if (method === 'confirm') {
      return {
        type: 'extension_ui_response',
        id,
        confirmed: action === 'accept' && content?.confirmed !== false,
      };
    }
    const value =
      typeof content?.value === 'string'
        ? content.value
        : action === 'accept'
          ? ''
          : undefined;
    return value === undefined
      ? { type: 'extension_ui_response', id, cancelled: true }
      : { type: 'extension_ui_response', id, value };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}
