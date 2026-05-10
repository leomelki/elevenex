import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  ApprovalMode,
  Input,
  SandboxMode,
  ThreadEvent,
  ThreadItem,
  Usage,
} from '@openai/codex-sdk';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { SessionsService } from '../sessions/sessions.service.js';
import type { AgentImageInput } from '../agent-runtime/agent-runtime.types.js';
import type {
  ClaudeContextUsage,
  ClaudeModelOption,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import { CodexAuthService } from './codex-auth.service.js';
import { CodexHistoryService } from './codex-history.service.js';
import type {
  CodexActiveRunState,
  CodexPermissionMode,
  CodexRuntimeEvent,
  CodexRuntimeSessionMetadata,
  CodexRuntimeState,
  CodexRuntimeStatePayload,
  CodexSessionSnapshotPayload,
} from './codex-runtime.types.js';

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_CODEX_CONTEXT_WINDOW = 1_050_000;
const CODEX_MODEL_REFRESH_TTL_MS = 60 * 60 * 1000;
const CODEX_MODEL_LIST_TIMEOUT_MS = 8_000;
const CODEX_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.5': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-mini': 1_050_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.2': 400_000,
};
const CODEX_MODELS: ClaudeModelOption[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    supportsEffort: true,
    supportsFastMode: true,
  },
  {
    id: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    supportsEffort: true,
    supportsFastMode: true,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'GPT-5.4-Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    supportsEffort: true,
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Coding-optimized model.',
    supportsEffort: true,
  },
  {
    id: 'gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'Optimized for professional work and long-running agents.',
    supportsEffort: true,
  },
];
const CODEX_PLAN_MODE_INSTRUCTION = [
  'You are in plan mode.',
  'Analyze the request and repository, then respond with a concrete implementation plan.',
  'Do not modify files, apply patches, run write commands, install dependencies, commit changes, or perform destructive actions.',
  'You may inspect files and run read-only commands when needed.',
  'End with a clear list of proposed changes and verification steps.',
].join('\n');

interface CodexAppServerModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportedReasoningEfforts?: unknown;
  additionalSpeedTiers?: unknown;
  serviceTiers?: unknown;
  isDefault?: unknown;
}

interface CodexModelListResult {
  data?: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

@Injectable()
export class CodexRuntimeService extends EventEmitter {
  private readonly logger = new Logger('CodexRuntimeService');
  private readonly activeRuns = new Map<number, CodexActiveRunState>();
  private readonly runtimeStates = new Map<number, CodexRuntimeState>();
  private readonly invalidatedSessions = new Set<number>();
  private codexModels: ClaudeModelOption[] = [...CODEX_MODELS];
  private codexDefaultModel = DEFAULT_CODEX_MODEL;
  private lastModelRefreshAt = 0;
  private modelRefreshInFlight: Promise<void> | null = null;
  // Cache the dynamic SDK import so the first prompt doesn't pay the cold-import cost.
  // Started eagerly in the constructor; awaited (or already resolved) when submitPrompt runs.
  private sdkModulePromise: Promise<CodexSdkModule> | null = null;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: CodexAuthService,
    private readonly historyService: CodexHistoryService,
  ) {
    super();
    // Warm the SDK import in the background — saves ~50-200ms on first prompt.
    this.sdkModulePromise = importCodexSdk('@openai/codex-sdk').catch((error) => {
      this.logger.debug(`Eager codex-sdk import failed: ${String(error)}`);
      // Reset so submitPrompt can retry the import lazily on first use.
      this.sdkModulePromise = null;
      throw error;
    });
  }

  private loadCodexSdk(): Promise<CodexSdkModule> {
    if (!this.sdkModulePromise) {
      this.sdkModulePromise = importCodexSdk('@openai/codex-sdk');
    }
    return this.sdkModulePromise;
  }

  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    const codexSessionId = session.codexSessionId ?? null;
    const state = this.ensureRuntimeState(sessionId, codexSessionId);
    if (!codexSessionId || codexSessionId === '-1') {
      return [];
    }
    const history = await this.historyService.getHistory(codexSessionId);
    state.liveItems = [];
    return history;
  }

  async getRuntimeState(sessionId: number): Promise<CodexRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.codexSessionId);
    await this.refreshAuthStatus(state);
    this.refreshModelCatalogInBackground();
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSnapshot(sessionId: number): Promise<CodexSessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);
    return { ...runtimeState, history };
  }

  async getAutocompleteItems() {
    return [];
  }

  async setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<CodexRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.codexSessionId);
    state.selectedModel = model;
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPermissionMode(
    sessionId: number,
    mode: CodexPermissionMode | null,
  ): Promise<CodexRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.codexSessionId);
    state.selectedPermissionMode = mode ?? 'default';
    if (state.sessionMetadata) {
      state.sessionMetadata = {
        ...state.sessionMetadata,
        permissionMode: state.selectedPermissionMode,
      };
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
    const validatedImages = this.validateImageInputs(images);
    if (!trimmedPrompt && !validatedImages.length) {
      return;
    }
    if (this.activeRuns.has(sessionId)) {
      const state = this.ensureRuntimeState(sessionId);
      state.pendingPrompts = [
        ...state.pendingPrompts,
        {
          id: randomUUID(),
          prompt: trimmedPrompt,
          queuedAt: new Date().toISOString(),
          ...(validatedImages.length ? { images: validatedImages } : {}),
        },
      ];
      this.emitRunState(sessionId);
      return;
    }

    // Skip the SQLite round-trip when we already have the session details
    // cached from a prior turn — the worktree path doesn't change across
    // turns and the codex session id is mirrored on the runtime state.
    let cachedState = this.runtimeStates.get(sessionId);
    let worktreePath = cachedState?.cachedWorktreePath ?? null;
    if (!worktreePath) {
      const session = await this.sessionsService.findOne(sessionId);
      worktreePath = session.worktreePath;
      cachedState = this.ensureRuntimeState(sessionId, session.codexSessionId);
      cachedState.cachedWorktreePath = worktreePath;
    }
    const state = cachedState ?? this.ensureRuntimeState(sessionId);
    state.runPhase = 'running';
    state.sessionState = 'running';
    state.canInterrupt = true;
    state.lastError = null;
    state.liveItems = [];
    // Both the DB status write and the auth refresh are not on the critical
    // path for streaming the first token — fire them off in the background.
    // The auth refresh spawns `codex --version` (process spawn ~100-500ms),
    // which is the single biggest contributor to per-prompt latency.
    void this.sessionsService
      .updateStatus(sessionId, 'active')
      .catch((error) =>
        this.logger.warn(`Failed to mark session ${sessionId} active: ${String(error)}`),
      );
    void this.refreshAuthStatus(state).catch(() => undefined);
    this.emitRunState(sessionId);

    const abortController = new AbortController();
    let resolveCompletion = () => {};
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeRuns.set(sessionId, {
      threadId: state.codexSessionId,
      abortController,
      interruptRequested: false,
      completionPromise,
      resolveCompletion,
      startedAtMs: Date.now(),
    });

    let stagedImageDir: string | null = null;
    try {
      const { Codex } = await this.loadCodexSdk();
      const codex = new Codex({
        env: this.toStringEnv(buildAugmentedEnv(process.env, worktreePath)),
      });
      const permissionOptions = this.mapPermissionMode(state.selectedPermissionMode);
      const threadOptions = {
        workingDirectory: worktreePath,
        skipGitRepoCheck: true,
        model: state.selectedModel ?? this.codexDefaultModel,
        sandboxMode: permissionOptions.sandboxMode,
        approvalPolicy: permissionOptions.approvalPolicy,
      };
      const thread =
        state.codexSessionId && state.codexSessionId !== '-1'
          ? codex.resumeThread(state.codexSessionId, threadOptions)
          : codex.startThread(threadOptions);
      const input = trimmedPrompt && !validatedImages.length
        ? trimmedPrompt
        : await this.buildCodexInput(trimmedPrompt, validatedImages).then((result) => {
            stagedImageDir = result.tempDir;
            return result.input;
          });
      const streamedTurn = await thread.runStreamed(
        this.applyPlanModeInstruction(input, state.selectedPermissionMode),
        {
          signal: abortController.signal,
        },
      );

      for await (const event of streamedTurn.events) {
        if (this.invalidatedSessions.has(sessionId)) {
          break;
        }
        const run = this.activeRuns.get(sessionId);
        if (run?.interruptRequested) {
          break;
        }
        // Synchronous event handler — no awaits on the hot path. The one
        // historically-async branch (persisting the codex session id) is now
        // fire-and-forget so it can't stall delta delivery.
        this.handleCodexEvent(sessionId, state, event, worktreePath);
      }
      this.finishRun(sessionId);
    } catch (error) {
      const run = this.activeRuns.get(sessionId);
      if (run?.interruptRequested || abortController.signal.aborted) {
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
      this.logger.error(`Codex run failed session=${sessionId}: ${message}`);
    } finally {
      const run = this.activeRuns.get(sessionId);
      this.activeRuns.delete(sessionId);
      run?.resolveCompletion();
      if (stagedImageDir) {
        void rm(stagedImageDir, { recursive: true, force: true });
      }
      if (!state.lastError && state.pendingPrompts.length > 0) {
        const [next, ...rest] = state.pendingPrompts;
        state.pendingPrompts = rest;
        this.emitRunState(sessionId);
        setImmediate(() => {
          this.submitPrompt(sessionId, next.prompt, next.images).catch((error) => {
            this.logger.error(
              `Pending Codex prompt failed session=${sessionId}: ${String(error)}`,
            );
          });
        });
      }
    }
  }

  async interrupt(sessionId: number): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }
    run.interruptRequested = true;
    run.abortController.abort();
    await run.completionPromise.catch(() => undefined);
    if (this.activeRuns.get(sessionId) === run) {
      this.activeRuns.delete(sessionId);
      this.finalizeInterruptedRun(sessionId);
    }
  }

  async cancelPendingPrompt(sessionId: number, id: string): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    state.pendingPrompts = state.pendingPrompts.filter((prompt) => prompt.id !== id);
    this.emitRunState(sessionId);
  }

  async cleanupSession(sessionId: number): Promise<void> {
    this.invalidatedSessions.add(sessionId);
    await this.interrupt(sessionId);
    this.activeRuns.delete(sessionId);
    this.runtimeStates.delete(sessionId);
  }

  private handleCodexEvent(
    sessionId: number,
    state: CodexRuntimeState,
    event: ThreadEvent,
    cwd: string,
  ): void {
    if (event.type === 'thread.started') {
      // captureCodexSessionId persists the id to the DB; we don't want to
      // hold up event streaming for it, so fire-and-forget.
      void this.captureCodexSessionId(sessionId, state, event.thread_id);
      this.emitSessionMetadata(sessionId, state, cwd);
      return;
    }
    if (event.type === 'item.started' || event.type === 'item.updated') {
      this.handleItemEvent(sessionId, event.item, event.type === 'item.updated');
      return;
    }
    if (event.type === 'item.completed') {
      this.handleItemEvent(sessionId, event.item, true);
      return;
    }
    if (event.type === 'turn.completed') {
      state.contextUsage = this.toContextUsage(
        state.selectedModel ?? this.codexDefaultModel,
        event.usage,
      );
      this.emitRunState(sessionId);
      return;
    }
    if (event.type === 'turn.failed') {
      const message = event.error.message || 'Codex turn failed';
      state.lastError = message;
      this.emitEvent({ type: 'error', payload: { sessionId, message } });
      return;
    }
    if (event.type === 'error') {
      state.lastError = event.message;
      this.emitEvent({
        type: 'error',
        payload: { sessionId, message: event.message },
      });
    }
  }

  private handleItemEvent(
    sessionId: number,
    item: ThreadItem,
    terminal: boolean,
  ): void {
    const timestamp = new Date().toISOString();
    if (item.type === 'agent_message' && item.text.trim()) {
      this.upsertLiveItem(
        sessionId,
        {
          id: item.id,
          kind: 'assistant',
          content: item.text,
          sourceMessageId: item.id,
          timestamp,
          receivedAt: timestamp,
        },
        'message_start',
        terminal,
      );
      return;
    }
    if (item.type === 'reasoning' && item.text.trim()) {
      this.upsertLiveItem(
        sessionId,
        {
          id: item.id,
          kind: 'thinking',
          content: item.text,
          sourceMessageId: item.id,
          timestamp,
          receivedAt: timestamp,
        },
        'thinking_start',
        terminal,
      );
      return;
    }
    if (item.type === 'error') {
      this.pushItem(sessionId, {
        id: item.id,
        kind: 'error',
        content: item.message,
        timestamp,
      });
      return;
    }
    const toolItem = this.toToolUseItem(item, timestamp);
    if (toolItem) {
      this.upsertLiveItem(sessionId, toolItem, 'tool_use', terminal);
      const result = this.toToolResultItem(item, timestamp);
      if (
        result
        && (
          terminal
          || (item.type === 'command_execution' && Boolean(item.aggregated_output))
        )
      ) {
        this.pushItem(sessionId, result, 'tool_result');
      }
    }
  }

  private toToolUseItem(
    item: ThreadItem,
    timestamp: string,
  ): ClaudeTranscriptItem | null {
    if (item.type === 'command_execution') {
      return {
        id: `${item.id}:tool_use`,
        kind: 'tool_use',
        toolUseId: item.id,
        toolName: 'Bash',
        toolInput: { command: item.command },
        sourceMessageId: item.id,
        timestamp,
        receivedAt: timestamp,
      };
    }
    if (item.type === 'file_change') {
      return {
        id: `${item.id}:tool_use`,
        kind: 'tool_use',
        toolUseId: item.id,
        toolName: 'FileChanges',
        toolInput: { changes: item.changes },
        sourceMessageId: item.id,
        timestamp,
        receivedAt: timestamp,
      };
    }
    if (item.type === 'mcp_tool_call') {
      return {
        id: `${item.id}:tool_use`,
        kind: 'tool_use',
        toolUseId: item.id,
        toolName: item.tool,
        toolInput: {
          server: item.server,
          arguments: item.arguments,
        },
        sourceMessageId: item.id,
        timestamp,
        receivedAt: timestamp,
      };
    }
    if (item.type === 'web_search') {
      return {
        id: `${item.id}:tool_use`,
        kind: 'tool_use',
        toolUseId: item.id,
        toolName: 'WebSearch',
        toolInput: { query: item.query },
        sourceMessageId: item.id,
        timestamp,
        receivedAt: timestamp,
      };
    }
    if (item.type === 'todo_list') {
      return {
        id: `${item.id}:tool_use`,
        kind: 'tool_use',
        toolUseId: item.id,
        toolName: 'TodoWrite',
        toolInput: {
          todos: item.items.map((todo) => ({
            content: todo.text,
            status: todo.completed ? 'completed' : 'pending',
          })),
        },
        sourceMessageId: item.id,
        timestamp,
        receivedAt: timestamp,
      };
    }
    return null;
  }

  private toToolResultItem(
    item: ThreadItem,
    timestamp: string,
  ): ClaudeTranscriptItem | null {
    if (item.type === 'command_execution') {
      return {
        id: `${item.id}:tool_result`,
        kind: 'tool_result',
        toolUseId: item.id,
        content: item.aggregated_output,
        isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
        timestamp,
        authoredAt: timestamp,
      };
    }
    if (item.type === 'file_change') {
      return {
        id: `${item.id}:tool_result`,
        kind: 'tool_result',
        toolUseId: item.id,
        content: item.changes
          .map((change) => `${change.kind}: ${change.path}`)
          .join('\n'),
        isError: item.status === 'failed',
        timestamp,
        authoredAt: timestamp,
      };
    }
    if (item.type === 'mcp_tool_call') {
      return {
        id: `${item.id}:tool_result`,
        kind: 'tool_result',
        toolUseId: item.id,
        content: item.error?.message ?? JSON.stringify(item.result ?? {}),
        isError: item.status === 'failed',
        timestamp,
        authoredAt: timestamp,
      };
    }
    return null;
  }

  private async captureCodexSessionId(
    sessionId: number,
    state: CodexRuntimeState,
    codexSessionId: string,
  ): Promise<void> {
    if (!codexSessionId || state.codexSessionId === codexSessionId) {
      return;
    }
    state.codexSessionId = codexSessionId;
    // Emit the session-created event immediately so the frontend can render
    // the thread id without waiting on the DB round-trip.
    this.emitEvent({
      type: 'session_created',
      payload: { sessionId, claudeSessionId: codexSessionId },
    });
    await this.sessionsService.updateCodexSessionId(sessionId, codexSessionId);
  }

  private emitSessionMetadata(
    sessionId: number,
    state: CodexRuntimeState,
    cwd: string,
  ): void {
    const authStatus = state.authStatus;
    const metadata: CodexRuntimeSessionMetadata = {
      cwd,
      model: state.selectedModel ?? this.codexDefaultModel,
      permissionMode: state.selectedPermissionMode ?? 'default',
      codexVersion: authStatus?.version ?? 'unknown',
      authMethod: authStatus?.authMethod ?? 'unknown',
      tools: ['Bash', 'FileChanges', 'WebSearch', 'TodoWrite', 'MCP'],
      slashCommands: [],
      skills: [],
      agents: [],
      fastModeState: null,
      mcpServers: [],
      plugins: [],
    };
    state.sessionMetadata = metadata;
    this.emitEvent({
      type: 'session_metadata',
      payload: { sessionId, metadata: metadata as never },
    });
    this.emitRunState(sessionId);
  }

  private finishRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = state.lastError ? 'error' : 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.liveItems = [];
    this.emitRunState(sessionId);
    this.emitEvent({ type: 'complete', payload: { sessionId } });
  }

  private finalizeInterruptedRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.lastError = null;
    state.liveItems = [];
    this.emitRunState(sessionId);
    this.emitEvent({ type: 'complete', payload: { sessionId } });
  }

  private ensureRuntimeState(
    sessionId: number,
    codexSessionId?: string | null,
  ): CodexRuntimeState {
    const existing = this.runtimeStates.get(sessionId);
    if (existing) {
      if (codexSessionId && codexSessionId !== '-1') {
        existing.codexSessionId = codexSessionId;
      }
      return existing;
    }
    const state: CodexRuntimeState = {
      codexSessionId:
        codexSessionId && codexSessionId !== '-1' ? codexSessionId : null,
      cachedWorktreePath: null,
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPrompts: [],
      liveItems: [],
      lastError: null,
      selectedModel: this.codexDefaultModel,
      selectedPermissionMode: 'default',
      availableModels: [...this.codexModels],
      contextUsage: null,
      sessionMetadata: null,
      authStatus: null,
    };
    this.runtimeStates.set(sessionId, state);
    return state;
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
        permissionMode: state.selectedPermissionMode,
        availableModels: state.availableModels,
        contextUsage: state.contextUsage,
        pendingPermissionRequest: null,
        pendingUserInputRequest: null,
        pendingPrompts: state.pendingPrompts,
      },
    });
  }

  private emitEvent(event: CodexRuntimeEvent): void {
    this.emit('event', event);
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
    this.emitEvent({ type: eventType, payload: { sessionId, item } } as CodexRuntimeEvent);
  }

  private upsertLiveItem(
    sessionId: number,
    item: ClaudeTranscriptItem,
    eventType: 'message_start' | 'thinking_start' | 'tool_use',
    terminal: boolean,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const existing = state.liveItems.find((live) => live.id === item.id);
    if (!existing) {
      this.pushItem(sessionId, item, eventType);
      return;
    }
    state.liveItems = state.liveItems.map((live) =>
      live.id === item.id ? { ...live, ...item } : live,
    );
    if ((eventType === 'message_start' || eventType === 'thinking_start') && item.content) {
      const previousContent = existing.content ?? '';
      const delta = item.content.startsWith(previousContent)
        ? item.content.slice(previousContent.length)
        : item.content;
      if (delta) {
        this.emitEvent({
          type: eventType === 'message_start' ? 'message_delta' : 'thinking_delta',
          payload: { sessionId, itemId: item.id, delta },
        } as CodexRuntimeEvent);
      }
    }
    if (terminal && eventType !== 'tool_use') {
      this.emitEvent({
        type: eventType === 'message_start' ? 'message_complete' : 'thinking_complete',
        payload: { sessionId, itemId: item.id },
      } as CodexRuntimeEvent);
    }
  }

  private async refreshAuthStatus(state: CodexRuntimeState): Promise<void> {
    state.authStatus = await this.authService.getStatus();
  }

  private refreshModelCatalogInBackground(): void {
    const ageMs = Date.now() - this.lastModelRefreshAt;
    if (ageMs < CODEX_MODEL_REFRESH_TTL_MS || this.modelRefreshInFlight) {
      return;
    }
    this.modelRefreshInFlight = this.refreshModelCatalog()
      .catch((error) => {
        this.logger.debug(
          `Codex model catalog refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.lastModelRefreshAt = Date.now();
        this.modelRefreshInFlight = null;
      });
  }

  private async refreshModelCatalog(): Promise<void> {
    const models = await this.fetchCodexAppServerModels();
    if (!models.length) {
      return;
    }
    const previousDefault = this.codexDefaultModel;
    this.codexModels = models.map((model) => this.toModelOption(model));
    this.codexDefaultModel =
      this.codexModels.find((model) =>
        models.some((source) => source.isDefault === true && this.modelId(source) === model.id),
      )?.id
      ?? this.codexModels[0]?.id
      ?? DEFAULT_CODEX_MODEL;

    for (const [sessionId, state] of this.runtimeStates.entries()) {
      state.availableModels = [...this.codexModels];
      if (!state.selectedModel || state.selectedModel === previousDefault) {
        state.selectedModel = this.codexDefaultModel;
      } else if (!state.availableModels.some((model) => model.id === state.selectedModel)) {
        state.availableModels = [
          ...state.availableModels,
          {
            id: state.selectedModel,
            displayName: state.selectedModel,
            description: 'Custom Codex model.',
            supportsEffort: true,
          },
        ];
      }
      this.emitRunState(sessionId);
    }
  }

  private fetchCodexAppServerModels(): Promise<CodexAppServerModel[]> {
    return new Promise((resolve, reject) => {
      const codexBin = findBinary('codex') ?? 'codex';
      const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
        env: buildAugmentedEnv(),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const timer = setTimeout(
        () => finish(new Error('Timed out while reading Codex model catalog.')),
        CODEX_MODEL_LIST_TIMEOUT_MS,
      );
      let settled = false;
      const finish = (error: Error | null, models: CodexAppServerModel[] = []) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl.close();
        child.removeAllListeners();
        try {
          child.kill();
        } catch {
          // Process may have already exited.
        }
        if (error) {
          reject(error);
        } else {
          resolve(models);
        }
      };
      rl.on('line', (line) => {
        const message = this.parseJsonRpcLine(line);
        if (!message) {
          return;
        }
        if (message.id === 1) {
          if (message.error) {
            finish(
              new Error(
                typeof message.error.message === 'string'
                  ? message.error.message
                  : 'Codex app-server initialization failed.',
              ),
            );
            return;
          }
          child.stdin.write(
            JSON.stringify({
              id: 2,
              method: 'model/list',
              params: {
                limit: 100,
                includeHidden: false,
              },
            })
            + '\n',
          );
          return;
        }
        if (message.id !== 2) {
          return;
        }
        if (message.error) {
          finish(
            new Error(
              typeof message.error.message === 'string'
                ? message.error.message
                : 'Codex model/list failed.',
            ),
          );
          return;
        }
        finish(null, this.extractModelList(message.result));
      });
      child.on('error', (error) => finish(error));
      child.on('exit', (code, signal) => {
        if (!settled) {
          const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
          finish(new Error(`Codex app-server exited with ${detail}.`));
        }
      });
      child.stdin.write(
        JSON.stringify({
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: {
              name: 'elevenex',
              title: 'Elevenex',
              version: '0',
            },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: ['configWarning'],
            },
          },
        })
        + '\n',
      );
    });
  }

  private parseJsonRpcLine(line: string): JsonRpcResponse | null {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as JsonRpcResponse) : null;
    } catch {
      return null;
    }
  }

  private extractModelList(result: unknown): CodexAppServerModel[] {
    const payload = result && typeof result === 'object'
      ? (result as CodexModelListResult)
      : null;
    if (!Array.isArray(payload?.data)) {
      return [];
    }
    return payload.data.filter(
      (model): model is CodexAppServerModel =>
        Boolean(this.modelId(model as CodexAppServerModel)),
    );
  }

  private toModelOption(model: CodexAppServerModel): ClaudeModelOption {
    const id = this.modelId(model);
    const displayName =
      typeof model.displayName === 'string' && model.displayName.trim()
        ? model.displayName.trim()
        : id;
    const description =
      typeof model.description === 'string' && model.description.trim()
        ? model.description.trim()
        : 'Codex model.';
    const supportsEffort =
      Array.isArray(model.supportedReasoningEfforts)
      && model.supportedReasoningEfforts.length > 0;
    const supportsFastMode =
      (Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.length > 0)
      || (Array.isArray(model.serviceTiers) && model.serviceTiers.length > 0);
    return {
      id,
      displayName,
      description,
      supportsEffort,
      ...(supportsFastMode ? { supportsFastMode: true } : {}),
    };
  }

  private modelId(model: CodexAppServerModel): string {
    const id = typeof model.id === 'string' && model.id.trim()
      ? model.id.trim()
      : typeof model.model === 'string' && model.model.trim()
        ? model.model.trim()
        : '';
    return id;
  }

  private toRuntimeStatePayload(
    sessionId: number,
    state: CodexRuntimeState,
  ): CodexRuntimeStatePayload {
    return {
      sessionId,
      claudeSessionId: state.codexSessionId,
      runPhase: state.runPhase,
      sessionState: state.sessionState,
      canInterrupt: state.canInterrupt,
      pendingPermissionRequest: null,
      pendingUserInputRequest: null,
      pendingPrompts: state.pendingPrompts,
      liveItems: state.liveItems,
      lastError: state.lastError,
      selectedModel: state.selectedModel,
      permissionMode: state.selectedPermissionMode,
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

  private mapPermissionMode(
    mode: CodexPermissionMode | null,
  ): { sandboxMode: SandboxMode; approvalPolicy: ApprovalMode } {
    if (mode === 'bypassPermissions') {
      return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
    }
    if (mode === 'acceptEdits') {
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
    }
    if (mode === 'plan') {
      return { sandboxMode: 'read-only', approvalPolicy: 'never' };
    }
    if (!mode || mode === 'default' || mode === 'auto') {
      return { sandboxMode: 'workspace-write', approvalPolicy: 'untrusted' };
    }
    throw new BadRequestException(`Unsupported Codex permission mode "${mode}".`);
  }

  private applyPlanModeInstruction(input: Input, mode: CodexPermissionMode | null): Input {
    if (mode !== 'plan') {
      return input;
    }
    if (typeof input === 'string') {
      return `${CODEX_PLAN_MODE_INSTRUCTION}\n\nUser request:\n${input}`;
    }
    return [
      { type: 'text', text: CODEX_PLAN_MODE_INSTRUCTION },
      ...input,
    ];
  }

  private toContextUsage(model: string, usage: Usage): ClaudeContextUsage {
    const inputTokens = usage.input_tokens + usage.cached_input_tokens;
    const outputTokens = usage.output_tokens + usage.reasoning_output_tokens;
    const totalTokens = inputTokens + outputTokens;
    const maxTokens = CODEX_MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CODEX_CONTEXT_WINDOW;
    return {
      model,
      totalTokens,
      maxTokens,
      percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 100)),
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: usage.cached_input_tokens,
      memoryFiles: [],
      mcpTools: [],
    };
  }

  private toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private validateImageInputs(images: AgentImageInput[] | undefined): AgentImageInput[] {
    if (!images?.length) {
      return [];
    }
    return images.filter((image) => {
      return (
        typeof image.data === 'string'
        && image.data.length > 0
        && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)
      );
    });
  }

  private async buildCodexInput(
    text: string,
    images: AgentImageInput[],
  ): Promise<{
    input: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>;
    tempDir: string | null;
  }> {
    const input: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [];
    if (text) {
      input.push({ type: 'text', text });
    }
    if (!images.length) {
      return { input, tempDir: null };
    }
    const tempDir = await mkdtemp(join(tmpdir(), 'elevenex-codex-images-'));
    for (const [index, image] of images.entries()) {
      const filePath = join(tempDir, `image-${index + 1}${this.imageExtension(image.mediaType)}`);
      await writeFile(filePath, Buffer.from(image.data, 'base64'));
      input.push({ type: 'local_image', path: filePath });
    }
    return { input, tempDir };
  }

  private imageExtension(mediaType: AgentImageInput['mediaType']): string {
    switch (mediaType) {
      case 'image/jpeg':
        return '.jpg';
      case 'image/gif':
        return '.gif';
      case 'image/webp':
        return '.webp';
      case 'image/png':
      default:
        return '.png';
    }
  }
}

type CodexSdkModule = typeof import('@openai/codex-sdk');

const importCodexSdk = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<CodexSdkModule>;
