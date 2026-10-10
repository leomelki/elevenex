import type { OpenCodeClient } from './opencode-client.js';
import { OpenCodeTranscriptStore } from './opencode-transcript-store.js';
import { OpenCodeSessionTree } from './opencode-session-tree.js';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  Config,
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Model,
} from '@opencode-ai/sdk/v2/client';
import type {
  AgentRuntimeProvider,
  AgentRuntimeProviderInfo,
  AgentImageInput,
  AgentForkConversationRequest,
  AgentLoginMode,
} from '../agent-runtime/agent-runtime.types.js';
import type {
  ClaudeRuntimeStatePayload,
  ClaudeTranscriptItem,
  ClaudeMcpSnapshot,
} from '../claude-runtime/claude-runtime.types.js';
import {
  SessionsService,
  type AgentAutonomyMode,
} from '../sessions/sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import { McpAgentTokenService } from '../mcp/identity/mcp-agent-token.service.js';
import { buildMetaAgentPrompt } from '../elevenex-agent/meta-agent-prompt.js';
import { getElevenexProxyPort } from '../config/ports.js';
import { resolveAgentStartupSelection } from '../agent-runtime/agent-model-defaults.js';
import { contextPercentage } from '../agent-runtime/context-usage.js';
import { OpenCodeServer } from './opencode-server.js';
import { OpenCodeCatalogService } from './opencode-catalog.service.js';
import { loadOpenCodeModels } from './opencode-model-catalog.js';
import {
  openCodeModel,
  openCodePartItems,
  openCodePermission,
  openCodeQuestion,
  openCodePermissionRules,
} from './opencode-transcript.js';

interface RuntimeEntry {
  server: OpenCodeServer;
  client: OpenCodeClient | null;
  ready: Promise<RuntimeEntry>;
  controller: AbortController;
  state: ClaudeRuntimeStatePayload;
  transcript: OpenCodeTranscriptStore;
  tree: OpenCodeSessionTree;
  historyLoaded: boolean;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  run: Promise<void> | null;
  restoring: Promise<void> | null;
  idleTimer: NodeJS.Timeout | null;
  lastUsedAt: number;
  cwd: string;
  system?: string;
  models: Map<string, Model>;
  resources?: Awaited<ReturnType<NonNullable<OpenCodeClient['resources']>>>;
  agent?: string;
  interruptRequested: boolean;
}

/** Adapts OpenCode's native session API to the shared Elevenex conversation contract. */
@Injectable()
export class OpenCodeAgentRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleInit, OnModuleDestroy
{
  readonly info: AgentRuntimeProviderInfo = {
    id: 'opencode',
    displayName: 'OpenCode',
    capabilities: {
      mcp: true,
      subagents: true,
      permissions: true,
      userInput: true,
      multimodalPrompts: true,
      terminalFallback: false,
      rewindConversation: true,
    },
  };
  private readonly entries = new Map<number, RuntimeEntry>();
  private readonly starts = new Map<number, Promise<RuntimeEntry>>();
  private readonly states = new Map<number, ClaudeRuntimeStatePayload>();
  private readonly clients = new Map<number, number>();
  private readonly generations = new Map<number, number>();
  private readonly interruptions = new Map<number, number>();
  private readonly interrupts = new Map<number, Promise<void>>();
  private destroyed = false;
  private readonly selectionChanged = new Set<number>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly settings: SettingsService,
    private readonly hooks: ClaudeHooksService,
    private readonly titles: SessionTitleService,
    private readonly catalog: OpenCodeCatalogService,
    private readonly tokens: McpAgentTokenService,
  ) {
    super();
  }

  onModuleInit(): void {
    this.catalog.on('auth_status', (status) =>
      this.emit('auth_status', status),
    );
    this.catalog.on('credentials_changed', () => {
      for (const [id, entry] of this.entries) if (!entry.run) this.stop(id);
    });
  }
  onModuleDestroy(): void {
    this.destroyed = true;
    for (const id of this.entries.keys()) this.stop(id);
  }
  getModelCatalog() {
    return this.catalog.getModelCatalog();
  }
  getAuthStatus() {
    return this.catalog.getAuthStatus();
  }
  startLogin(options: {
    mode: AgentLoginMode;
    apiKey?: string;
    oauthProvider?: string;
    apiKeyProvider?: string;
  }) {
    return this.catalog.startLogin(options);
  }
  cancelLogin() {
    return this.catalog.cancelLogin();
  }
  continueLogin(options: { code: string }) {
    return this.catalog.continueLogin(options);
  }

  private async state(sessionId: number): Promise<ClaudeRuntimeStatePayload> {
    const session = await this.sessions.findOne(sessionId);
    let state = this.states.get(sessionId);
    if (!state) {
      const catalog = await this.catalog.getModelCatalog();
      const defaults = resolveAgentStartupSelection(
        this.settings.getAgentProviderDefaults('opencode'),
        catalog.models,
        catalog.providerDefaultModelId,
      );
      state = {
        sessionId,
        claudeSessionId:
          session.opencodeSessionId && session.opencodeSessionId !== '-1'
            ? session.opencodeSessionId
            : null,
        ...defaults,
        fastMode: false,
        runPhase: 'idle',
        sessionState: 'idle',
        canInterrupt: false,
        permissionMode:
          session.surface === 'agent'
            ? session.agentAutonomyMode === 'full'
              ? 'bypassPermissions'
              : 'default'
            : 'default',
        planMode:
          session.planMode ??
          (session.surface === 'agent' && session.agentAutonomyMode === 'plan'),
        pendingPermissionRequest: null,
        pendingUserInputRequest: null,
        pendingPrompts: [],
        queuePaused: false,
        liveItems: [],
        lastError: null,
        availableModels: catalog.models,
        contextUsage: null,
        sessionMetadata: null,
        runtimeStatus: null,
        authStatus: null,
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
        warmState: 'cold',
        lastWarmedAt: null,
        lastPromptTiming: null,
      };
      // A concurrent reader may have initialized this session while defaults were loaded.
      state = this.states.get(sessionId) ?? state;
      this.states.set(sessionId, state);
    }
    return state;
  }
  async getRuntimeState(sessionId: number) {
    const state = await this.state(sessionId);
    const [auth, catalog] = await Promise.all([
      this.catalog.getAuthStatus(),
      this.catalog.getModelCatalog(),
    ]);
    state.authStatus = auth;
    if (auth.installed) await this.ensure(sessionId).catch(() => undefined);
    const entry = this.entries.get(sessionId);
    if (!entry) state.availableModels = catalog.models;
    else if (entry.models.size) {
      const projectAuth = { ...auth, authenticated: true };
      state.authStatus = projectAuth;
    }
    return { ...state, liveItems: [...state.liveItems] };
  }
  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const state = await this.state(sessionId);
    if (!state.claudeSessionId) return [];
    const entry = await this.ensure(sessionId);
    if (!entry.historyLoaded) await this.restore(entry);
    return this.history(entry);
  }
  async getSnapshot(sessionId: number) {
    const history = await this.getHistory(sessionId);
    return { ...(await this.getRuntimeState(sessionId)), history };
  }
  private history(entry: RuntimeEntry): ClaudeTranscriptItem[] {
    return entry.transcript.history();
  }

  private ensure(sessionId: number): Promise<RuntimeEntry> {
    const pending = this.starts.get(sessionId);
    if (pending) return pending;
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.ready;
    }
    const generation = this.generations.get(sessionId) ?? 0;
    const starting = this.create(sessionId, generation).finally(() => {
      if (this.starts.get(sessionId) === starting)
        this.starts.delete(sessionId);
    });
    this.starts.set(sessionId, starting);
    return starting;
  }
  private async create(
    sessionId: number,
    generation: number,
  ): Promise<RuntimeEntry> {
    const [session, state] = await Promise.all([
      this.sessions.findOne(sessionId),
      this.state(sessionId),
    ]);
    let config: Config | undefined;
    let system: string | undefined;
    if (session.surface === 'agent') {
      const token = await this.tokens.ensureToken(sessionId);
      config = {
        mcp: {
          elevenex: {
            type: 'remote',
            url:
              process.env.ELEVENEX_MCP_URL?.trim() ||
              `http://127.0.0.1:${getElevenexProxyPort()}/api/mcp`,
            headers: { Authorization: `Bearer ${token}` },
            oauth: false,
          },
        },
      };
      system = buildMetaAgentPrompt(session.agentAutonomyMode);
    }
    if (this.destroyed || (this.generations.get(sessionId) ?? 0) !== generation)
      throw new Error('OpenCode session closed during startup.');
    const server = new OpenCodeServer({ cwd: session.worktreePath, config });
    const entry: RuntimeEntry = {
      server,
      client: null,
      ready: null!,
      controller: new AbortController(),
      state,
      transcript: new OpenCodeTranscriptStore(),
      tree: new OpenCodeSessionTree(),
      historyLoaded: false,
      permissions: [],
      questions: [],
      run: null,
      restoring: null,
      idleTimer: null,
      lastUsedAt: Date.now(),
      cwd: session.worktreePath,
      system,
      models: new Map(),
      interruptRequested: false,
    };
    this.entries.set(sessionId, entry);
    server.on('failure', (error: Error) => {
      if (this.entries.get(sessionId) === entry) {
        this.fail(entry, error);
        this.stop(sessionId);
      }
    });
    entry.ready = (async () => {
      entry.client = await server.start();
      if (entry.controller.signal.aborted)
        throw new Error('OpenCode session closed.');
      const [loaded, resources, commands, health] = await Promise.all([
        loadOpenCodeModels(entry.client),
        entry.client.resources?.(),
        entry.client.command.list(),
        entry.client.global.health(),
      ]);
      entry.models = loaded.models;
      entry.resources = resources;
      entry.agent = resources?.defaultAgent;
      state.availableModels = loaded.catalog.models;
      if (!state.claudeSessionId && !this.selectionChanged.has(sessionId))
        Object.assign(
          state,
          resolveAgentStartupSelection(
            this.settings.getAgentProviderDefaults('opencode'),
            loaded.catalog.models,
            loaded.catalog.providerDefaultModelId,
          ),
        );
      if (
        state.claudeSessionId &&
        entry.client.selection &&
        !this.selectionChanged.has(sessionId)
      ) {
        const selected = await entry.client.selection(state.claudeSessionId);
        state.selectedModel = selected.model;
        state.reasoningEffort = selected.variant;
        entry.agent = selected.agent ?? entry.agent;
      }
      state.sessionMetadata = {
        cwd: entry.cwd,
        model: state.selectedModel ?? '',
        permissionMode: state.permissionMode ?? 'default',
        claudeCodeVersion: health.data?.version ?? '',
        outputStyle: '',
        apiKeySource: 'OpenCode',
        tools: [],
        slashCommands: (commands.data ?? []).map((command) => command.name),
        skills: resources?.skills.map((skill) => skill.name) ?? [],
        agents: resources?.agents.map((agent) => agent.name) ?? [],
        fastModeState: null,
        mcpServers: [],
        plugins: [],
      };
      state.warmState = 'warm';
      state.lastWarmedAt = new Date().toISOString();
      // Establish the live-only subscription before fetching history or starting a turn.
      const stream = await this.subscribe(entry);
      void this.events(entry, stream);
      if (state.claudeSessionId) await this.restore(entry);
      this.scheduleIdle(sessionId);
      this.emitState(entry);
      return entry;
    })().catch((error) => {
      if (this.entries.get(sessionId) === entry) this.stop(sessionId);
      throw error;
    });
    return entry.ready;
  }

  private restore(entry: RuntimeEntry, recoverRuntime = true): Promise<void> {
    if (entry.restoring) return entry.restoring;
    if (!entry.state.claudeSessionId) return Promise.resolve();
    entry.restoring = (async () => {
      const sessionID = entry.state.claudeSessionId!;
      const before = entry.transcript.snapshot();
      const beforePermissions = entry.permissions;
      const beforeQuestions = entry.questions;
      const [messages, session, permissions, questions, statuses] =
        await Promise.all([
          entry.client!.session.messages({ sessionID }),
          entry.client!.session.get({ sessionID }),
          recoverRuntime ? entry.client!.permission.list() : undefined,
          recoverRuntime ? entry.client!.question.list() : undefined,
          recoverRuntime ? entry.client!.session.status() : undefined,
          recoverRuntime
            ? entry.tree.restore(
                sessionID,
                entry.client!,
                entry.controller.signal,
              )
            : undefined,
        ]);
      if (entry.controller.signal.aborted) return;
      entry.transcript.reconcile(
        messages.data ?? [],
        before,
        session.data?.revert?.messageID,
      );
      entry.historyLoaded = true;
      if (recoverRuntime) this.syncSubagents(entry, statuses?.data);
      const latestAssistant = entry.transcript
        .orderedMessages()
        .findLast((message) => message.role === 'assistant');
      if (latestAssistant?.role === 'assistant')
        this.updateContextUsage(entry, latestAssistant);
      if (
        !entry.client!.selection &&
        (entry.run || statuses?.data?.[sessionID]?.type === 'busy')
      ) {
        const latestUser = entry.transcript
          .orderedMessages()
          .findLast((message) => message.role === 'user');
        if (latestUser?.role === 'user')
          await this.syncNativeAgent(entry, latestUser.agent);
      }
      if (permissions && entry.permissions === beforePermissions)
        entry.permissions = (permissions.data ?? []).filter((request) =>
          this.owns(entry, request.sessionID),
        );
      if (questions && entry.questions === beforeQuestions)
        entry.questions = (questions.data ?? []).filter((request) =>
          this.owns(entry, request.sessionID),
        );
      if (!entry.run && statuses) {
        const active = statuses.data?.[sessionID]?.type;
        entry.state.canInterrupt = !!active && active !== 'idle';
        if (entry.state.runPhase !== 'error')
          entry.state.runPhase = entry.state.canInterrupt ? 'running' : 'idle';
      }
      // Publish recovered content to existing clients before their live state is refreshed.
      entry.state.liveItems = entry.transcript.refreshLiveItems(
        entry.state.liveItems,
      );
      this.emitHistory(entry);
      this.syncRequests(entry);
    })().finally(() => {
      entry.restoring = null;
    });
    return entry.restoring;
  }

  private owns(entry: RuntimeEntry, sessionID: string): boolean {
    return entry.tree.owns(entry.state.claudeSessionId, sessionID);
  }
  private async resolveOwnership(
    entry: RuntimeEntry,
    sessionID: string,
  ): Promise<boolean> {
    return entry.tree.resolve(
      entry.state.claudeSessionId,
      sessionID,
      entry.client!,
      entry.controller.signal,
    );
  }
  private syncSubagents(
    entry: RuntimeEntry,
    statuses?: Record<string, { type: string }>,
  ): void {
    const previous = new Map(
      entry.state.subagents.map((agent) => [agent.agentId, agent]),
    );
    entry.state.subagents = entry.state.claudeSessionId
      ? entry.tree.descendants(entry.state.claudeSessionId).map((child) => ({
          agentId: child.id,
          agentType: child.title,
          status: statuses
            ? statuses[child.id]?.type === 'busy'
              ? 'started'
              : 'stopped'
            : (previous.get(child.id)?.status ?? 'started'),
          timestamp: new Date(child.time.created).toISOString(),
        }))
      : [];
  }
  private emitHistory(entry: RuntimeEntry): void {
    this.emit('event', {
      type: 'history_snapshot',
      payload: {
        sessionId: entry.state.sessionId,
        history: this.history(entry),
      },
    });
  }
  private async syncNativeAgent(
    entry: RuntimeEntry,
    agent: string,
  ): Promise<void> {
    entry.agent = agent;
    const enabled = agent === 'plan';
    if (entry.state.planMode === enabled) return;
    entry.state.planMode = enabled;
    await this.sessions.updatePlanMode(entry.state.sessionId, enabled);
    if (!entry.controller.signal.aborted) this.emitState(entry);
  }

  private updateContextUsage(
    entry: RuntimeEntry,
    message: Message & { role: 'assistant' },
  ): void {
    const model = entry.models.get(`${message.providerID}/${message.modelID}`);
    const tokens = message.tokens;
    const totalTokens =
      tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
    entry.state.contextUsage = {
      model: `${message.providerID}/${message.modelID}`,
      totalTokens,
      maxTokens: model?.limit.context ?? 0,
      percentage:
        contextPercentage(totalTokens, model?.limit.context ?? 0) ?? 0,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadInputTokens: tokens.cache.read,
      cacheCreationInputTokens: tokens.cache.write,
      memoryFiles: [],
      mcpTools: [],
    };
  }
  private async subscribe(entry: RuntimeEntry): Promise<AsyncIterable<Event>> {
    const subscription = await entry.client!.event.subscribe(
      {},
      { signal: entry.controller.signal },
    );
    const iterator = subscription.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('OpenCode event stream could not connect.');
    if (first.value.type !== 'server.connected')
      await this.handleEvent(entry, first.value);
    return { [Symbol.asyncIterator]: () => iterator };
  }
  private async events(
    entry: RuntimeEntry,
    initial: AsyncIterable<Event>,
  ): Promise<void> {
    let stream: AsyncIterable<Event> | null = initial;
    let failures = 0;
    while (!entry.controller.signal.aborted) {
      try {
        if (!stream) {
          stream = await this.subscribe(entry);
          await this.restore(entry);
        }
        for await (const event of stream) {
          if (entry.controller.signal.aborted) return;
          if (event.type !== 'server.connected') failures = 0;
          await this.handleEvent(entry, event);
        }
        throw new Error('OpenCode event connection closed.');
      } catch (error) {
        if (entry.controller.signal.aborted) return;
        if (++failures > 3) {
          this.fail(entry, error);
          this.stop(entry.state.sessionId);
          return;
        }
        stream = null;
        await new Promise<void>((resolve) => {
          const signal = entry.controller.signal;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, 500 * 2 ** (failures - 1));
          signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  private async handleEvent(entry: RuntimeEntry, event: Event): Promise<void> {
    const state = entry.state;
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const session = event.properties.info;
        if (
          session.id === state.claudeSessionId &&
          'agent' in session &&
          typeof session.agent === 'string'
        ) {
          await this.syncNativeAgent(entry, session.agent);
        }
        if (session.parentID && this.owns(entry, session.parentID)) {
          entry.tree.track(session);
          this.syncSubagents(entry);
          this.emitState(entry);
        }

        break;
      }
      case 'message.updated': {
        const message = event.properties.info;
        if (message.sessionID !== state.claudeSessionId) break;
        entry.transcript.putMessage(message);
        // V1 changes primary agents through user messages, including native plan_exit.
        if (message.role === 'user' && !entry.client!.selection)
          await this.syncNativeAgent(entry, message.agent);
        if (message.role === 'assistant') {
          this.updateContextUsage(entry, message);
          this.emitState(entry);
        }
        break;
      }
      case 'message.part.updated': {
        const part = event.properties.part;
        if (part.sessionID !== state.claudeSessionId) break;
        entry.transcript.putPart(part);
        this.emitPart(entry, part);
        break;
      }
      case 'message.part.delta': {
        const { partID, sessionID, delta, field } = event.properties;
        if (sessionID !== state.claudeSessionId || field !== 'text') break;
        const part = entry.transcript.parts.get(partID);
        if (part?.type === 'text' || part?.type === 'reasoning') {
          if (!state.liveItems.some((item) => item.id === partID))
            this.emitPart(entry, part);
          entry.transcript.appendDelta(partID, delta);
          state.liveItems = state.liveItems.map((item) =>
            item.id === partID
              ? { ...item, content: (item.content ?? '') + delta }
              : item,
          );
          this.emit('event', {
            type:
              part.type === 'reasoning' ? 'thinking_delta' : 'message_delta',
            payload: { sessionId: state.sessionId, itemId: partID, delta },
          });
        } else {
          // A live-only connection can miss a part's start; recover its native baseline.
          void this.restore(entry).catch((error) => this.fail(entry, error));
        }

        break;
      }
      case 'permission.asked':
        if (await this.resolveOwnership(entry, event.properties.sessionID)) {
          this.syncSubagents(entry);
          entry.permissions = [
            ...entry.permissions.filter(
              (request) => request.id !== event.properties.id,
            ),
            event.properties,
          ];
          this.syncRequests(entry);
        }
        break;
      case 'permission.replied':
        if (
          !entry.permissions.some(
            (request) => request.id === event.properties.requestID,
          )
        )
          break;
        entry.permissions = entry.permissions.filter(
          (request) => request.id !== event.properties.requestID,
        );
        this.syncRequests(entry);
        break;
      case 'question.asked':
        if (await this.resolveOwnership(entry, event.properties.sessionID)) {
          this.syncSubagents(entry);
          entry.questions = [
            ...entry.questions.filter(
              (request) => request.id !== event.properties.id,
            ),
            event.properties,
          ];
          this.syncRequests(entry);
        }
        break;
      case 'question.replied':
      case 'question.rejected':
        if (
          !entry.questions.some(
            (request) => request.id === event.properties.requestID,
          )
        )
          break;
        entry.questions = entry.questions.filter(
          (request) => request.id !== event.properties.requestID,
        );
        this.syncRequests(entry);
        break;
      case 'session.status': {
        const { sessionID, status } = event.properties;
        if (sessionID !== state.claudeSessionId) {
          const agent = state.subagents.find(
            (item) => item.agentId === sessionID,
          );
          if (agent) {
            agent.status = status.type === 'idle' ? 'stopped' : 'started';
            this.emitState(entry);
          }
          break;
        }
        if (status.type === 'retry') {
          state.latestApiRetry = {
            attempt: status.attempt,
            maxRetries: 0,
            retryDelayMs: Math.max(0, status.next - Date.now()),
            errorStatus: null,
            error: status.message,
            timestamp: new Date().toISOString(),
          };
        }
        if (!entry.run) {
          state.canInterrupt = status.type !== 'idle';
          if (state.runPhase !== 'error')
            state.runPhase = state.canInterrupt ? 'running' : 'idle';
        }
        this.emitState(entry);
        if (status.type === 'idle' && !entry.run && !state.queuePaused)
          void this.drain(state.sessionId).catch((error) =>
            this.fail(entry, error),
          );
        break;
      }
      case 'session.error':
        if (
          event.properties.sessionID === state.claudeSessionId &&
          event.properties.error?.name !== 'MessageAbortedError'
        )
          this.fail(entry, new Error(JSON.stringify(event.properties.error)));
        break;
      case 'session.compacted':
        if (event.properties.sessionID === state.claudeSessionId) {
          state.runtimeStatus = { status: null, compactResult: 'success' };
          this.emitState(entry);
        }
        break;
      case 'server.connected':
        if (state.claudeSessionId)
          void this.restore(entry).catch((error) => this.fail(entry, error));
        break;
      default:
        break;
    }
  }
  private emitPart(entry: RuntimeEntry, part: Part): void {
    for (const item of entry.transcript.partItems(part)) {
      const index = entry.state.liveItems.findIndex(
        (existing) => existing.id === item.id,
      );
      entry.state.liveItems =
        index < 0
          ? [...entry.state.liveItems, item]
          : entry.state.liveItems.map((existing, position) =>
              position === index ? item : existing,
            );
      this.emit('event', {
        type:
          item.kind === 'tool_use'
            ? 'tool_use'
            : item.kind === 'tool_result'
              ? 'tool_result'
              : item.kind === 'thinking'
                ? 'thinking_start'
                : 'message_start',
        payload: { sessionId: entry.state.sessionId, item },
      });
    }
  }
  private syncRequests(entry: RuntimeEntry): void {
    entry.state.pendingPermissionRequest = entry.permissions[0]
      ? openCodePermission(entry.permissions[0])
      : null;
    entry.state.pendingUserInputRequest = entry.questions[0]
      ? openCodeQuestion(entry.questions[0])
      : null;
    if (
      (entry.run || entry.state.canInterrupt) &&
      entry.state.runPhase !== 'error'
    )
      entry.state.runPhase =
        entry.permissions.length || entry.questions.length
          ? 'waiting'
          : 'running';
    this.emitState(entry);
  }
  private emitState(entry: RuntimeEntry): void {
    const state = entry.state;
    state.sessionState =
      state.runPhase === 'waiting'
        ? 'requires_action'
        : state.runPhase === 'running'
          ? 'running'
          : 'idle';
    this.hooks.updateRuntimeActivity(state.sessionId, {
      activityStatus: state.runPhase === 'error' ? 'idle' : state.runPhase,
      actionKind: state.pendingPermissionRequest
        ? 'permission'
        : state.pendingUserInputRequest
          ? 'user_input'
          : null,
      actionLabel: state.pendingPermissionRequest
        ? 'Approval needed'
        : state.pendingUserInputRequest
          ? 'Input needed'
          : null,
      backgroundActive: false,
    });
    this.emit('event', {
      type: 'runtime_snapshot',
      payload: { ...state, liveItems: [...state.liveItems] },
    });
  }
  private fail(entry: RuntimeEntry, error: unknown): void {
    entry.state.lastError =
      error instanceof Error ? error.message : String(error);
    entry.state.runPhase = 'error';
    entry.state.canInterrupt = false;
    entry.state.queuePaused = entry.state.pendingPrompts.length > 0;
    this.emit('event', {
      type: 'error',
      payload: {
        sessionId: entry.state.sessionId,
        message: entry.state.lastError,
      },
    });
    this.emitState(entry);
  }

  async submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ): Promise<void> {
    if (!prompt.trim() && !images?.length)
      throw new BadRequestException('Prompt must not be empty.');
    const state = await this.state(sessionId);
    if (
      state.canInterrupt ||
      state.queuePaused ||
      this.interrupts.has(sessionId) ||
      this.entries.get(sessionId)?.run
    ) {
      state.pendingPrompts = [
        ...state.pendingPrompts,
        {
          id: randomUUID(),
          prompt,
          queuedAt: new Date().toISOString(),
          ...(images?.length ? { images } : {}),
        },
      ];
      if (
        this.interrupts.has(sessionId) ||
        this.entries.get(sessionId)?.interruptRequested ||
        state.runPhase === 'error'
      )
        state.queuePaused = true;
      this.emit('event', { type: 'run_state', payload: state });
      return;
    }
    state.canInterrupt = true;
    state.runPhase = 'running';
    state.lastError = null;
    const interruption = this.interruptions.get(sessionId) ?? 0;
    let entry: RuntimeEntry;
    try {
      entry = await this.ensure(sessionId);
    } catch (error) {
      state.canInterrupt = false;
      state.runPhase = 'error';
      state.lastError = String(error);
      this.emit('event', { type: 'run_state', payload: state });
      throw error;
    }
    if (
      entry.controller.signal.aborted ||
      state.queuePaused ||
      (this.interruptions.get(sessionId) ?? 0) !== interruption
    ) {
      state.canInterrupt = false;
      state.runPhase = 'idle';
      return;
    }
    entry.interruptRequested = false;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.state.liveItems = [];
    this.emitState(entry);
    entry.run = this.run(entry, prompt, titlePrompt, images).finally(() => {
      entry.run = null;
      if (entry.controller.signal.aborted) return;
      state.canInterrupt = false;
      if (state.runPhase !== 'error') state.runPhase = 'idle';
      entry.permissions = [];
      entry.questions = [];
      state.pendingPermissionRequest = null;
      state.pendingUserInputRequest = null;
      this.emitState(entry);
      this.scheduleIdle(sessionId);
      if (!state.queuePaused)
        void this.drain(sessionId).catch((error) => this.fail(entry, error));
    });
    void entry.run.catch((error) => {
      if (!entry.controller.signal.aborted) this.fail(entry, error);
    });
  }
  private async run(
    entry: RuntimeEntry,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ): Promise<void> {
    const state = entry.state;
    const client = entry.client!;
    try {
      if (!state.claudeSessionId) {
        const session = (
          await client.session.create({
            permission: openCodePermissionRules(state.permissionMode),
          })
        ).data!;
        state.claudeSessionId = session.id;
        await this.sessions.updateOpenCodeSessionId(
          state.sessionId,
          session.id,
        );
        this.emit('event', {
          type: 'session_created',
          payload: { sessionId: state.sessionId, claudeSessionId: session.id },
        });
        void this.generateTitle(entry, titlePrompt ?? prompt);
      }
      if (entry.interruptRequested || entry.controller.signal.aborted) return;
      const model = openCodeModel(state.selectedModel);
      if (
        images?.length &&
        state.selectedModel &&
        entry.models.get(state.selectedModel)?.capabilities.input.image ===
          false
      )
        throw new BadRequestException(
          'This OpenCode model does not support images. Choose a vision model.',
        );
      const parts = (images ?? []).map((image) => ({
        type: 'file' as const,
        mime: image.mediaType,
        url: `data:${image.mediaType};base64,${image.data}`,
      }));
      const command = prompt.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      const knownCommands = command
        ? ((await client.command.list()).data ?? [])
        : [];
      const common = {
        sessionID: state.claudeSessionId,
        agent: state.planMode
          ? 'plan'
          : entry.agent === 'plan'
            ? 'build'
            : entry.agent,
        variant: state.reasoningEffort ?? undefined,
      };
      if (entry.interruptRequested || entry.controller.signal.aborted) return;
      if (command?.[1] === 'agent') {
        const agent = entry.resources?.agents.find(
          (agent) =>
            agent.primary &&
            (agent.id === command[2]?.trim() ||
              agent.name === command[2]?.trim()),
        );
        if (!agent)
          throw new BadRequestException(
            'Choose an available primary OpenCode agent.',
          );
        entry.agent = agent.id;
        await client.selectAgent?.(state.claudeSessionId, agent.id);
        await this.setPlanMode(state.sessionId, agent.id === 'plan');
        return;
      }
      const skill =
        command &&
        entry.resources?.skills.find((skill) => skill.name === command[1]);
      const selection = { ...common, model, system: entry.system };
      const result =
        command?.[1] === 'compact' && client.compact
          ? (await client.compact(state.claudeSessionId, selection),
            { data: undefined })
          : skill && client.activateSkill
            ? (await client.activateSkill(
                state.claudeSessionId,
                skill.id,
                selection,
              ),
              { data: undefined })
            : command && knownCommands.some((item) => item.name === command[1])
              ? await client.session.command(
                  {
                    ...common,
                    command: command[1],
                    arguments: command[2] ?? '',
                    model: state.selectedModel ?? undefined,
                    parts,
                  },
                  { signal: entry.controller.signal },
                )
              : await client.session.prompt(
                  {
                    ...common,
                    model,
                    system: entry.system,
                    parts: [{ type: 'text', text: prompt }, ...parts],
                  },
                  { signal: entry.controller.signal },
                );
      if (entry.controller.signal.aborted) return;
      if (result.data) {
        entry.transcript.putMessage(result.data.info);
        for (const part of result.data.parts) {
          entry.transcript.putPart(part);
          this.emitPart(entry, part);
        }
        if (
          result.data.info.error &&
          result.data.info.error.name !== 'MessageAbortedError'
        )
          throw new Error(JSON.stringify(result.data.info.error.data));
      }
      // An earlier reconnect snapshot may have started before this turn finished.
      // Wait for it before fetching the authoritative completed transcript.
      await entry.restoring;
      await this.restore(entry, false);

      if (
        !entry.interruptRequested &&
        !state.queuePaused &&
        state.runPhase !== 'error'
      ) {
        await this.sessions.markCompletionUnreviewed(
          state.sessionId,
          'completed',
        );
        this.emit('event', {
          type: 'result',
          payload: {
            sessionId: state.sessionId,
            subtype: 'success',
            isError: false,
          },
        });
      }
    } catch (error) {
      if (!entry.controller.signal.aborted) this.fail(entry, error);
    }
  }
  private async generateTitle(
    entry: RuntimeEntry,
    prompt: string,
  ): Promise<void> {
    try {
      const session = await this.sessions.findOne(entry.state.sessionId);
      if (!this.titles.isAutoGeneratedName(session.name)) return;
      const title = await this.titles.generate(entry.cwd, prompt, 'opencode');
      if (title && !entry.controller.signal.aborted) {
        await this.sessions.renameFromGeneratedTitle(session.id, title);
        this.emit('event', {
          type: 'session_title',
          payload: { sessionId: session.id, title },
        });
      }
    } catch {
      /* A title failure must not interrupt a conversation. */
    }
  }
  interrupt(sessionId: number): Promise<void> {
    const pending = this.interrupts.get(sessionId);
    if (pending) return pending;
    const interruption = this.abortTurn(sessionId).finally(() => {
      if (this.interrupts.get(sessionId) === interruption)
        this.interrupts.delete(sessionId);
    });
    this.interrupts.set(sessionId, interruption);
    return interruption;
  }
  private async abortTurn(sessionId: number): Promise<void> {
    const state = await this.state(sessionId);
    this.interruptions.set(
      sessionId,
      (this.interruptions.get(sessionId) ?? 0) + 1,
    );
    state.queuePaused = state.pendingPrompts.length > 0;
    const entry = await this.ensure(sessionId);
    entry.interruptRequested = true;
    if (state.claudeSessionId)
      await entry.client!.session.abort({ sessionID: state.claudeSessionId });
    await entry.run;
    if (entry.controller.signal.aborted) return;
    state.queuePaused = state.pendingPrompts.length > 0;
    state.canInterrupt = false;
    state.runPhase = 'idle';
    this.emitState(entry);
  }
  async cancelPendingPrompt(sessionId: number, id: string) {
    const state = await this.state(sessionId);
    state.pendingPrompts = state.pendingPrompts.filter(
      (prompt) => prompt.id !== id,
    );
    if (!state.pendingPrompts.length) state.queuePaused = false;
    this.emit('event', { type: 'run_state', payload: state });
  }
  async clearPendingPrompts(sessionId: number) {
    const state = await this.state(sessionId);
    state.pendingPrompts = [];
    state.queuePaused = false;
    this.emit('event', { type: 'run_state', payload: state });
  }
  async steerPendingPrompt(sessionId: number, id: string) {
    const state = await this.state(sessionId);
    const prompt = state.pendingPrompts.find((item) => item.id === id);
    if (!prompt) throw new BadRequestException('Queued prompt was not found.');
    // V2 has native steering; V1 resumes the selected prompt after a clean abort.
    const entry = this.entries.get(sessionId);
    if (entry?.client?.steerPrompt && entry.run && !prompt.images?.length) {
      await entry.client.steerPrompt(state.claudeSessionId!, prompt.prompt);
      await this.cancelPendingPrompt(sessionId, id);
      return;
    }
    await this.interrupt(sessionId);
    await this.cancelPendingPrompt(sessionId, id);
    state.queuePaused = false;
    await this.submitPrompt(sessionId, prompt.prompt, undefined, prompt.images);
  }
  async resumePendingPrompts(sessionId: number) {
    const state = await this.state(sessionId);
    state.queuePaused = false;
    this.emit('event', { type: 'run_state', payload: state });
    await this.drain(sessionId);
  }
  private async drain(sessionId: number): Promise<void> {
    const state = await this.state(sessionId);
    if (state.canInterrupt || state.queuePaused || !state.pendingPrompts.length)
      return;
    const [next, ...remaining] = state.pendingPrompts;
    state.pendingPrompts = remaining;
    await this.submitPrompt(sessionId, next.prompt, undefined, next.images);
  }

  async setSelectedModel(sessionId: number, model: string | null) {
    const state = await this.state(sessionId);
    this.selectionChanged.add(sessionId);
    if (model) openCodeModel(model);
    state.selectedModel = model;
    if (!model) state.reasoningEffort = null;
    const known = state.availableModels.find((item) => item.id === model);
    if (known && !known.reasoningEfforts?.includes(state.reasoningEffort ?? ''))
      state.reasoningEffort = null;
    this.emit('event', { type: 'run_state', payload: state });
    return state;
  }
  async setReasoningEffort(sessionId: number, effort: string | null) {
    const state = await this.state(sessionId);
    this.selectionChanged.add(sessionId);
    const known = state.availableModels.find(
      (item) => item.id === state.selectedModel,
    );
    if (effort && known && !known.reasoningEfforts?.includes(effort))
      throw new BadRequestException(
        'This model does not support that OpenCode variant.',
      );
    state.reasoningEffort = effort;
    this.emit('event', { type: 'run_state', payload: state });
    return state;
  }
  async setPermissionMode(sessionId: number, mode: string | null) {
    if (
      mode &&
      ![
        'default',
        'auto',
        'acceptEdits',
        'bypassPermissions',
        'dontAsk',
      ].includes(mode)
    )
      throw new BadRequestException('Unsupported OpenCode permission mode.');
    const state = await this.state(sessionId);
    if (state.canInterrupt)
      throw new ConflictException(
        'Change permissions after the current turn finishes.',
      );
    if (state.claudeSessionId) {
      const entry = await this.ensure(sessionId);
      await entry.client!.session.update({
        sessionID: state.claudeSessionId,
        permission: openCodePermissionRules(mode) ?? [],
      });
    }
    state.permissionMode = mode ?? 'default';
    this.emit('event', { type: 'run_state', payload: state });
    return state;
  }
  async setPlanMode(sessionId: number, enabled: boolean) {
    const state = await this.state(sessionId);
    await this.sessions.updatePlanMode(sessionId, enabled);
    state.planMode = enabled;
    this.emit('event', { type: 'run_state', payload: state });
    return state;
  }
  async setAgentAutonomy(sessionId: number, mode: AgentAutonomyMode) {
    const state = await this.state(sessionId);
    if (state.canInterrupt)
      throw new ConflictException(
        'Change autonomy after the current turn finishes.',
      );
    await this.setPermissionMode(
      sessionId,
      mode === 'full' ? 'bypassPermissions' : 'default',
    );
    await this.sessions.updateAgentAutonomyMode(sessionId, mode);
    await this.setPlanMode(sessionId, mode === 'plan');
    const entry = this.entries.get(sessionId);
    if (entry) entry.system = buildMetaAgentPrompt(mode);
    return state;
  }
  async approvePermission(
    sessionId: number,
    requestId: string,
    remember?: boolean,
  ) {
    const entry = await this.ensure(sessionId);
    if (!entry.permissions.some((request) => request.id === requestId))
      throw new BadRequestException('Permission is no longer pending.');
    await entry.client!.permission.reply({
      requestID: requestId,
      reply: remember ? 'always' : 'once',
    });
    entry.permissions = entry.permissions.filter(
      (request) => request.id !== requestId,
    );
    this.syncRequests(entry);
  }
  async denyPermission(sessionId: number, requestId: string, message?: string) {
    const entry = await this.ensure(sessionId);
    if (!entry.permissions.some((request) => request.id === requestId))
      throw new BadRequestException('Permission is no longer pending.');
    await entry.client!.permission.reply({
      requestID: requestId,
      reply: 'reject',
      message,
    });
    entry.permissions = entry.permissions.filter(
      (request) => request.id !== requestId,
    );
    this.syncRequests(entry);
  }
  async answerUserInput(
    sessionId: number,
    requestId: string,
    action?: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ) {
    const entry = await this.ensure(sessionId);
    const request = entry.questions.find((item) => item.id === requestId);
    if (!request)
      throw new BadRequestException('Question is no longer pending.');
    if (
      action === 'accept' &&
      entry.client!.answerForm &&
      'fields' in request
    ) {
      await entry.client!.answerForm(requestId, content ?? {});
    } else if (action === 'accept') {
      const answers = request.questions.map((question, index) => {
        const value =
          content?.[String(index)] ??
          content?.[question.question] ??
          content?.[question.header];
        if (value == null)
          throw new BadRequestException(`Answer required: ${question.header}`);
        return Array.isArray(value) ? value : [String(value)];
      });
      await entry.client!.question.reply({ requestID: requestId, answers });
    } else await entry.client!.question.reject({ requestID: requestId });
    entry.questions = entry.questions.filter((item) => item.id !== requestId);
    this.syncRequests(entry);
  }

  async getAutocompleteItems(sessionId: number) {
    const entry = await this.ensure(sessionId);
    const commands = ((await entry.client!.command.list()).data ?? []).map(
      (command) => ({
        id: `opencode:${command.name}`,
        kind: 'command',
        trigger: '/',
        label: command.name,
        insertText: `/${command.name} `,
        description: command.description ?? '',
        source: 'runtime',
      }),
    );
    if (
      entry.client!.compact &&
      !commands.some((command) => command.label === 'compact')
    )
      commands.push({
        id: 'opencode:compact',
        kind: 'command',
        trigger: '/',
        label: 'compact',
        insertText: '/compact',
        description: 'Compact conversation context',
        source: 'runtime',
      });
    for (const agent of entry.resources?.agents.filter(
      (agent) => agent.primary,
    ) ?? [])
      commands.push({
        id: `opencode:agent:${agent.id}`,
        kind: 'command',
        trigger: '/',
        label: `agent ${agent.name}`,
        insertText: `/agent ${agent.id}`,
        description: agent.description ?? 'Switch primary agent',
        source: 'runtime',
      });
    for (const skill of entry.resources?.skills ?? [])
      commands.push({
        id: `opencode:skill:${skill.id}`,
        kind: 'skill',
        trigger: '/',
        label: skill.name,
        insertText: `/${skill.name} `,
        description: skill.description ?? '',
        source: 'runtime',
      });
    return commands;
  }
  async getSubagentHistory(sessionId: number, agentId: string) {
    const entry = await this.ensure(sessionId);
    if (
      !(await this.resolveOwnership(entry, agentId)) ||
      agentId === entry.state.claudeSessionId
    )
      throw new BadRequestException(
        'Subagent does not belong to this session.',
      );
    const messages =
      (await entry.client!.session.messages({ sessionID: agentId })).data ?? [];
    return {
      history: messages.flatMap((message) =>
        message.parts.flatMap((part) => openCodePartItems(part, message.info)),
      ),
      transcriptAvailable: true,
    };
  }
  async forkConversation(request: AgentForkConversationRequest) {
    const entry = await this.ensure(request.parentSessionId);
    const anchor = this.history(entry).find(
      (item) =>
        item.id === request.anchorMessageId ||
        item.sourceMessageId === request.anchorMessageId,
    );
    if (!entry.state.claudeSessionId || !anchor?.sourceMessageId)
      throw new BadRequestException('Fork anchor was not found.');
    const messages = entry.transcript.orderedMessages();
    // Native fork excludes the anchor. Assistant anchors include their completed turn.
    const boundary =
      request.anchorMessageKind === 'assistant'
        ? messages[
            messages.findIndex(
              (message) => message.id === anchor.sourceMessageId,
            ) + 1
          ]?.id
        : anchor.sourceMessageId;
    const fork = (
      await entry.client!.session.fork({
        sessionID: entry.state.claudeSessionId,
        messageID: boundary,
      })
    ).data!;
    const childSession = await this.sessions.findOne(request.childSessionId);
    if (entry.client!.moveSession)
      await entry.client!.moveSession(fork.id, childSession.worktreePath);
    await entry.client!.session.update({
      sessionID: fork.id,
      title: request.childSessionName,
    });
    const child = await this.state(request.childSessionId);
    child.selectedModel = entry.state.selectedModel;
    child.reasoningEffort = entry.state.reasoningEffort;
    child.planMode = entry.state.planMode;
    child.permissionMode = entry.state.permissionMode;
    await this.sessions.updatePlanMode(request.childSessionId, child.planMode);
    // OpenCode stores sessions by project, so the child can resume in its own worktree.
    child.claudeSessionId = fork.id;
    return {
      providerSessionId: fork.id,
      draft:
        request.anchorMessageKind === 'user' ? (anchor.content ?? null) : null,
      anchorExcerpt: anchor.content ?? null,
    };
  }
  async rewindConversation(sessionId: number, messageId: string) {
    const entry = await this.ensure(sessionId);
    if (entry.state.canInterrupt)
      throw new ConflictException('Stop the current turn before rewinding.');
    const anchor = this.history(entry).find(
      (item) => item.id === messageId || item.sourceMessageId === messageId,
    );
    if (!anchor?.sourceMessageId || !entry.state.claudeSessionId)
      throw new BadRequestException('Rewind anchor was not found.');
    // Rewind only conversation history; native revert also modifies files owned by Elevenex's Git UI.
    const ordered = entry.transcript.orderedMessages();
    const messages = ordered.slice(
      ordered.findIndex((message) => message.id === anchor.sourceMessageId),
    );
    if (entry.client!.rewindHistory)
      await entry.client!.rewindHistory(
        entry.state.claudeSessionId,
        anchor.sourceMessageId,
      );
    else
      for (const message of messages)
        await entry.client!.session.deleteMessage({
          sessionID: entry.state.claudeSessionId,
          messageID: message.id,
        });
    entry.transcript.removeMessages(messages);
    entry.state.liveItems = [];
    entry.state.pendingPrompts = [];
    const history = this.history(entry);
    this.emit('event', {
      type: 'history_snapshot',
      payload: { sessionId, history },
    });
    this.emitState(entry);
    return history;
  }

  async getMcpSnapshot(sessionId: number): Promise<ClaudeMcpSnapshot> {
    const entry = await this.ensure(sessionId);
    const [statuses, config] = await Promise.all([
      entry.client!.mcp.status(),
      entry.client!.config.get(),
    ]);
    const servers: ClaudeMcpSnapshot['servers'] = Object.entries(
      statuses.data ?? {},
    ).map(([name, status]) => {
      const definition = config.data?.mcp?.[name];
      const transport =
        definition && 'type' in definition && definition.type === 'local'
          ? 'stdio'
          : 'http';
      const connectionStatus =
        status.status === 'needs_auth' ||
        status.status === 'needs_client_registration'
          ? 'needs-auth'
          : status.status;
      return {
        entryId: name,
        name,
        scope: 'runtime',
        transport,
        configLocation: 'OpenCode configuration',
        enabled: status.status !== 'disabled',
        connectionStatus,
        configStatus: 'valid',
        ...('error' in status ? { error: status.error } : {}),
        actions: {
          canToggle: true,
          canRecheck: true,
          canAuth: connectionStatus === 'needs-auth',
          canReauth: transport === 'http',
          canViewTools: false,
        },
      };
    });
    return {
      servers,
      diagnostics: [],
      summary: {
        connected: servers.filter((s) => s.connectionStatus === 'connected')
          .length,
        needsAuth: servers.filter((s) => s.connectionStatus === 'needs-auth')
          .length,
        failed: servers.filter((s) => s.connectionStatus === 'failed').length,
        disabled: servers.filter((s) => !s.enabled).length,
        malformed: 0,
        total: servers.length,
      },
      lastUpdatedAt: new Date().toISOString(),
    };
  }
  async toggleMcpServer(sessionId: number, name: string) {
    const entry = await this.ensure(sessionId);
    const snapshot = await this.getMcpSnapshot(sessionId);
    const server = snapshot.servers.find((item) => item.name === name);
    if (!server) throw new BadRequestException('MCP server was not found.');
    if (server.enabled) await entry.client!.mcp.disconnect({ name });
    else await entry.client!.mcp.connect({ name });
    return this.getMcpSnapshot(sessionId);
  }
  async recheckMcpServer(sessionId: number, name: string) {
    const entry = await this.ensure(sessionId);
    await entry.client!.mcp.connect({ name });
    return this.getMcpSnapshot(sessionId);
  }
  async startMcpAuth(sessionId: number, name: string) {
    const entry = await this.ensure(sessionId);
    const result = (await entry.client!.mcp.auth.start({ name })).data!;
    return {
      serverName: name,
      url: result.authorizationUrl,
      mode: 'external' as const,
      authUrl: result.authorizationUrl,
      message: 'Authorize this MCP server in your browser.',
    };
  }

  onClientAttached(sessionId: number): void {
    this.clients.set(sessionId, (this.clients.get(sessionId) ?? 0) + 1);
    const entry = this.entries.get(sessionId);
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  }
  onClientDetached(sessionId: number): void {
    const count = Math.max(0, (this.clients.get(sessionId) ?? 1) - 1);
    if (count) this.clients.set(sessionId, count);
    else this.clients.delete(sessionId);
    this.scheduleIdle(sessionId);
  }
  private scheduleIdle(sessionId: number): void {
    const entry = this.entries.get(sessionId);
    if (
      !entry ||
      entry.run ||
      entry.state.canInterrupt ||
      this.clients.has(sessionId)
    )
      return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.stop(sessionId), 5 * 60_000);
    entry.idleTimer.unref();
    const idle = [...this.entries.entries()]
      .filter(
        ([id, item]) =>
          !item.run && !item.state.canInterrupt && !this.clients.has(id),
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [id] of idle.slice(0, Math.max(0, idle.length - 6)))
      this.stop(id);
  }
  private stop(sessionId: number): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    entry.controller.abort();
    entry.server.close();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.state.warmState = 'cold';
    entry.state.canInterrupt = false;
    if (entry.state.runPhase !== 'error') entry.state.runPhase = 'idle';
  }
  async cleanupSession(sessionId: number): Promise<void> {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    this.stop(sessionId);
    await this.starts.get(sessionId)?.catch(() => undefined);
    this.states.delete(sessionId);
    this.clients.delete(sessionId);
    this.selectionChanged.delete(sessionId);
    this.interruptions.delete(sessionId);
    this.interrupts.delete(sessionId);
  }
}
