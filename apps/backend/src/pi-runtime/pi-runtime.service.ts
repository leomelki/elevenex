import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { SessionsService } from '../sessions/sessions.service.js';
import type { AgentImageInput } from '../agent-runtime/agent-runtime.types.js';
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
export class PiRuntimeService extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(PiRuntimeService.name);
  private readonly activeRuns = new Map<number, PiActiveRun>();
  private readonly runtimeStates = new Map<number, PiRuntimeState>();
  private readonly runtimes = new Map<number, PiRuntimeEntry>();
  private readonly clientCounts = new Map<number, number>();
  private readonly idleShutdownMs = Number(process.env.PI_RUNTIME_IDLE_MS)
    || DEFAULT_IDLE_SHUTDOWN_MS;
  private readonly idleRuntimeCap = Number(process.env.PI_RUNTIME_IDLE_CAP)
    || DEFAULT_IDLE_RUNTIME_CAP;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: PiAuthService,
  ) {
    super();
  }

  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    if (!state.piSessionPath) return [];
    return this.readHistoryFromSessionFile(state.piSessionPath);
  }

  async getRuntimeState(sessionId: number): Promise<PiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.piSessionPath);
    state.cachedWorktreePath = session.worktreePath;
    state.authStatus = await this.authService.getStatus();
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSnapshot(sessionId: number): Promise<PiSessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);
    return { ...runtimeState, history };
  }

  async getAutocompleteItems(sessionId: number): Promise<ClaudeAutocompleteItem[]> {
    try {
      const runtime = await this.ensureRuntime(sessionId);
      const response = await runtime.send<{ commands?: unknown[] }>({
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

  async submitPrompt(
    sessionId: number,
    prompt: string,
    images?: AgentImageInput[],
  ): Promise<void> {
    const trimmedPrompt = prompt.trim();
    const normalizedImages = this.normalizeImages(images);
    if (!trimmedPrompt && normalizedImages.length === 0) return;

    if (this.activeRuns.has(sessionId)) {
      const state = this.ensureRuntimeState(sessionId);
      state.pendingPrompts = [
        ...state.pendingPrompts,
        {
          id: randomUUID(),
          prompt: trimmedPrompt,
          queuedAt: new Date().toISOString(),
          ...(images?.length ? { images } : {}),
        },
      ];
      this.emitRunState(sessionId);
      return;
    }

    const runtime = await this.ensureRuntime(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'running';
    state.sessionState = 'running';
    state.canInterrupt = true;
    state.lastError = null;
    state.liveItems = [];
    this.emitRunState(sessionId);

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

    try {
      await this.sessionsService.updateStatus(sessionId, 'active');
      await runtime.send({
        type: 'prompt',
        message: trimmedPrompt,
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
          this.submitPrompt(sessionId, next.prompt, next.images).catch((error) => {
            this.logger.error(
              `Pending Pi prompt failed session=${sessionId}: ${String(error)}`,
            );
          });
        });
      }
    }
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
    state.pendingPrompts = state.pendingPrompts.filter((prompt) => prompt.id !== id);
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
      this.toExtensionUiResponse(pending.rpcRequestId, pending.method, action, content),
    );
  }

  async cleanupSession(sessionId: number): Promise<void> {
    await this.stopRuntime(sessionId);
    this.runtimeStates.delete(sessionId);
    this.clientCounts.delete(sessionId);
  }

  onClientAttached(sessionId: number): void {
    this.clientCounts.set(sessionId, (this.clientCounts.get(sessionId) ?? 0) + 1);
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
    await Promise.all([...this.runtimes.keys()].map((id) => this.stopRuntime(id)));
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

    runtime.start();
    await this.refreshStateFromRpc(sessionId);
    this.enforceIdleRuntimeCap();
    return runtime;
  }

  private async refreshStateFromRpc(sessionId: number): Promise<void> {
    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return;
    const state = this.ensureRuntimeState(sessionId);
    const rpcState = await runtime.send<Record<string, unknown>>({ type: 'get_state' });
    const sessionFile = typeof rpcState.sessionFile === 'string'
      ? rpcState.sessionFile
      : null;
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

  private async refreshModels(sessionId: number): Promise<void> {
    const runtime = this.runtimes.get(sessionId)?.runtime;
    if (!runtime) return;
    const state = this.ensureRuntimeState(sessionId);
    try {
      const response = await runtime.send<{ models?: unknown[] }>({
        type: 'get_available_models',
      });
      state.availableModels = (Array.isArray(response?.models) ? response.models : [])
        .map((model) => this.toModelOption(model))
        .filter((model): model is ClaudeModelOption => Boolean(model));
    } catch {
      state.availableModels = [];
    }
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
        this.pushItem(sessionId, {
          id: `${toolUseId}:tool_use`,
          kind: 'tool_use',
          toolUseId,
          toolName: String(event.toolName ?? 'Tool'),
          toolInput: event.args,
          sourceMessageId: toolUseId,
          timestamp: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        }, 'tool_use');
        return;
      }
      case 'tool_execution_update':
        return;
      case 'tool_execution_end':
        this.pushItem(sessionId, {
          id: `${String(event.toolCallId ?? randomUUID())}:tool_result`,
          kind: 'tool_result',
          toolUseId: String(event.toolCallId ?? ''),
          toolName: String(event.toolName ?? 'Tool'),
          content: this.stringifyToolResult(event.result),
          isError: Boolean(event.isError),
          timestamp: new Date().toISOString(),
          authoredAt: new Date().toISOString(),
        }, 'tool_result');
        return;
      case 'extension_error':
        this.emitError(sessionId, `Pi extension error: ${String(event.error ?? 'unknown error')}`);
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
    for (const item of this.messageToTranscriptItems(message, String(event.type))) {
      const type = item.kind === 'tool_result'
        ? 'tool_result'
        : item.kind === 'tool_use'
          ? 'tool_use'
          : item.kind === 'thinking'
            ? 'thinking_start'
            : 'message_start';
      this.pushItem(sessionId, item, type);
    }
  }

  private handleMessageUpdate(
    sessionId: number,
    event: PiSessionRuntimeEvent,
  ): void {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!update) return;
    const message = event.message as Record<string, unknown> | undefined;
    const sourceMessageId = this.messageId(message);
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
      this.pushItem(sessionId, {
        id: itemId,
        kind: 'thinking',
        content: '',
        sourceMessageId,
        timestamp: this.timestampFromMessage(message),
        receivedAt: new Date().toISOString(),
      }, 'thinking_start');
      return;
    }
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      this.appendDelta(sessionId, itemId.replace('text_delta', 'text_start'), update.delta, 'message_delta');
      return;
    }
    if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
      this.appendDelta(sessionId, itemId.replace('thinking_delta', 'thinking_start'), update.delta, 'thinking_delta');
      return;
    }
    if (update.type === 'toolcall_end') {
      const toolCall = update.toolCall as Record<string, unknown> | undefined;
      if (!toolCall) return;
      const toolUseId = String(toolCall.id ?? randomUUID());
      this.pushItem(sessionId, {
        id: `${sourceMessageId}:tool:${toolUseId}`,
        kind: 'tool_use',
        toolUseId,
        toolName: String(toolCall.name ?? 'Tool'),
        toolInput: toolCall.arguments,
        sourceMessageId,
        timestamp: this.timestampFromMessage(message),
        receivedAt: new Date().toISOString(),
      }, 'tool_use');
    }
  }

  private handleExtensionUiRequest(
    sessionId: number,
    request: PiRpcExtensionUiRequest,
  ): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    if (request.method === 'notify') {
      const message = typeof request.message === 'string' ? request.message : 'Pi notification';
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
      const message = details.stderr?.trim() || details.message || 'Pi RPC process exited';
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
        this.logger.warn(`Failed to stop idle Pi runtime ${sessionId}: ${String(error)}`),
      );
    }, this.idleShutdownMs);
    this.enforceIdleRuntimeCap();
  }

  private enforceIdleRuntimeCap(): void {
    const idleDetached = [...this.runtimes.values()]
      .filter((entry) => !this.activeRuns.has(entry.sessionId) && entry.attachedClients === 0)
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
      if (piSessionPath && piSessionPath !== '-1') existing.piSessionPath = piSessionPath;
      return existing;
    }
    const state: PiRuntimeState = {
      piSessionPath: piSessionPath && piSessionPath !== '-1' ? piSessionPath : null,
      cachedWorktreePath: null,
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPrompts: [],
      liveItems: [],
      pendingUserInputRequest: null,
      lastError: null,
      selectedModel: null,
      availableModels: [],
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
      fastModeState: null,
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
    this.emitEvent({
      type: 'run_state',
      payload: {
        sessionId,
        runPhase: state.runPhase,
        sessionState: state.sessionState,
        canInterrupt: state.canInterrupt,
        lastError: state.lastError,
        selectedModel: state.selectedModel,
        permissionMode: null,
        availableModels: state.availableModels,
        contextUsage: state.contextUsage,
        pendingPermissionRequest: null,
        pendingUserInputRequest: state.pendingUserInputRequest,
        pendingPrompts: state.pendingPrompts,
      },
    });
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
      permissionMode: null,
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

  private readHistoryFromSessionFile(path: string): ClaudeTranscriptItem[] {
    if (!path || path === '-1' || !existsSync(path)) return [];
    const result: ClaudeTranscriptItem[] = [];
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== 'message') continue;
        const message = entry.message as Record<string, unknown>;
        result.push(...this.messageToTranscriptItems(message, String(entry.id ?? randomUUID())));
      } catch {
        // Ignore malformed history entries.
      }
    }
    return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private messageToTranscriptItems(
    message: Record<string, unknown>,
    fallbackId: string,
  ): ClaudeTranscriptItem[] {
    const id = this.messageId(message, fallbackId);
    const timestamp = this.timestampFromMessage(message);
    if (message.role === 'user') {
      return [{
        id: `${id}:user`,
        kind: 'user',
        content: this.contentToText(message.content),
        sourceMessageId: id,
        timestamp,
        authoredAt: timestamp,
      }];
    }
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      const items: ClaudeTranscriptItem[] = [];
      content.forEach((part, index) => {
        if (!part || typeof part !== 'object') return;
        const block = part as Record<string, unknown>;
        if (block.type === 'text') {
          items.push({
            id: `${id}:assistant:${index}`,
            kind: 'assistant',
            content: typeof block.text === 'string' ? block.text : '',
            sourceMessageId: id,
            timestamp,
            receivedAt: timestamp,
          });
        } else if (block.type === 'thinking') {
          items.push({
            id: `${id}:thinking:${index}`,
            kind: 'thinking',
            content: typeof block.thinking === 'string' ? block.thinking : '',
            sourceMessageId: id,
            timestamp,
            receivedAt: timestamp,
          });
        } else if (block.type === 'toolCall') {
          const toolUseId = String(block.id ?? `${id}:${index}`);
          items.push({
            id: `${id}:tool:${toolUseId}`,
            kind: 'tool_use',
            toolUseId,
            toolName: String(block.name ?? 'Tool'),
            toolInput: block.arguments,
            sourceMessageId: id,
            timestamp,
            receivedAt: timestamp,
          });
        }
      });
      return items;
    }
    if (message.role === 'toolResult') {
      const toolUseId = String(message.toolCallId ?? id);
      return [{
        id: `${id}:tool_result:${toolUseId}`,
        kind: 'tool_result',
        toolUseId,
        toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
        content: this.contentToText(message.content),
        isError: Boolean(message.isError),
        sourceMessageId: id,
        timestamp,
        authoredAt: timestamp,
      }];
    }
    return [];
  }

  private messageId(message?: Record<string, unknown>, fallback: string = randomUUID()): string {
    const signature = Array.isArray(message?.content)
      ? (message.content[0] as Record<string, unknown> | undefined)?.textSignature
      : undefined;
    if (typeof signature === 'string' && signature) return signature;
    const timestamp = typeof message?.timestamp === 'number' ? message.timestamp : Date.now();
    return `${fallback}-${timestamp}`;
  }

  private timestampFromMessage(message?: Record<string, unknown>): string {
    return new Date(
      typeof message?.timestamp === 'number' ? message.timestamp : Date.now(),
    ).toISOString();
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const block = part as Record<string, unknown>;
        if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
        if (block.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private stringifyToolResult(result: unknown): string {
    if (!result || typeof result !== 'object') return String(result ?? '');
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) return this.contentToText(record.content);
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  private normalizeImages(images?: AgentImageInput[]): Array<Record<string, string>> {
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

  private parseModelRef(model: string | null): { provider: string; modelId: string } | null {
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

  private extensionUiSchema(request: PiRpcExtensionUiRequest): Record<string, unknown> {
    if (request.method === 'select' && Array.isArray(request.options)) {
      return {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            enum: request.options.filter((option) => typeof option === 'string'),
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
    const value = typeof content?.value === 'string'
      ? content.value
      : action === 'accept'
        ? ''
        : undefined;
    return value === undefined
      ? { type: 'extension_ui_response', id, cancelled: true }
      : { type: 'extension_ui_response', id, value };
  }
}
