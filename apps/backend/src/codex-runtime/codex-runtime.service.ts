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
import {
  CodexAppServerClient,
  CodexAppServerNotification,
} from './codex-app-server.js';
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
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: CodexAuthService,
    private readonly historyService: CodexHistoryService,
    private readonly appServer: CodexAppServerClient,
  ) {
    super();
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
      turnId: null,
      abortController,
      interruptRequested: false,
      completionPromise,
      resolveCompletion,
      startedAtMs: Date.now(),
    });

    let stagedImageDir: string | null = null;
    try {
      const built = await this.buildCodexInput(trimmedPrompt, validatedImages);
      stagedImageDir = built.tempDir;
      const turnInput: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }> =
        built.input.map((entry) =>
          entry.type === 'text'
            ? { type: 'text' as const, text: entry.text }
            : { type: 'localImage' as const, path: entry.path },
        );
      const planInstruction = this.maybePlanModeInstruction(state.selectedPermissionMode);
      if (planInstruction) {
        turnInput.unshift({ type: 'text', text: planInstruction });
      }

      for await (const event of this.runTurnOnAppServer(
        sessionId,
        state,
        worktreePath,
        turnInput,
        abortController.signal,
      )) {
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
    // Tell the app-server to cancel the in-flight turn so it stops producing
    // model output; the abort signal also closes the local notification loop.
    if (run.threadId && run.turnId) {
      try {
        await this.appServer.request(
          'turn/interrupt',
          { threadId: run.threadId, turnId: run.turnId },
          5_000,
        );
      } catch (error) {
        this.logger.debug(
          `turn/interrupt failed for session ${sessionId}: ${String(error)}`,
        );
      }
    }
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

  /**
   * Drives a single turn against the long-lived `codex app-server`.
   *
   * Yields events shaped like the legacy `@openai/codex-sdk` ThreadEvent
   * stream so the existing handleCodexEvent() / handleItemEvent() logic and
   * its tests keep working unchanged. The mapping:
   *
   *   thread/started               → thread.started
   *   turn/started                 → turn.started
   *   turn/completed               → turn.completed (usage assembled from
   *                                  the most recent thread/tokenUsageUpdated)
   *   item/started + completed     → item.started + item.completed, with
   *                                  the v2 ThreadItem normalized to the v1
   *                                  snake_case shape
   *   item/agentMessage/delta      → item.updated (accumulated text so the
   *                                  diffing in upsertLiveItem keeps working)
   *
   * Lifecycle: addRef() so the server stays alive while at least one turn
   * is running, release() in finally.
   */
  private async *runTurnOnAppServer(
    sessionId: number,
    state: CodexRuntimeState,
    worktreePath: string,
    input: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }>,
    signal: AbortSignal,
  ): AsyncGenerator<ThreadEvent> {
    this.appServer.addRef();
    const queue: ThreadEvent[] = [];
    let waker: (() => void) | null = null;
    const wake = (): void => {
      if (waker) {
        const fn = waker;
        waker = null;
        fn();
      }
    };
    const push = (event: ThreadEvent): void => {
      queue.push(event);
      wake();
    };
    // Accumulated agent_message / reasoning text per item id so we can emit
    // SDK-style `item.updated` deltas from the app-server's delta notifications.
    const messageText = new Map<string, string>();
    const reasoningText = new Map<string, string>();
    let lastUsage: Usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    };
    let threadIdFilter: string | null =
      state.codexSessionId && state.codexSessionId !== '-1'
        ? state.codexSessionId
        : null;
    let endStream = false;

    const matchesThread = (params: any): boolean => {
      // Drop notifications until we positively know our thread id (set from
      // the thread/start or thread/resume response). With multiple sessions
      // sharing one app-server we otherwise risk cross-pollinating events
      // between concurrent thread starts.
      if (!threadIdFilter) return false;
      const id = params?.threadId ?? params?.thread?.id ?? null;
      if (!id) return false;
      return id === threadIdFilter;
    };

    const handle = (notification: CodexAppServerNotification): void => {
      const params = notification.params as any;
      switch (notification.method) {
        case 'thread/started': {
          if (!matchesThread(params)) return;
          push({
            type: 'thread.started',
            thread_id: params?.thread?.id ?? null,
          });
          return;
        }
        case 'turn/started': {
          if (!matchesThread(params)) return;
          const run = this.activeRuns.get(sessionId);
          if (run && params?.turnId) run.turnId = params.turnId as string;
          push({ type: 'turn.started' });
          return;
        }
        case 'thread/tokenUsageUpdated': {
          if (!matchesThread(params)) return;
          const last = params?.tokenUsage?.last;
          if (last) {
            lastUsage = {
              input_tokens: Number(last.inputTokens ?? 0),
              cached_input_tokens: Number(last.cachedInputTokens ?? 0),
              output_tokens: Number(last.outputTokens ?? 0),
              reasoning_output_tokens: Number(last.reasoningOutputTokens ?? 0),
            };
          }
          return;
        }
        case 'turn/completed': {
          if (!matchesThread(params)) return;
          push({ type: 'turn.completed', usage: lastUsage });
          endStream = true;
          wake();
          return;
        }
        case 'turn/failed': {
          if (!matchesThread(params)) return;
          push({
            type: 'turn.failed',
            error: { message: params?.error?.message ?? 'Codex turn failed' },
          });
          endStream = true;
          wake();
          return;
        }
        case 'item/started': {
          if (!matchesThread(params)) return;
          const item = this.translateAppServerItem(
            params?.item,
            messageText,
            reasoningText,
          );
          if (item) push({ type: 'item.started', item });
          return;
        }
        case 'item/completed': {
          if (!matchesThread(params)) return;
          const item = this.translateAppServerItem(
            params?.item,
            messageText,
            reasoningText,
            { isFinal: true },
          );
          if (item) push({ type: 'item.completed', item });
          return;
        }
        case 'item/agentMessage/delta': {
          if (!matchesThread(params)) return;
          const id = params?.itemId;
          const delta = params?.delta;
          if (typeof id !== 'string' || typeof delta !== 'string') return;
          const next = (messageText.get(id) ?? '') + delta;
          messageText.set(id, next);
          push({
            type: 'item.updated',
            item: {
              id,
              type: 'agent_message',
              text: next,
            } as ThreadItem,
          });
          return;
        }
        case 'error': {
          if (params?.threadId && !matchesThread(params)) return;
          push({
            type: 'error',
            message: params?.message ?? 'Codex error',
          });
          endStream = true;
          wake();
          return;
        }
        default:
          return;
      }
    };

    const unsubscribe = this.appServer.onNotification(handle);
    const onAbort = (): void => {
      endStream = true;
      wake();
    };
    signal.addEventListener('abort', onAbort);

    try {
      await this.appServer.ensureReady();
      const permissionOptions = this.mapPermissionMode(state.selectedPermissionMode);
      const sandboxMap: Record<SandboxMode, string> = {
        'read-only': 'read-only',
        'workspace-write': 'workspace-write',
        'danger-full-access': 'danger-full-access',
      };
      const approvalMap: Record<ApprovalMode, string> = {
        untrusted: 'untrusted',
        'on-failure': 'on-failure',
        'on-request': 'on-request',
        never: 'never',
      };

      // Load or create the thread before dispatching the turn. Calling
      // thread/resume on an already-loaded thread is idempotent — the server
      // will just confirm it stays subscribed and emit a fresh thread/started.
      const commonThreadParams = {
        cwd: worktreePath,
        model: state.selectedModel ?? this.codexDefaultModel,
        sandbox: sandboxMap[permissionOptions.sandboxMode],
        approvalPolicy: approvalMap[permissionOptions.approvalPolicy],
      };
      if (threadIdFilter) {
        await this.appServer.request('thread/resume', {
          threadId: threadIdFilter,
          excludeTurns: true,
          ...commonThreadParams,
        });
      } else {
        const response = (await this.appServer.request('thread/start', {
          ...commonThreadParams,
        })) as { thread?: { id?: string } };
        threadIdFilter = response?.thread?.id ?? null;
        if (threadIdFilter) {
          // Surface immediately so handleCodexEvent persists the codex session id.
          push({ type: 'thread.started', thread_id: threadIdFilter });
        } else {
          throw new Error('codex app-server thread/start did not return an id');
        }
      }

      // Now start the turn.
      await this.appServer.request('turn/start', {
        threadId: threadIdFilter,
        input,
      });

      while (!endStream || queue.length > 0) {
        if (signal.aborted) return;
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            waker = resolve;
          });
          continue;
        }
        const event = queue.shift()!;
        yield event;
        if (
          event.type === 'turn.completed'
          || event.type === 'turn.failed'
          || event.type === 'error'
        ) {
          // Drain anything that landed alongside the terminal event,
          // then return.
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          return;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      unsubscribe();
      this.appServer.release();
    }
  }

  /**
   * Maps the v2 ThreadItem (camelCase, app-server) shape into the v1
   * ThreadItem (snake_case, SDK) shape that handleItemEvent expects. Returns
   * `null` for items we don't render (userMessage, plan, hook prompt, etc.).
   */
  private translateAppServerItem(
    raw: any,
    messageText: Map<string, string>,
    reasoningText: Map<string, string>,
    opts: { isFinal?: boolean } = {},
  ): ThreadItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id : null;
    if (!id) return null;
    const status = normalizeStatus(raw.status);

    switch (raw.type) {
      case 'agentMessage': {
        const finalText = typeof raw.text === 'string' ? raw.text : '';
        // On `item/completed` we get the authoritative final text; on
        // `item/started` text is usually empty. The delta path keeps its
        // own running buffer so we can replay it for any out-of-order
        // updates.
        if (opts.isFinal || finalText) {
          messageText.set(id, finalText);
        }
        return {
          id,
          type: 'agent_message',
          text: opts.isFinal ? finalText : (messageText.get(id) ?? finalText),
        } as ThreadItem;
      }
      case 'reasoning': {
        const summary = Array.isArray(raw.summary) ? raw.summary.join('\n\n') : '';
        const content = Array.isArray(raw.content) ? raw.content.join('\n\n') : '';
        const text = [summary, content].filter(Boolean).join('\n\n');
        if (opts.isFinal || text) {
          reasoningText.set(id, text);
        }
        return {
          id,
          type: 'reasoning',
          text: opts.isFinal ? text : (reasoningText.get(id) ?? text),
        } as ThreadItem;
      }
      case 'commandExecution':
        return {
          id,
          type: 'command_execution',
          command: typeof raw.command === 'string' ? raw.command : '',
          aggregated_output:
            typeof raw.aggregatedOutput === 'string' ? raw.aggregatedOutput : '',
          ...(typeof raw.exitCode === 'number' ? { exit_code: raw.exitCode } : {}),
          status,
        } as ThreadItem;
      case 'fileChange':
        return {
          id,
          type: 'file_change',
          changes: Array.isArray(raw.changes) ? raw.changes : [],
          status: status === 'in_progress' ? 'completed' : (status as any),
        } as ThreadItem;
      case 'mcpToolCall':
        return {
          id,
          type: 'mcp_tool_call',
          server: typeof raw.server === 'string' ? raw.server : '',
          tool: typeof raw.tool === 'string' ? raw.tool : '',
          arguments: raw.arguments ?? {},
          ...(raw.result ? { result: raw.result } : {}),
          ...(raw.error ? { error: raw.error } : {}),
          status,
        } as ThreadItem;
      case 'webSearch':
        return {
          id,
          type: 'web_search',
          query: typeof raw.query === 'string' ? raw.query : '',
        } as ThreadItem;
      case 'todoList':
        return {
          id,
          type: 'todo_list',
          items: Array.isArray(raw.items) ? raw.items : [],
        } as ThreadItem;
      case 'error':
        return {
          id,
          type: 'error',
          message: typeof raw.message === 'string' ? raw.message : 'Codex error',
        } as ThreadItem;
      default:
        return null;
    }
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

  private maybePlanModeInstruction(mode: CodexPermissionMode | null): string | null {
    return mode === 'plan' ? CODEX_PLAN_MODE_INSTRUCTION : null;
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

function normalizeStatus(value: unknown): 'in_progress' | 'completed' | 'failed' {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  // App-server uses camelCase 'inProgress'; SDK uses 'in_progress'. Accept
  // both and any unknown value falls back to in_progress for safety.
  return 'in_progress';
}
