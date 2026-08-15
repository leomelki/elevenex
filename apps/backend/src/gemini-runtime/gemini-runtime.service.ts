import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { SessionsService } from '../sessions/sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import {
  ClaudeHooksService,
  type ClaudeSessionActivity,
} from '../claude-hooks/claude-hooks.service.js';
import { resolveAgentStartupSelection } from '../agent-runtime/agent-model-defaults.js';
import type {
  AgentForkConversationRequest,
  AgentForkConversationResult,
  AgentImageInput,
  AgentProviderModelCatalogPayload,
} from '../agent-runtime/agent-runtime.types.js';
import type {
  ClaudeAutocompleteItem,
  ClaudeMcpSnapshot,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudePermissionRequest,
  ClaudeToolInteractionSummary,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';
import { GeminiAuthService } from './gemini-auth.service.js';
import { GeminiHistoryService } from './gemini-history.service.js';
import { GeminiMcpService } from './gemini-mcp.service.js';
import { GeminiSessionRuntime } from './gemini-session-runtime.js';
import {
  canonicalizeGeminiTool,
  contentBlockToText,
  isModeUpdateChunk,
  planEntriesToMarkdown,
  stripSessionContext,
  toolCallContentToText,
  toolCallPaths,
} from './gemini-transcript.js';
import type {
  AcpContentBlock,
  AcpNewSessionResult,
  AcpPermissionOption,
  AcpRequestPermissionParams,
  AcpSessionNotification,
  AcpToolCall,
  GeminiAuthStatus,
  GeminiPendingPermission,
  GeminiRuntimeSessionMetadata,
  GeminiRuntimeState,
  GeminiRuntimeStatePayload,
  GeminiSessionSnapshotPayload,
} from './gemini-runtime.types.js';

const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_RUNTIME_CAP = 20;

/** Gemini's own default when nothing is pinned. */
const GEMINI_DEFAULT_MODEL = 'auto';

/**
 * Seed catalog used before a live session reports the account's real list
 * (and when the user is signed out, so the settings picker is never empty).
 * Verified against gemini-cli 0.55.1's `session/new` response; the live list
 * always wins.
 */
const GEMINI_FALLBACK_MODELS: ClaudeModelOption[] = [
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Let Gemini CLI pick the best model for each task',
    isProviderDefault: true,
  },
  {
    id: 'gemini-3.1-pro-preview-customtools',
    displayName: 'gemini-3.1-pro-preview',
    description: 'Highest capability, slowest',
  },
  {
    id: 'gemini-3.5-flash',
    displayName: 'gemini-3.5-flash',
    description: 'Balanced speed and capability',
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'gemini-3-flash-preview',
    description: 'Fast preview model',
  },
  {
    id: 'gemini-3.1-flash-lite',
    displayName: 'gemini-3.1-flash-lite',
    description: 'Fastest, lowest cost',
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'gemini-2.5-pro',
    description: 'Previous generation, high capability',
  },
];

/**
 * UI permission style -> ACP mode id, verified against gemini-cli's
 * `availableModes` (`default`, `autoEdit`, `yolo`, `plan`).
 */
const PERMISSION_MODE_TO_ACP: Record<string, string> = {
  default: 'default',
  acceptEdits: 'autoEdit',
  auto: 'autoEdit',
  bypassPermissions: 'yolo',
  dontAsk: 'yolo',
  plan: 'plan',
};

const ACP_TO_PERMISSION_MODE: Record<string, ClaudePermissionMode> = {
  default: 'default',
  autoEdit: 'acceptEdits',
  yolo: 'bypassPermissions',
  plan: 'plan',
};

interface GeminiActiveRun {
  interruptRequested: boolean;
  permissions: Map<string, GeminiPendingPermission>;
}

interface GeminiRuntimeEntry {
  runtime: GeminiSessionRuntime;
  sessionId: number;
  worktreePath: string;
  attachedClients: number;
  idleTimer: NodeJS.Timeout | null;
  lastIdleAt: number;
}

@Injectable()
export class GeminiRuntimeService
  extends EventEmitter
  implements OnModuleDestroy
{
  private readonly logger = new Logger(GeminiRuntimeService.name);
  private readonly runtimes = new Map<number, GeminiRuntimeEntry>();
  private readonly runtimeStates = new Map<number, GeminiRuntimeState>();
  private readonly activeRuns = new Map<number, GeminiActiveRun>();
  private readonly initializingRuns = new Set<number>();
  private readonly clientCounts = new Map<number, number>();
  private readonly runtimeStartInFlight = new Map<
    number,
    Promise<GeminiSessionRuntime>
  >();
  /** Set while `session/load` replays history, so replay isn't shown as live. */
  private readonly replayingSessions = new Set<number>();
  private readonly replayBuffers = new Map<number, ClaudeTranscriptItem[]>();

  private readonly idleShutdownMs =
    Number(process.env.GEMINI_RUNTIME_IDLE_MS) || DEFAULT_IDLE_SHUTDOWN_MS;
  private readonly idleRuntimeCap =
    Number(process.env.GEMINI_RUNTIME_IDLE_CAP) || DEFAULT_IDLE_RUNTIME_CAP;

  /** Most recent model list reported by any live session. */
  private modelsCache: ClaudeModelOption[] | null = null;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: GeminiAuthService,
    private readonly mcpService: GeminiMcpService,
    private readonly historyService: GeminiHistoryService,
    private readonly hooksService: ClaudeHooksService,
    private readonly titleService: SessionTitleService,
    private readonly settingsService: SettingsService,
  ) {
    super();
    this.authService.on('status', (status: GeminiAuthStatus) => {
      void this.handleAuthStatusChange(status);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((id) => this.stopRuntime(id)),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Provider surface                                                        */
  /* ---------------------------------------------------------------------- */

  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.geminiSessionId);
    state.cachedWorktreePath = session.worktreePath;
    if (!state.geminiSessionId) return [];

    // A warm runtime already replayed the conversation during `session/load`.
    const replayed = this.replayBuffers.get(sessionId);
    if (replayed?.length) {
      state.liveItems = [];
      return replayed;
    }

    const file = await this.historyService.findChatFile(
      session.worktreePath,
      state.geminiSessionId,
    );
    if (!file) return [];
    state.liveItems = [];
    return this.historyService.toTranscript(file.messages);
  }

  async getRuntimeState(sessionId: number): Promise<GeminiRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.geminiSessionId);
    state.cachedWorktreePath = session.worktreePath;
    state.authStatus = await this.authService.getStatus();
    if (!state.availableModels.length) {
      state.availableModels = this.modelsCache
        ? [...this.modelsCache]
        : [...GEMINI_FALLBACK_MODELS];
    }
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSnapshot(sessionId: number): Promise<GeminiSessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);
    return { ...runtimeState, history };
  }

  getAutocompleteItems(sessionId: number): Promise<ClaudeAutocompleteItem[]> {
    // Gemini pushes its command list as a `session/update` right after
    // `session/new`, so there is nothing to request — just report what the
    // live session already told us.
    const state = this.ensureRuntimeState(sessionId);
    return Promise.resolve(
      state.availableCommands.map((command) => ({
        id: `gemini:${command.name}`,
        kind: 'command' as const,
        trigger: '/' as const,
        label: `/${command.name}`,
        insertText: `/${command.name} `,
        description: command.description ?? '',
        source: 'runtime' as const,
      })),
    );
  }

  getModelCatalog(): AgentProviderModelCatalogPayload {
    return {
      models: this.modelsCache?.length
        ? [...this.modelsCache]
        : [...GEMINI_FALLBACK_MODELS],
      // Gemini exposes a thinking budget rather than the shared
      // low/medium/high ladder, and ACP has no way to set it. Reporting an
      // empty list is the honest signal; the registry substitutes the generic
      // list so the picker still renders.
      reasoningEfforts: [],
      providerDefaultModelId: GEMINI_DEFAULT_MODEL,
      supportsModelSelection: true,
    };
  }

  async setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<GeminiRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    state.selectedModel = model;
    const entry = this.runtimes.get(sessionId);
    if (entry && state.geminiSessionId && model) {
      try {
        await entry.runtime.setModel(state.geminiSessionId, model);
      } catch (error) {
        this.logger.warn(
          `Could not switch the Gemini model session=${sessionId} model=${JSON.stringify(model)}: ${String(error)}`,
        );
      }
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPermissionMode(
    sessionId: number,
    mode: ClaudePermissionMode | null,
  ): Promise<GeminiRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    state.permissionMode = mode;
    // Plan mode is tracked separately and outranks the permission style, the
    // same way Codex layers plan mode over its sandbox settings.
    if (!state.planMode) {
      await this.applyAcpMode(sessionId, this.resolveAcpMode(state));
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPlanMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<GeminiRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    state.planMode = enabled;
    await this.applyAcpMode(sessionId, this.resolveAcpMode(state));
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  setReasoningEffort(
    sessionId: number,
    effort: string | null,
  ): Promise<GeminiRuntimeStatePayload> {
    // Recorded for the picker only — see getModelCatalog().
    const state = this.ensureRuntimeState(sessionId);
    state.reasoningEffort = effort;
    this.emitRunState(sessionId);
    return Promise.resolve(this.toRuntimeStatePayload(sessionId, state));
  }

  setFastMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<GeminiRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    state.fastMode = enabled;
    this.emitRunState(sessionId);
    return Promise.resolve(this.toRuntimeStatePayload(sessionId, state));
  }

  /* ---------------------------------------------------------------------- */
  /* Prompting                                                               */
  /* ---------------------------------------------------------------------- */

  async submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
  ): Promise<void> {
    const trimmed = prompt.trim();
    const blocks = this.buildPromptBlocks(trimmed, images);
    if (blocks.length === 0) return;

    if (
      this.activeRuns.has(sessionId) ||
      this.initializingRuns.has(sessionId)
    ) {
      this.queuePendingPrompt(sessionId, trimmed, images);
      return;
    }

    this.initializingRuns.add(sessionId);
    let state: GeminiRuntimeState | null = null;
    let runRegistered = false;

    try {
      const session = await this.sessionsService.findOne(sessionId);
      const isNewSession =
        (!session.geminiSessionId || session.geminiSessionId === '-1') &&
        this.titleService.isAutoGeneratedName(session.name);

      state = this.ensureRuntimeState(sessionId, session.geminiSessionId);
      state.cachedWorktreePath = session.worktreePath;
      state.runPhase = 'running';
      state.sessionState = 'running';
      state.canInterrupt = true;
      state.lastError = null;
      state.liveItems = [];
      state.streamingAssistantMessageId = null;
      state.streamingThoughtMessageId = null;
      this.emitRunState(sessionId);

      const runtime = await this.ensureRuntime(sessionId);
      const acpSessionId = state.geminiSessionId;
      if (!acpSessionId) {
        throw new Error('Gemini did not return a session id.');
      }

      if (isNewSession) {
        const effective = (titlePrompt ?? trimmed).trim();
        if (effective) {
          setImmediate(() => {
            void this.generateAndSaveSessionTitle(
              sessionId,
              session.worktreePath,
              effective,
            );
          });
        }
      }

      this.activeRuns.set(sessionId, {
        interruptRequested: false,
        permissions: new Map(),
      });
      runRegistered = true;
      this.initializingRuns.delete(sessionId);

      try {
        await this.sessionsService.updateStatus(sessionId, 'active');
        const result = await runtime.prompt(acpSessionId, blocks);
        if (result?.stopReason === 'refusal') {
          this.emitError(sessionId, 'Gemini declined to answer this prompt.');
        } else {
          this.finishRun(sessionId);
        }
      } catch (error) {
        const run = this.activeRuns.get(sessionId);
        if (run?.interruptRequested) {
          this.finalizeInterruptedRun(sessionId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // A prompt that fails on credentials means our cached auth answer is
        // stale; drop it so the workspace shows the login card promptly.
        if (/api key|credential|auth/i.test(message)) {
          this.authService.invalidate();
        }
        this.emitError(sessionId, message);
      } finally {
        this.activeRuns.delete(sessionId);
        this.scheduleIdleShutdown(sessionId);
        this.drainPendingPrompt(sessionId);
      }
    } catch (error) {
      this.initializingRuns.delete(sessionId);
      if (!runRegistered && state) {
        this.emitError(
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }

  private buildPromptBlocks(
    prompt: string,
    images?: AgentImageInput[],
  ): AcpContentBlock[] {
    const blocks: AcpContentBlock[] = [];
    if (prompt) blocks.push({ type: 'text', text: prompt });
    for (const image of images ?? []) {
      if (!image?.data || !image?.mediaType) continue;
      blocks.push({
        type: 'image',
        mimeType: image.mediaType,
        data: image.data,
      });
    }
    return blocks;
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

  private drainPendingPrompt(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    if (state.lastError || state.pendingPrompts.length === 0) return;
    const [next, ...rest] = state.pendingPrompts;
    state.pendingPrompts = rest;
    this.emitRunState(sessionId);
    setImmediate(() => {
      this.submitPrompt(sessionId, next.prompt, undefined, next.images).catch(
        (error) => {
          this.logger.error(
            `Pending Gemini prompt failed session=${sessionId}: ${String(error)}`,
          );
        },
      );
    });
  }

  interrupt(sessionId: number): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return Promise.resolve();
    run.interruptRequested = true;

    const entry = this.runtimes.get(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    // Answer every outstanding permission prompt first: gemini will not act on
    // `session/cancel` while it is blocked waiting for one.
    for (const pending of run.permissions.values()) {
      entry?.runtime.respondPermission(pending.rpcRequestId, {
        cancelled: true,
      });
    }
    run.permissions.clear();
    state.pendingPermissionRequest = null;

    if (entry && state.geminiSessionId) {
      entry.runtime.cancel(state.geminiSessionId);
    }
    return Promise.resolve();
  }

  cancelPendingPrompt(sessionId: number, id: string): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    state.pendingPrompts = state.pendingPrompts.filter(
      (prompt) => prompt.id !== id,
    );
    this.emitRunState(sessionId);
    return Promise.resolve();
  }

  /* ---------------------------------------------------------------------- */
  /* Permissions                                                             */
  /* ---------------------------------------------------------------------- */

  approvePermission(
    sessionId: number,
    requestId: string,
    remember = false,
  ): Promise<void> {
    this.resolvePermission(sessionId, requestId, remember ? 'always' : 'once');
    return Promise.resolve();
  }

  /**
   * ACP has no channel for a denial reason — the agent only learns which option
   * was selected — so any message the user typed is not forwarded.
   */
  denyPermission(sessionId: number, requestId: string): Promise<void> {
    this.resolvePermission(sessionId, requestId, 'reject');
    return Promise.resolve();
  }

  private resolvePermission(
    sessionId: number,
    requestId: string,
    decision: 'once' | 'always' | 'reject',
  ): void {
    const run = this.activeRuns.get(sessionId);
    const pending = run?.permissions.get(requestId);
    if (!run || !pending) return;
    run.permissions.delete(requestId);

    const state = this.ensureRuntimeState(sessionId);
    state.pendingPermissionRequest = null;
    state.sessionState = 'running';
    state.runPhase = 'running';

    const option = this.pickPermissionOption(pending.options, decision);
    const entry = this.runtimes.get(sessionId);
    if (option) {
      entry?.runtime.respondPermission(pending.rpcRequestId, {
        optionId: option.optionId,
      });
    } else {
      entry?.runtime.respondPermission(pending.rpcRequestId, {
        cancelled: true,
      });
    }

    const interaction: ClaudeToolInteractionSummary = {
      kind: 'permission',
      decision:
        decision === 'reject'
          ? 'denied'
          : decision === 'always'
            ? 'approved_always'
            : 'approved',
      decisionLabel:
        decision === 'reject'
          ? 'Denied'
          : decision === 'always'
            ? 'Always allowed'
            : 'Allowed',
      decisionTone: decision === 'reject' ? 'warn' : 'ok',
      remember: decision === 'always',
      createdAt: pending.request.createdAt,
      resolvedAt: new Date().toISOString(),
    };

    this.emitEvent({
      type: 'permission_resolved',
      payload: {
        sessionId,
        requestId,
        toolUseId: pending.request.toolUseId,
        decision: interaction.decision,
        interaction,
      },
    });
    this.emitRunState(sessionId);
  }

  /**
   * Picks the ACP option matching the user's decision. Gemini supplies the
   * option ids, so they are matched by `kind` rather than assumed.
   */
  private pickPermissionOption(
    options: AcpPermissionOption[],
    decision: 'once' | 'always' | 'reject',
  ): AcpPermissionOption | null {
    const wanted: string[] =
      decision === 'reject'
        ? ['reject_once', 'reject_always']
        : decision === 'always'
          ? ['allow_always', 'allow_once']
          : ['allow_once', 'allow_always'];

    for (const kind of wanted) {
      const match = options.find((option) => option.kind === kind);
      if (match) return match;
    }
    // Fall back to positional order when an agent omits `kind`.
    return decision === 'reject'
      ? (options[options.length - 1] ?? null)
      : (options[0] ?? null);
  }

  /* ---------------------------------------------------------------------- */
  /* MCP                                                                     */
  /* ---------------------------------------------------------------------- */

  async getMcpSnapshot(sessionId: number): Promise<ClaudeMcpSnapshot> {
    const worktreePath = await this.resolveWorktreePath(sessionId);
    return this.mcpService.getSnapshot(worktreePath);
  }

  async toggleMcpServer(
    sessionId: number,
    serverName: string,
  ): Promise<ClaudeMcpSnapshot> {
    const worktreePath = await this.resolveWorktreePath(sessionId);
    const snapshot = await this.mcpService.toggleServer(
      worktreePath,
      serverName,
    );
    // Gemini reads its MCP config once, at session/new, so an already-running
    // process keeps the old server set. Stop it (when idle) so the next prompt
    // starts with the new configuration.
    if (!this.activeRuns.has(sessionId)) {
      await this.stopRuntime(sessionId).catch(() => undefined);
      this.emitRunState(sessionId);
    }
    return snapshot;
  }

  async recheckMcpServer(sessionId: number): Promise<ClaudeMcpSnapshot> {
    const worktreePath = await this.resolveWorktreePath(sessionId);
    return this.mcpService.recheckServer(worktreePath);
  }

  private async resolveWorktreePath(sessionId: number): Promise<string | null> {
    const state = this.runtimeStates.get(sessionId);
    if (state?.cachedWorktreePath) return state.cachedWorktreePath;
    try {
      const session = await this.sessionsService.findOne(sessionId);
      return session.worktreePath;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Fork and rewind                                                         */
  /* ---------------------------------------------------------------------- */

  async forkConversation(
    request: AgentForkConversationRequest,
  ): Promise<AgentForkConversationResult> {
    if (!request.anchorMessageId || !request.anchorMessageKind) {
      throw new BadRequestException(
        'A Gemini fork anchor message is required.',
      );
    }

    const session = await this.sessionsService.findOne(request.parentSessionId);
    const parentSessionId = session.geminiSessionId;
    if (!parentSessionId || parentSessionId === '-1') {
      throw new NotFoundException('Gemini session not found.');
    }

    const file = await this.historyService.findChatFile(
      session.worktreePath,
      parentSessionId,
    );
    if (!file) {
      throw new NotFoundException('Gemini conversation file not found.');
    }

    const { retained, draft, anchorExcerpt } = this.splitAtAnchor(
      file.messages,
      request.anchorMessageId,
      request.anchorMessageKind,
    );

    if (retained.length === 0) {
      // Nothing worth carrying over — the child starts clean with the draft.
      return { providerSessionId: null, draft, anchorExcerpt };
    }

    const forkSessionId = randomUUID();
    const forkPath = this.buildForkChatPath(file.path, forkSessionId);
    await this.historyService.writeChatFile(
      forkPath,
      {
        ...file.header,
        sessionId: forkSessionId,
        startTime: new Date().toISOString(),
      },
      retained,
    );

    return { providerSessionId: forkSessionId, draft, anchorExcerpt };
  }

  /**
   * ACP has no rewind primitive, so this truncates Gemini's own conversation
   * file in place and drops the live process. The next prompt re-loads the
   * session, which replays only the retained messages.
   */
  async rewindConversation(
    sessionId: number,
    messageId: string,
  ): Promise<ClaudeTranscriptItem[]> {
    const trimmed = messageId.trim();
    if (!trimmed) throw new BadRequestException('A messageId is required.');
    if (this.activeRuns.has(sessionId)) {
      throw new ConflictException(
        'Cannot edit a message while Gemini is actively running.',
      );
    }

    const session = await this.sessionsService.findOne(sessionId);
    const acpSessionId = session.geminiSessionId;
    if (!acpSessionId || acpSessionId === '-1') {
      throw new NotFoundException('Gemini session not found.');
    }

    const file = await this.historyService.findChatFile(
      session.worktreePath,
      acpSessionId,
    );
    if (!file) {
      throw new NotFoundException('Gemini conversation file not found.');
    }

    const { retained } = this.splitAtAnchor(file.messages, trimmed, 'user');
    await this.historyService.writeChatFile(file.path, file.header, retained);

    await this.stopRuntime(sessionId).catch(() => undefined);
    this.replayBuffers.delete(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    state.liveItems = [];
    this.emitRunState(sessionId);

    return this.historyService.toTranscript(retained);
  }

  /**
   * Splits a materialized message list at the anchor. A user anchor is dropped
   * and handed back as the child's draft (so it can be re-sent, possibly
   * edited); an assistant anchor is kept.
   */
  private splitAtAnchor(
    messages: Record<string, unknown>[],
    anchorMessageId: string,
    anchorKind: 'user' | 'assistant',
  ): {
    retained: Record<string, unknown>[];
    draft: string | null;
    anchorExcerpt: string | null;
  } {
    const index = messages.findIndex((message) => {
      const id = message['id'];
      return (
        typeof id === 'string' &&
        (id === anchorMessageId || anchorMessageId.startsWith(id))
      );
    });
    if (index === -1) {
      throw new NotFoundException(
        'Message not found in the Gemini conversation.',
      );
    }

    const target = messages[index];
    const text = this.messageToText(target);
    const draft = anchorKind === 'user' ? stripSessionContext(text) : null;
    const anchorExcerpt = anchorKind === 'user' ? draft : text;

    return {
      retained: messages.slice(0, anchorKind === 'user' ? index : index + 1),
      draft,
      anchorExcerpt,
    };
  }

  private messageToText(message: Record<string, unknown>): string {
    const parts = Array.isArray(message['content'])
      ? message['content']
      : Array.isArray(message['parts'])
        ? message['parts']
        : [];
    return (parts as unknown[])
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const text = (part as Record<string, unknown>)['text'];
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private buildForkChatPath(sourcePath: string, sessionId: string): string {
    // Mirrors gemini's own naming: session-<ISO with ':' and '.' replaced>-<short id>.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const shortId = sessionId.split('-')[0];
    const name = `session-${stamp}-${shortId}.jsonl`;
    return join(dirname(sourcePath), name);
  }

  /* ---------------------------------------------------------------------- */
  /* Runtime lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  private async ensureRuntime(
    sessionId: number,
  ): Promise<GeminiSessionRuntime> {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      this.clearIdleTimer(existing);
      return existing.runtime;
    }
    const inFlight = this.runtimeStartInFlight.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.startRuntime(sessionId).finally(() => {
      this.runtimeStartInFlight.delete(sessionId);
    });
    this.runtimeStartInFlight.set(sessionId, promise);
    return promise;
  }

  private async startRuntime(sessionId: number): Promise<GeminiSessionRuntime> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.geminiSessionId);
    state.cachedWorktreePath = session.worktreePath;

    const runtime = new GeminiSessionRuntime({
      cwd: session.worktreePath,
      env: this.authService.getRuntimeEnv(),
    });
    const entry: GeminiRuntimeEntry = {
      runtime,
      sessionId,
      worktreePath: session.worktreePath,
      attachedClients: this.clientCounts.get(sessionId) ?? 0,
      idleTimer: null,
      lastIdleAt: Date.now(),
    };
    this.runtimes.set(sessionId, entry);

    runtime.on('session_update', (notification: AcpSessionNotification) => {
      this.handleSessionUpdate(sessionId, notification);
    });
    runtime.on(
      'permission_request',
      (request: {
        id: number | string;
        params: AcpRequestPermissionParams;
      }) => {
        this.handlePermissionRequest(sessionId, request.id, request.params);
      },
    );
    runtime.on('exit', (details: { message?: string; stderr?: string }) => {
      this.handleRuntimeExit(sessionId, details);
    });

    try {
      await runtime.start();
      await this.openAcpSession(sessionId, runtime, session.worktreePath);
    } catch (error) {
      this.runtimes.delete(sessionId);
      await runtime.stop().catch(() => undefined);
      throw error;
    }

    this.enforceIdleRuntimeCap();
    return runtime;
  }

  /** Resumes the stored ACP session when possible, otherwise creates one. */
  private async openAcpSession(
    sessionId: number,
    runtime: GeminiSessionRuntime,
    worktreePath: string,
  ): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    const stored = state.geminiSessionId;
    const canLoad =
      Boolean(stored) && runtime.agentCapabilities?.loadSession === true;

    if (stored && canLoad) {
      this.replayingSessions.add(sessionId);
      this.replayBuffers.set(sessionId, []);
      try {
        const loaded = await runtime.loadSession({
          sessionId: stored,
          cwd: worktreePath,
        });
        this.applySessionDescriptors(sessionId, loaded);
        const replayed = this.replayBuffers.get(sessionId) ?? [];
        this.emitEvent({
          type: 'history_snapshot',
          payload: { sessionId, history: replayed },
        });
        return;
      } catch (error) {
        this.logger.warn(
          `Could not resume the Gemini session session=${sessionId} acpSessionId=${stored}: ${String(error)} — starting a new one.`,
        );
        this.replayBuffers.delete(sessionId);
      } finally {
        this.replayingSessions.delete(sessionId);
      }
    }

    const created = await runtime.newSession({ cwd: worktreePath });
    state.geminiSessionId = created.sessionId;
    this.applySessionDescriptors(sessionId, created);
    this.emitEvent({
      type: 'session_created',
      payload: { sessionId, claudeSessionId: created.sessionId },
    });
    await this.sessionsService.updateGeminiSessionId(
      sessionId,
      created.sessionId,
    );

    // A fresh session starts on Gemini's default mode/model; push the user's
    // configured choices so the process actually matches what the UI shows.
    const configured = state.selectedModel;
    if (configured && configured !== GEMINI_DEFAULT_MODEL) {
      await runtime
        .setModel(created.sessionId, configured)
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not apply the default Gemini model session=${sessionId} model=${JSON.stringify(configured)}: ${String(error)}`,
          );
        });
    }
    const mode = this.resolveAcpMode(state);
    if (mode && mode !== 'default') {
      await this.applyAcpMode(sessionId, mode);
    }
  }

  private applySessionDescriptors(
    sessionId: number,
    result: AcpNewSessionResult | null,
  ): void {
    if (!result) return;
    const state = this.ensureRuntimeState(sessionId);

    const models = result.models?.availableModels ?? [];
    if (models.length) {
      const mapped = models.map<ClaudeModelOption>((model) => ({
        id: model.modelId,
        displayName: model.name ?? model.modelId,
        description: model.description ?? '',
        isProviderDefault: model.modelId === GEMINI_DEFAULT_MODEL,
      }));
      state.availableModels = mapped;
      this.modelsCache = mapped;
    }
    if (result.models?.currentModelId && !state.selectedModel) {
      state.selectedModel = result.models.currentModelId;
    }

    const modes = result.modes?.availableModes ?? [];
    if (modes.length) state.availableModes = modes;
    const currentMode = result.modes?.currentModeId;
    if (currentMode) this.applyAcpModeToState(state, currentMode);

    this.emitSessionMetadata(sessionId);
  }

  private resolveAcpMode(state: GeminiRuntimeState): string {
    if (state.planMode) return 'plan';
    const mode = state.permissionMode ?? 'default';
    return PERMISSION_MODE_TO_ACP[mode] ?? 'default';
  }

  private applyAcpModeToState(
    state: GeminiRuntimeState,
    acpModeId: string,
  ): void {
    if (acpModeId === 'plan') {
      state.planMode = true;
      return;
    }
    state.planMode = false;
    state.permissionMode = ACP_TO_PERMISSION_MODE[acpModeId] ?? 'default';
  }

  private async applyAcpMode(
    sessionId: number,
    acpModeId: string,
  ): Promise<void> {
    const entry = this.runtimes.get(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    if (!entry || !state.geminiSessionId) return;
    // Only send modes the running agent actually advertised.
    if (
      state.availableModes.length &&
      !state.availableModes.some((mode) => mode.id === acpModeId)
    ) {
      this.logger.warn(
        `Gemini does not support mode ${acpModeId} session=${sessionId}`,
      );
      return;
    }
    try {
      await entry.runtime.setMode(state.geminiSessionId, acpModeId);
    } catch (error) {
      this.logger.warn(
        `Could not set the Gemini mode session=${sessionId} mode=${acpModeId}: ${String(error)}`,
      );
    }
  }

  private async stopRuntime(sessionId: number): Promise<void> {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    this.runtimes.delete(sessionId);
    this.clearIdleTimer(entry);
    await entry.runtime.stop();
  }

  private scheduleIdleShutdown(sessionId: number): void {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    this.clearIdleTimer(entry);
    if (entry.attachedClients > 0) return;
    entry.lastIdleAt = Date.now();
    entry.idleTimer = setTimeout(() => {
      if (this.activeRuns.has(sessionId)) return;
      void this.stopRuntime(sessionId).catch(() => undefined);
    }, this.idleShutdownMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: GeminiRuntimeEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  /**
   * Caps how many idle Gemini processes linger. A repo with hundreds of
   * branches can otherwise accumulate one child per visited session.
   */
  private enforceIdleRuntimeCap(): void {
    const idle = [...this.runtimes.values()]
      .filter(
        (entry) =>
          entry.attachedClients === 0 && !this.activeRuns.has(entry.sessionId),
      )
      .sort((a, b) => a.lastIdleAt - b.lastIdleAt);
    const excess = idle.length - this.idleRuntimeCap;
    for (let index = 0; index < excess; index += 1) {
      void this.stopRuntime(idle[index].sessionId).catch(() => undefined);
    }
  }

  private handleRuntimeExit(
    sessionId: number,
    details: { message?: string; stderr?: string },
  ): void {
    this.runtimes.delete(sessionId);
    this.replayBuffers.delete(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    const stderr = details.stderr?.trim();
    this.emitError(
      sessionId,
      `${details.message ?? 'The Gemini process exited.'}${
        stderr ? ` — ${stderr.slice(-500)}` : ''
      }`,
    );
  }

  async cleanupSession(sessionId: number): Promise<void> {
    await this.stopRuntime(sessionId);
    this.runtimeStates.delete(sessionId);
    this.clientCounts.delete(sessionId);
    this.activeRuns.delete(sessionId);
    this.replayBuffers.delete(sessionId);
    this.replayingSessions.delete(sessionId);
  }

  onClientAttached(sessionId: number): void {
    const next = (this.clientCounts.get(sessionId) ?? 0) + 1;
    this.clientCounts.set(sessionId, next);
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    entry.attachedClients = next;
    this.clearIdleTimer(entry);
  }

  onClientDetached(sessionId: number): void {
    const next = Math.max(0, (this.clientCounts.get(sessionId) ?? 0) - 1);
    this.clientCounts.set(sessionId, next);
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    entry.attachedClients = next;
    this.scheduleIdleShutdown(sessionId);
  }

  private async handleAuthStatusChange(
    status: GeminiAuthStatus,
  ): Promise<void> {
    if (status.isAuthenticating) return;
    for (const [sessionId, state] of this.runtimeStates.entries()) {
      const previous = state.authStatus;
      state.authStatus = status;
      const credentialsChanged =
        status.authenticated && !previous?.authenticated;
      // A running Gemini process resolved its credentials at startup, so it
      // keeps reporting "signed out" after a successful login. Drop it so the
      // next prompt respawns with the new credential.
      if (
        credentialsChanged &&
        this.runtimes.has(sessionId) &&
        !this.activeRuns.has(sessionId)
      ) {
        await this.stopRuntime(sessionId).catch(() => undefined);
      }
      this.emitRunState(sessionId);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* session/update handling                                                 */
  /* ---------------------------------------------------------------------- */

  private handleSessionUpdate(
    sessionId: number,
    notification: AcpSessionNotification,
  ): void {
    const update = notification?.update;
    if (!update || typeof update !== 'object') return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.handleTextChunk(
          sessionId,
          contentBlockToText(update.content),
          'assistant',
        );
        return;
      case 'agent_thought_chunk':
        this.handleTextChunk(
          sessionId,
          contentBlockToText(update.content),
          'thinking',
        );
        return;
      case 'user_message_chunk':
        this.handleUserChunk(sessionId, contentBlockToText(update.content));
        return;
      case 'tool_call':
        this.handleToolCall(sessionId, update, false);
        return;
      case 'tool_call_update':
        this.handleToolCall(sessionId, update, true);
        return;
      case 'plan':
        this.handlePlan(sessionId, planEntriesToMarkdown(update.entries));
        return;
      case 'available_commands_update': {
        const state = this.ensureRuntimeState(sessionId);
        state.availableCommands = update.availableCommands ?? [];
        return;
      }
      case 'current_mode_update': {
        const state = this.ensureRuntimeState(sessionId);
        this.applyAcpModeToState(state, update.currentModeId);
        this.emitRunState(sessionId);
        return;
      }
      default:
        return;
    }
  }

  private handleTextChunk(
    sessionId: number,
    text: string,
    kind: 'assistant' | 'thinking',
  ): void {
    if (!text) return;
    // `session/set_mode` echoes a synthetic "[MODE_UPDATE] <mode>" chunk that
    // is protocol bookkeeping, not model output.
    if (kind === 'assistant' && isModeUpdateChunk(text)) return;

    const state = this.ensureRuntimeState(sessionId);
    const idField =
      kind === 'assistant'
        ? ('streamingAssistantMessageId' as const)
        : ('streamingThoughtMessageId' as const);
    // Prose and reasoning interleave, so starting one closes the other.
    const otherField =
      kind === 'assistant'
        ? ('streamingThoughtMessageId' as const)
        : ('streamingAssistantMessageId' as const);

    if (this.replayingSessions.has(sessionId)) {
      this.appendReplayText(sessionId, text, kind);
      return;
    }

    let itemId = state[idField];
    if (!itemId) {
      state[otherField] = null;
      itemId = randomUUID();
      state[idField] = itemId;
      this.pushItem(
        sessionId,
        {
          id: itemId,
          kind,
          ...(kind === 'assistant' ? { contentType: 'message' as const } : {}),
          content: text,
          timestamp: new Date().toISOString(),
        },
        kind === 'assistant' ? 'message_start' : 'thinking_start',
      );
      return;
    }

    this.appendDelta(
      sessionId,
      itemId,
      text,
      kind === 'assistant' ? 'message_delta' : 'thinking_delta',
    );
  }

  private handleUserChunk(sessionId: number, text: string): void {
    const content = stripSessionContext(text);
    if (!content) return;
    if (!this.replayingSessions.has(sessionId)) return;
    // User chunks only arrive while `session/load` replays; live prompts are
    // already in the transcript from the moment they were submitted.
    this.replayBuffers.get(sessionId)?.push({
      id: randomUUID(),
      kind: 'user',
      contentType: 'message',
      content,
      timestamp: new Date().toISOString(),
    });
  }

  private appendReplayText(
    sessionId: number,
    text: string,
    kind: 'assistant' | 'thinking',
  ): void {
    const buffer = this.replayBuffers.get(sessionId);
    if (!buffer) return;
    const last = buffer[buffer.length - 1];
    if (last && last.kind === kind) {
      last.content = `${last.content ?? ''}${text}`;
      return;
    }
    buffer.push({
      id: randomUUID(),
      kind,
      ...(kind === 'assistant' ? { contentType: 'message' as const } : {}),
      content: text,
      timestamp: new Date().toISOString(),
    });
  }

  private handleToolCall(
    sessionId: number,
    call: AcpToolCall,
    isUpdate: boolean,
  ): void {
    if (!call?.toolCallId) return;
    const canonical = canonicalizeGeminiTool(call);
    const paths = toolCallPaths(call);
    const timestamp = new Date().toISOString();

    const item: ClaudeTranscriptItem = {
      id: call.toolCallId,
      kind: 'tool_use',
      toolUseId: call.toolCallId,
      toolName: canonical.toolDisplayName,
      providerToolName: canonical.providerToolName,
      toolKind: canonical.toolKind,
      toolDisplayName: canonical.toolDisplayName,
      toolInput: paths.length
        ? { ...(canonical.toolInput as object), file_path: paths[0], paths }
        : canonical.toolInput,
      providerToolInput: call.rawInput,
      timestamp,
    };

    if (this.replayingSessions.has(sessionId)) {
      const buffer = this.replayBuffers.get(sessionId);
      const existing = buffer?.findIndex((entry) => entry.id === item.id) ?? -1;
      if (buffer && existing >= 0) buffer[existing] = item;
      else buffer?.push(item);
      return;
    }

    // Any tool activity ends the current prose/reasoning block, so the next
    // chunk starts a fresh transcript entry instead of appending after a card.
    const state = this.ensureRuntimeState(sessionId);
    state.streamingAssistantMessageId = null;
    state.streamingThoughtMessageId = null;

    this.pushItem(sessionId, item, 'tool_use');

    if (!isUpdate) return;
    const status = call.status;
    if (status !== 'completed' && status !== 'failed') return;

    const output = toolCallContentToText(call.content);
    this.pushItem(
      sessionId,
      {
        id: `${call.toolCallId}-result`,
        kind: 'tool_result',
        toolUseId: call.toolCallId,
        content: output,
        ...(status === 'failed' ? { isError: true } : {}),
        timestamp,
      },
      'tool_result',
    );
  }

  private handlePlan(sessionId: number, markdown: string): void {
    if (!markdown) return;
    const item: ClaudeTranscriptItem = {
      id: randomUUID(),
      kind: 'assistant',
      contentType: 'plan',
      content: markdown,
      timestamp: new Date().toISOString(),
    };
    if (this.replayingSessions.has(sessionId)) {
      this.replayBuffers.get(sessionId)?.push(item);
      return;
    }
    const state = this.ensureRuntimeState(sessionId);
    state.streamingAssistantMessageId = null;
    this.pushItem(sessionId, item, 'message_start');
  }

  private handlePermissionRequest(
    sessionId: number,
    rpcRequestId: number | string,
    params: AcpRequestPermissionParams,
  ): void {
    const run = this.activeRuns.get(sessionId);
    const call: AcpToolCall = params?.toolCall ?? { toolCallId: randomUUID() };
    const canonical = canonicalizeGeminiTool(call);
    const requestId = randomUUID();

    const request: ClaudePermissionRequest = {
      requestId,
      toolUseId: call.toolCallId ?? requestId,
      toolName: canonical.toolDisplayName,
      providerToolName: canonical.providerToolName,
      toolKind: canonical.toolKind,
      toolDisplayName: canonical.toolDisplayName,
      input: canonical.toolInput,
      providerInput: call.rawInput,
      title: call.title,
      createdAt: new Date().toISOString(),
    };

    if (!run) {
      // No run to attach to (e.g. the turn already ended); decline rather than
      // leaving gemini blocked forever on an unanswerable request.
      this.runtimes
        .get(sessionId)
        ?.runtime.respondPermission(rpcRequestId, { cancelled: true });
      return;
    }

    run.permissions.set(requestId, {
      request,
      rpcRequestId,
      options: params?.options ?? [],
    });

    const state = this.ensureRuntimeState(sessionId);
    state.pendingPermissionRequest = request;
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';

    this.emitEvent({
      type: 'permission_request',
      payload: { sessionId, request },
    });
    this.emitRunState(sessionId);
  }

  /* ---------------------------------------------------------------------- */
  /* State + events                                                          */
  /* ---------------------------------------------------------------------- */

  private ensureRuntimeState(
    sessionId: number,
    geminiSessionId?: string | null,
  ): GeminiRuntimeState {
    const existing = this.runtimeStates.get(sessionId);
    if (existing) {
      if (geminiSessionId && geminiSessionId !== '-1') {
        existing.geminiSessionId = geminiSessionId;
      }
      return existing;
    }

    const availableModels = this.modelsCache
      ? [...this.modelsCache]
      : [...GEMINI_FALLBACK_MODELS];
    const startup = resolveAgentStartupSelection(
      this.settingsService.getAgentProviderDefaults('gemini'),
      availableModels,
      GEMINI_DEFAULT_MODEL,
    );

    const state: GeminiRuntimeState = {
      geminiSessionId:
        geminiSessionId && geminiSessionId !== '-1' ? geminiSessionId : null,
      cachedWorktreePath: null,
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPrompts: [],
      liveItems: [],
      streamingAssistantMessageId: null,
      streamingThoughtMessageId: null,
      pendingPermissionRequest: null,
      pendingUserInputRequest: null,
      lastError: null,
      selectedModel: startup.selectedModel,
      reasoningEffort: startup.reasoningEffort,
      fastMode: false,
      permissionMode: 'default',
      planMode: false,
      availableModels,
      availableModes: [],
      availableCommands: [],
      contextUsage: null,
      sessionMetadata: null,
      authStatus: null,
    };
    this.runtimeStates.set(sessionId, state);
    return state;
  }

  private finishRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.streamingAssistantMessageId = null;
    state.streamingThoughtMessageId = null;
    this.emitEvent({ type: 'complete', payload: { sessionId } });
    this.emitRunState(sessionId);
  }

  private finalizeInterruptedRun(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.liveItems = [];
    state.streamingAssistantMessageId = null;
    state.streamingThoughtMessageId = null;
    this.emitEvent({ type: 'complete', payload: { sessionId } });
    this.emitRunState(sessionId);
  }

  private emitSessionMetadata(sessionId: number): void {
    const state = this.ensureRuntimeState(sessionId);
    const metadata: GeminiRuntimeSessionMetadata = {
      cwd: state.cachedWorktreePath ?? '',
      model: state.selectedModel ?? GEMINI_DEFAULT_MODEL,
      permissionMode: state.planMode
        ? 'plan'
        : (state.permissionMode ?? 'default'),
      geminiVersion: state.authStatus?.version ?? 'unknown',
      authMethod: state.authStatus?.authMethod ?? 'unknown',
      outputStyle: 'default',
      tools: [],
      slashCommands: state.availableCommands.map((command) => command.name),
      skills: [],
      agents: [],
      fastModeState: state.fastMode ? 'on' : 'off',
      mcpServers: [],
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
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        availableModels: state.availableModels,
        contextUsage: state.contextUsage,
        pendingPermissionRequest: state.pendingPermissionRequest,
        pendingUserInputRequest: state.pendingUserInputRequest,
        pendingPrompts: state.pendingPrompts,
      },
    });
  }

  private toSidebarActivity(state: GeminiRuntimeState): ClaudeSessionActivity {
    if (state.pendingPermissionRequest) {
      return {
        activityStatus: 'waiting',
        actionKind: 'permission',
        actionLabel: 'Permission needed',
      };
    }
    return {
      activityStatus:
        state.runPhase === 'running' || state.runPhase === 'waiting'
          ? state.runPhase
          : 'idle',
      actionKind: null,
      actionLabel: null,
    };
  }

  private toRuntimeStatePayload(
    sessionId: number,
    state: GeminiRuntimeState,
  ): GeminiRuntimeStatePayload {
    const entry = this.runtimes.get(sessionId);
    return {
      sessionId,
      claudeSessionId: state.geminiSessionId,
      runPhase: state.runPhase,
      sessionState: state.sessionState,
      canInterrupt: state.canInterrupt,
      pendingPermissionRequest: state.pendingPermissionRequest,
      pendingUserInputRequest: state.pendingUserInputRequest,
      pendingPrompts: state.pendingPrompts,
      liveItems: state.liveItems,
      lastError: state.lastError,
      selectedModel: state.selectedModel,
      reasoningEffort: state.reasoningEffort,
      fastMode: state.fastMode,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
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
      warmState: entry ? 'warm' : 'cold',
      lastWarmedAt: entry ? new Date(entry.lastIdleAt).toISOString() : null,
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
    this.emitEvent({ type: eventType, payload: { sessionId, item } });
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
    this.emitEvent({ type: eventType, payload: { sessionId, itemId, delta } });
  }

  private emitError(sessionId: number, message: string): void {
    const state = this.ensureRuntimeState(sessionId);
    state.lastError = message;
    state.runPhase = 'error';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.streamingAssistantMessageId = null;
    state.streamingThoughtMessageId = null;
    this.emitEvent({ type: 'error', payload: { sessionId, message } });
    this.emitRunState(sessionId);
  }

  private emitEvent(event: Record<string, unknown>): void {
    this.emit('event', event);
  }

  private async generateAndSaveSessionTitle(
    sessionId: number,
    worktreePath: string,
    prompt: string,
  ): Promise<void> {
    try {
      const title = await this.titleService.generate(
        worktreePath,
        prompt,
        'gemini',
      );
      if (!title) return;
      await this.sessionsService.renameFromGeneratedTitle(sessionId, title);
    } catch (error) {
      this.logger.warn(
        `Session title generation failed session=${sessionId}: ${String(error)}`,
      );
    }
  }
}
