import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Codex, type ApprovalMode, type SandboxMode, type ThreadEvent, type ThreadItem, type Usage } from '@openai/codex-sdk';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { SessionsService } from '../sessions/sessions.service.js';
import type {
  ClaudeContextUsage,
  ClaudeModelOption,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';
import { buildAugmentedEnv } from '../config/system-paths.js';
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

const DEFAULT_CODEX_MODEL = 'gpt-5.1-codex';
const CODEX_CONTEXT_WINDOW = 200_000;
const CODEX_MODELS: ClaudeModelOption[] = [
  {
    id: 'gpt-5.1-codex',
    displayName: 'GPT-5.1 Codex',
    description: 'Default Codex coding model.',
    supportsEffort: true,
  },
  {
    id: 'gpt-5-codex',
    displayName: 'GPT-5 Codex',
    description: 'Previous Codex coding model.',
    supportsEffort: true,
  },
];

@Injectable()
export class CodexRuntimeService extends EventEmitter {
  private readonly logger = new Logger('CodexRuntimeService');
  private readonly activeRuns = new Map<number, CodexActiveRunState>();
  private readonly runtimeStates = new Map<number, CodexRuntimeState>();
  private readonly invalidatedSessions = new Set<number>();

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: CodexAuthService,
    private readonly historyService: CodexHistoryService,
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

  async submitPrompt(sessionId: number, prompt: string): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }
    if (this.activeRuns.has(sessionId)) {
      const state = this.ensureRuntimeState(sessionId);
      state.pendingPrompts = [
        ...state.pendingPrompts,
        { id: randomUUID(), prompt: trimmedPrompt, queuedAt: new Date().toISOString() },
      ];
      this.emitRunState(sessionId);
      return;
    }

    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.codexSessionId);
    state.runPhase = 'running';
    state.sessionState = 'running';
    state.canInterrupt = true;
    state.lastError = null;
    state.liveItems = [];
    await this.sessionsService.updateStatus(sessionId, 'active');
    await this.refreshAuthStatus(state);
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

    try {
      const codex = new Codex({
        env: this.toStringEnv(buildAugmentedEnv(process.env, session.worktreePath)),
      });
      const permissionOptions = this.mapPermissionMode(state.selectedPermissionMode);
      const threadOptions = {
        workingDirectory: session.worktreePath,
        skipGitRepoCheck: true,
        model: state.selectedModel ?? DEFAULT_CODEX_MODEL,
        sandboxMode: permissionOptions.sandboxMode,
        approvalPolicy: permissionOptions.approvalPolicy,
      };
      const thread =
        state.codexSessionId && state.codexSessionId !== '-1'
          ? codex.resumeThread(state.codexSessionId, threadOptions)
          : codex.startThread(threadOptions);
      const streamedTurn = await thread.runStreamed(trimmedPrompt, {
        signal: abortController.signal,
      });

      for await (const event of streamedTurn.events) {
        if (this.invalidatedSessions.has(sessionId)) {
          break;
        }
        const run = this.activeRuns.get(sessionId);
        if (run?.interruptRequested) {
          break;
        }
        await this.handleCodexEvent(sessionId, state, event, session.worktreePath);
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
      if (!state.lastError && state.pendingPrompts.length > 0) {
        const [next, ...rest] = state.pendingPrompts;
        state.pendingPrompts = rest;
        this.emitRunState(sessionId);
        setImmediate(() => {
          this.submitPrompt(sessionId, next.prompt).catch((error) => {
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

  private async handleCodexEvent(
    sessionId: number,
    state: CodexRuntimeState,
    event: ThreadEvent,
    cwd: string,
  ): Promise<void> {
    if (event.type === 'thread.started') {
      await this.captureCodexSessionId(sessionId, state, event.thread_id);
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
        state.selectedModel ?? DEFAULT_CODEX_MODEL,
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
      if (result && terminal) {
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
    await this.sessionsService.updateCodexSessionId(sessionId, codexSessionId);
    this.emitEvent({
      type: 'session_created',
      payload: { sessionId, claudeSessionId: codexSessionId },
    });
  }

  private emitSessionMetadata(
    sessionId: number,
    state: CodexRuntimeState,
    cwd: string,
  ): void {
    const authStatus = state.authStatus;
    const metadata: CodexRuntimeSessionMetadata = {
      cwd,
      model: state.selectedModel ?? DEFAULT_CODEX_MODEL,
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
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPrompts: [],
      liveItems: [],
      lastError: null,
      selectedModel: DEFAULT_CODEX_MODEL,
      selectedPermissionMode: 'default',
      availableModels: [...CODEX_MODELS],
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
    state.liveItems = [...state.liveItems, item];
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
    if (!mode || mode === 'default' || mode === 'auto') {
      return { sandboxMode: 'workspace-write', approvalPolicy: 'untrusted' };
    }
    throw new BadRequestException(`Unsupported Codex permission mode "${mode}".`);
  }

  private toContextUsage(model: string, usage: Usage): ClaudeContextUsage {
    const inputTokens = usage.input_tokens + usage.cached_input_tokens;
    const outputTokens = usage.output_tokens + usage.reasoning_output_tokens;
    const totalTokens = inputTokens + outputTokens;
    return {
      model,
      totalTokens,
      maxTokens: CODEX_CONTEXT_WINDOW,
      percentage: Math.min(100, Math.round((totalTokens / CODEX_CONTEXT_WINDOW) * 100)),
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
}
