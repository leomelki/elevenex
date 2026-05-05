import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { access, readdir, readFile, realpath, writeFile } from 'fs/promises';
import { constants as fsConstants, readFileSync } from 'fs';
import { createRequire } from 'module';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { basename, dirname, join, relative, resolve } from 'path';
import { eq } from 'drizzle-orm';
import {
  getSubagentMessages,
  getSessionMessages,
  query,
  type ModelInfo,
  type SDKControlGetContextUsageResponse,
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type Options,
  type SDKAPIRetryMessage,
  type SDKAssistantMessage,
  type SDKAuthStatusMessage,
  type SDKCompactBoundaryMessage,
  type SDKElicitationCompleteMessage,
  type SDKFilesPersistedEvent,
  type SDKHookProgressMessage,
  type SDKHookResponseMessage,
  type SDKHookStartedMessage,
  type SDKMemoryRecallMessage,
  type SDKMessage,
  type SDKMirrorErrorMessage,
  type SDKNotificationMessage,
  type SDKPartialAssistantMessage,
  type SDKPluginInstallMessage,
  type SDKPromptSuggestionMessage,
  type SDKRateLimitEvent,
  type SDKResultMessage,
  type SDKSessionStateChangedMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskProgressMessage,
  type SDKTaskStartedMessage,
  type SDKTaskUpdatedMessage,
  type SDKToolProgressMessage,
  type SDKToolUseSummaryMessage,
  type SDKUserMessage,
  type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SessionsService } from '../sessions/sessions.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { TerminalService } from '../terminal/terminal.service.js';
import {
  DRIZZLE,
  type DrizzleDB,
} from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import { getElevenexProxyPort } from '../config/ports.js';
import { getBackendHelperPath, getBackendRuntimeRoot } from '../config/runtime-paths.js';
import {
  ClaudePendingPrompt,
  ClaudePermissionRequest,
  ClaudeAutocompleteItem,
  ClaudeAuthStatus,
  ClaudeApiRetry,
  ClaudeCompactBoundary,
  ClaudeContextUsage,
  ClaudeElicitationCompletion,
  ClaudeFilesPersisted,
  ClaudeHookEvent,
  ClaudeHookExecution,
  ClaudeMemoryRecall,
  ClaudeModelOption,
  ClaudeNotification,
  ClaudeRuntimeEvent,
  ClaudeRuntimeSessionMetadata,
  ClaudeRuntimeStatus,
  ClaudeSessionExecutionState,
  ClaudeRuntimeStatePayload,
  ClaudeRunPhase,
  ClaudeRateLimit,
  ClaudeSessionSnapshotPayload,
  ClaudeSubagentHistoryPayload,
  ClaudeSubagentState,
  ClaudeTaskLifecycle,
  ClaudeTaskState,
  ClaudeTaskUsage,
  ClaudeToolProgress,
  ClaudeToolUseSummary,
  ClaudePluginInstallProgress,
  ClaudeTranscriptItem,
  ClaudeUserInputRequest,
  ClaudeMirrorError,
  ClaudePromptSuggestion,
  ClaudePermissionMode,
  ClaudePermissionUpdate,
  ClaudeToolInteractionAnswer,
  ClaudeToolInteractionKind,
  ClaudeToolInteractionSummary,
} from './claude-runtime.types.js';

type PermissionDecision =
  | { behavior: 'allow'; remember: boolean; content?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };

type UserInputContent = Record<string, string | number | boolean | string[]>;

type UserInputDecision = {
  action: 'accept' | 'decline' | 'cancel';
  content?: UserInputContent;
};

type ToolInteractionRow =
  typeof schema.claudeToolInteractions.$inferSelect;

type HistoryMessage = {
  type: SessionMessage['type'];
  uuid: SessionMessage['uuid'];
  message: SessionMessage['message'];
  timestamp?: string;
  parent_tool_use_id?: string | null;
};

interface ActivePermissionRequest {
  request: ClaudePermissionRequest;
  resolve: (value: PermissionDecision) => void;
  suggestions?: PermissionUpdate[];
}

interface ActiveUserInputRequest {
  request: ClaudeUserInputRequest;
  resolve: (value: UserInputDecision) => void;
}

interface ActiveRunState {
  query: Query;
  interruptRequested: boolean;
  tornDown: boolean;
  permissionRequests: Map<string, ActivePermissionRequest>;
  permissionRequestOrder: string[];
  userInputRequests: Map<string, ActiveUserInputRequest>;
  partialAssistantItems: Map<string, string>;
  partialThinkingItems: Map<string, string>;
  currentStreamMessageId: string | null;
  completionPromise: Promise<void>;
  resolveCompletion: () => void;
  startedAtMs: number;
  runId: string;
  queryCreatedAtMs: number;
  firstSdkMessageAtMs: number | null;
  firstVisibleAtMs: number | null;
  sawFirstSdkMessage: boolean;
  sawFirstVisibleItem: boolean;
  systemSubtypesBeforeVisible: string[];
  observedPreVisibleMarkers: Set<string>;
}

type McpAuthControlQuery = Query & {
  mcpAuthenticate(serverName: string): Promise<{
    authUrl?: string;
    requiresUserAction?: boolean;
  }>;
};

interface ClaudeTranscriptRecord {
  type?: unknown;
  uuid?: unknown;
  messageId?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

interface RuntimeState {
  claudeSessionId: string | null;
  runPhase: ClaudeRunPhase;
  sessionState: ClaudeSessionExecutionState;
  canInterrupt: boolean;
  pendingPermissionRequest: ClaudePermissionRequest | null;
  pendingUserInputRequest: ClaudeUserInputRequest | null;
  pendingPrompts: ClaudePendingPrompt[];
  liveItems: ClaudeTranscriptItem[];
  lastError: string | null;
  selectedModel: string | null;
  selectedPermissionMode: ClaudePermissionMode | null;
  availableModels: ClaudeModelOption[];
  contextUsage: ClaudeContextUsage | null;
  sessionMetadata: ClaudeRuntimeSessionMetadata | null;
  runtimeStatus: ClaudeRuntimeStatus | null;
  authStatus: ClaudeAuthStatus | null;
  rateLimit: ClaudeRateLimit | null;
  notifications: ClaudeNotification[];
  hooks: ClaudeHookExecution[];
  recentHookEvents: ClaudeHookEvent[];
  tasks: ClaudeTaskState[];
  taskLifecycle: ClaudeTaskLifecycle[];
  subagents: ClaudeSubagentState[];
  latestToolProgress: ClaudeToolProgress | null;
  latestToolSummary: ClaudeToolUseSummary | null;
  latestApiRetry: ClaudeApiRetry | null;
  latestPluginInstall: ClaudePluginInstallProgress | null;
  latestMemoryRecall: ClaudeMemoryRecall | null;
  latestFilesPersisted: ClaudeFilesPersisted | null;
  latestElicitationCompletion: ClaudeElicitationCompletion | null;
  latestPromptSuggestion: ClaudePromptSuggestion | null;
  latestCompactBoundary: ClaudeCompactBoundary | null;
  latestMirrorError: ClaudeMirrorError | null;
  metadataRefreshPromise: Promise<void> | null;
  metadataRefreshStartedAtMs: number | null;
  metadataRefreshCompletedAtMs: number | null;
  lastHistoryItemCount: number | null;
  lastHistoryLoadedAtMs: number | null;
  lastHistorySource: 'sdk' | 'transcript' | null;
  transcriptFallbackUsed: boolean;
}

type ClaudeSdkPackageMetadata = {
  version: string;
  claudeCodeVersion?: string;
};

const CLAUDE_SDK_PACKAGE = loadClaudeSdkPackageMetadata();
const WORKTREE_CONTEXT_OPEN = '<elevenex-worktree-context>';
const WORKTREE_CONTEXT_CLOSE = '</elevenex-worktree-context>';
const BUILTIN_COMMANDS: ClaudeAutocompleteItem[] = [
  {
    id: 'builtin:/help',
    kind: 'command',
    trigger: '/',
    label: '/help',
    insertText: '/help ',
    description: 'Show help documentation for Claude Code',
    source: 'builtin',
  },
  {
    id: 'builtin:/clear',
    kind: 'command',
    trigger: '/',
    label: '/clear',
    insertText: '/clear ',
    description: 'Clear the current conversation context',
    source: 'builtin',
  },
  {
    id: 'builtin:/model',
    kind: 'command',
    trigger: '/',
    label: '/model',
    insertText: '/model ',
    description: 'View or switch the active model',
    source: 'builtin',
  },
  {
    id: 'builtin:/cost',
    kind: 'command',
    trigger: '/',
    label: '/cost',
    insertText: '/cost ',
    description: 'Inspect token and cost usage',
    source: 'builtin',
  },
  {
    id: 'builtin:/memory',
    kind: 'command',
    trigger: '/',
    label: '/memory',
    insertText: '/memory ',
    description: 'Open Claude memory for the current project',
    source: 'builtin',
  },
  {
    id: 'builtin:/config',
    kind: 'command',
    trigger: '/',
    label: '/config',
    insertText: '/config ',
    description: 'Inspect Claude configuration and settings',
    source: 'builtin',
  },
  {
    id: 'builtin:/status',
    kind: 'command',
    trigger: '/',
    label: '/status',
    insertText: '/status ',
    description: 'Show Claude Code status and environment details',
    source: 'builtin',
  },
  {
    id: 'builtin:/rewind',
    kind: 'command',
    trigger: '/',
    label: '/rewind',
    insertText: '/rewind ',
    description: 'Rewind to an earlier point in the conversation',
    source: 'builtin',
  },
];
const FALLBACK_MODELS: ClaudeModelOption[] = [
  {
    id: 'sonnet',
    displayName: 'Sonnet',
    description: 'Balanced default model for most coding tasks.',
    supportsEffort: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    id: 'opus',
    displayName: 'Opus',
    description: 'Higher-reasoning model for harder tasks.',
    supportsEffort: true,
  },
  {
    id: 'haiku',
    displayName: 'Haiku',
    description: 'Fast lower-cost model for lighter tasks.',
  },
];
const MAX_RECENT_NOTIFICATIONS = 25;
const MAX_RECENT_HOOKS = 50;
const MAX_RECENT_HOOK_EVENTS = 50;
const MAX_RECENT_TASK_LIFECYCLE = 50;
const MAX_RECENT_SUBAGENTS = 25;

@Injectable()
export class ClaudeRuntimeService extends EventEmitter {
  private readonly logger = new Logger('ClaudeRuntimeService');
  private readonly activeRuns = new Map<number, ActiveRunState>();
  private readonly runtimeStates = new Map<number, RuntimeState>();
  private readonly invalidatedSessions = new Set<number>();
  private readonly wrapperScriptPath = getBackendHelperPath(
    'bin',
    'plannotator-wrapper.sh',
  );
  private readonly claudeCliOverride = this.resolveClaudeCliOverride();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly sessionsService: SessionsService,
    private readonly claudeHooksService: ClaudeHooksService,
    private readonly terminalService: TerminalService,
  ) {
    super();
    this.logClaudeRuntimeConfiguration();

    this.claudeHooksService.on(
      'hook-event',
      (data: {
        sessionId: number;
        payload: Record<string, unknown>;
        timestamp: string;
      }) => {
        this.handleHookEvent(data.sessionId, data.payload, data.timestamp);
      },
    );
  }

  async getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    if (!session.claudeSessionId || session.claudeSessionId === '-1') {
      const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
      this.recordHistorySnapshot(state, [], null);
      return [];
    }

    const interactionsByToolUseId = await this.getInteractionSummaryMap(sessionId);

    try {
      const messages = await getSessionMessages(session.claudeSessionId, {
        dir: session.worktreePath,
      });
      if (messages.length > 0) {
        const normalized = this.normalizeHistory(messages, interactionsByToolUseId);
        this.recordHistorySnapshot(
          this.ensureRuntimeState(sessionId, session.claudeSessionId),
          normalized,
          'sdk',
        );
        return normalized;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load Claude history for session ${sessionId}: ${String(error)}`,
      );
    }

    return this.loadHistoryFromTranscript(
      sessionId,
      session.worktreePath,
      session.claudeSessionId,
      interactionsByToolUseId,
    );
  }

  async getRuntimeState(sessionId: number): Promise<ClaudeRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSubagentHistory(
    sessionId: number,
    agentId: string,
  ): Promise<ClaudeSubagentHistoryPayload> {
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId) {
      throw new BadRequestException('An agentId is required.');
    }

    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    const subagent = state.subagents.find(
      (item) => item.agentId === trimmedAgentId,
    );

    if (!subagent) {
      throw new NotFoundException('Subagent not found for this session.');
    }

    if (!session.claudeSessionId || session.claudeSessionId === '-1') {
      return {
        subagent,
        history: [],
        transcriptAvailable: false,
        transcriptError: 'Claude session is unavailable for this agent.',
      };
    }

    if (!subagent.transcriptPath) {
      return {
        subagent,
        history: [],
        transcriptAvailable: false,
        transcriptError: 'Transcript unavailable for this agent.',
      };
    }

    try {
      return {
        subagent,
        history: this.normalizeHistory(
          await getSubagentMessages(session.claudeSessionId, trimmedAgentId, {
            dir: session.worktreePath,
          }),
          new Map(),
        ),
        transcriptAvailable: true,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load Claude subagent history for session ${sessionId} and agent ${trimmedAgentId}: ${String(error)}`,
      );
      return {
        subagent,
        history: [],
        transcriptAvailable: false,
        transcriptError: 'Could not read the transcript for this agent.',
      };
    }
  }

  async getSnapshot(sessionId: number): Promise<ClaudeSessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);

    return {
      ...runtimeState,
      history,
    };
  }

  async openTerminalFallback(sessionId: number) {
    return this.terminalService.startSession(sessionId);
  }

  async cleanupSession(sessionId: number): Promise<void> {
    this.invalidatedSessions.add(sessionId);
    const run = this.activeRuns.get(sessionId);
    if (run) {
      await this.requestRunTeardown(sessionId, run, { invalidateSession: true });
      await run.completionPromise.catch(() => undefined);
    }
    this.activeRuns.delete(sessionId);
    this.runtimeStates.delete(sessionId);
    this.claudeHooksService.clearStatus(sessionId);
  }

  async rewindConversation(
    sessionId: number,
    messageId: string,
  ): Promise<ClaudeTranscriptItem[]> {
    const trimmedMessageId = messageId.trim();
    if (!trimmedMessageId) {
      throw new BadRequestException('A messageId is required.');
    }

    if (this.activeRuns.has(sessionId)) {
      throw new ConflictException(
        'Cannot edit a message while Claude is actively running.',
      );
    }

    const session = await this.sessionsService.findOne(sessionId);
    if (!session.claudeSessionId || session.claudeSessionId === '-1') {
      throw new NotFoundException('Claude session not found.');
    }

    const transcriptPath = await this.findTranscriptPath(
      session.worktreePath,
      session.claudeSessionId,
    );

    if (!transcriptPath) {
      throw new NotFoundException('Claude transcript not found.');
    }

    const records = await this.loadTranscriptRecords(transcriptPath);
    const targetIndex = records.findIndex(
      (record) =>
        record.type === 'user' && typeof record.uuid === 'string'
        && record.uuid === trimmedMessageId,
    );

    if (targetIndex === -1) {
      if (
        records.some(
          (record) =>
            typeof record.uuid === 'string' && record.uuid === trimmedMessageId,
        )
      ) {
        throw new BadRequestException('Only user messages can be edited.');
      }
      throw new NotFoundException('Message not found in Claude transcript.');
    }

    let truncateFrom = targetIndex;
    const previousRecord = records[targetIndex - 1];
    if (
      previousRecord?.type === 'file-history-snapshot'
      && previousRecord.messageId === trimmedMessageId
    ) {
      truncateFrom -= 1;
    }

    const retainedRecords = records
      .slice(0, truncateFrom)
      .filter((record) => record.type !== 'last-prompt');

    await this.persistTranscriptRecords(transcriptPath, retainedRecords);

    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    this.resetEphemeralRuntimeState(state);
    this.emitRunState(sessionId);
    this.emitEvent({ type: 'complete', payload: { sessionId } });
    void this.claudeHooksService.updateStatus(sessionId, 'idle', {
      markCompletion: false,
    });

    return this.getHistory(sessionId);
  }

  async setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<ClaudeRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    state.selectedModel = model;

    const activeRun = this.activeRuns.get(sessionId);
    if (activeRun) {
      await activeRun.query.setModel(model ?? undefined);
      await this.refreshRuntimeMetadata(sessionId);
      this.emitRunState(sessionId);
    }

    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPermissionMode(
    sessionId: number,
    mode: ClaudePermissionMode | null,
  ): Promise<ClaudeRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    state.selectedPermissionMode = mode;

    if (state.sessionMetadata && mode) {
      state.sessionMetadata = {
        ...state.sessionMetadata,
        permissionMode: mode,
      };
    }

    const activeRun = this.activeRuns.get(sessionId);
    if (activeRun && mode) {
      await activeRun.query.setPermissionMode(mode as PermissionMode);
      this.emitRunState(sessionId);
    }

    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getAutocompleteItems(
    sessionId: number,
  ): Promise<ClaudeAutocompleteItem[]> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    const [commandItems, claudeSkillItems, externalSkillItems] =
      await Promise.all([
        this.collectCommandItems(session.worktreePath),
        this.collectClaudeSkillItems(session.worktreePath),
        this.collectExternalSkillItems(session.worktreePath),
      ]);

    const runtimeItems = this.collectRuntimeAutocompleteItems(state);
    const baseCommandItems =
      runtimeItems.some((item) => item.kind === 'command')
        ? [...runtimeItems, ...BUILTIN_COMMANDS]
        : BUILTIN_COMMANDS;

    const sourceRank: Record<ClaudeAutocompleteItem['source'], number> = {
      builtin: 0,
      runtime: 1,
      project: 2,
      user: 3,
    };
    const kindRank: Record<ClaudeAutocompleteItem['kind'], number> = {
      command: 0,
      skill: 1,
    };

    const seen = new Set<string>();
    const items = [
      ...baseCommandItems,
      ...commandItems,
      ...claudeSkillItems,
      ...externalSkillItems,
    ].filter((item) => {
      const key = `${item.trigger}:${item.label}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return items.sort((left, right) => {
      const kindDelta = kindRank[left.kind] - kindRank[right.kind];
      if (kindDelta !== 0) return kindDelta;
      const sourceDelta = sourceRank[left.source] - sourceRank[right.source];
      if (sourceDelta !== 0) return sourceDelta;
      return left.label.localeCompare(right.label);
    });
  }

  private collectRuntimeAutocompleteItems(
    state: RuntimeState,
  ): ClaudeAutocompleteItem[] {
    const metadata = state.sessionMetadata;
    if (!metadata) {
      return [];
    }

    const commandItems = metadata.slashCommands.map((command) => {
      const normalized = command.startsWith('/') ? command : `/${command}`;
      return {
        id: `runtime:command:${normalized}`,
        kind: 'command' as const,
        trigger: '/' as const,
        label: normalized,
        insertText: `${normalized} `,
        description: 'Available in the active Claude Code session',
        detail: 'Runtime command',
        source: 'runtime' as const,
      };
    });

    const skillItems = metadata.skills.flatMap((skill) => {
      const normalized = skill.replace(/^[/$]+/, '');
      if (!normalized) {
        return [];
      }
      return [
        {
          id: `runtime:skill:slash:${normalized}`,
          kind: 'skill' as const,
          trigger: '/' as const,
          label: `/${normalized}`,
          insertText: `/${normalized} `,
          description: 'Available in the active Claude Code session',
          detail: 'Runtime skill',
          source: 'runtime' as const,
        },
        {
          id: `runtime:skill:dollar:${normalized}`,
          kind: 'skill' as const,
          trigger: '$' as const,
          label: `$${normalized}`,
          insertText: `$${normalized} `,
          description: 'Available in the active Claude Code session',
          detail: 'Runtime skill',
          source: 'runtime' as const,
        },
      ];
    });

    return [...commandItems, ...skillItems];
  }

  async submitPrompt(sessionId: number, prompt: string): Promise<void> {
    const startedAtMs = Date.now();
    const runId = randomUUID().slice(0, 8);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return;
    }

    if (this.activeRuns.has(sessionId)) {
      const existingSession = await this.sessionsService.findOne(sessionId);
      const existingState = this.ensureRuntimeState(
        sessionId,
        existingSession.claudeSessionId,
      );
      existingState.pendingPrompts = [
        ...existingState.pendingPrompts,
        {
          id: randomUUID(),
          prompt: trimmedPrompt,
          queuedAt: new Date().toISOString(),
        },
      ];
      this.emitRunState(sessionId);
      return;
    }

    const session = await this.sessionsService.findOne(sessionId);
    this.logStartupTiming(sessionId, runId, startedAtMs, 'submit_start');
    this.logStartupTiming(sessionId, runId, startedAtMs, 'session_loaded', {
      hasClaudeSessionId:
        Boolean(session.claudeSessionId) && session.claudeSessionId !== '-1',
    });
    const state = this.ensureRuntimeState(sessionId, session.claudeSessionId);
    state.liveItems = [];
    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = null;
    state.lastError = null;
    state.runPhase = 'running';
    state.sessionState = 'running';
    state.canInterrupt = true;
    await this.sessionsService.updateStatus(sessionId, 'active');
    this.logStartupTiming(
      sessionId,
      runId,
      startedAtMs,
      'session_status_marked_active',
    );
    await this.claudeHooksService.updateStatus(sessionId, 'running', {
      markCompletion: false,
    });
    this.logStartupTiming(
      sessionId,
      runId,
      startedAtMs,
      'hook_status_marked_running',
    );
    this.emitRunState(sessionId);

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const requestId = randomUUID();
      const request: ClaudePermissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        agentId: options.agentID,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        suggestions:
          (options.suggestions as ClaudePermissionUpdate[] | undefined) ??
          undefined,
        createdAt: new Date().toISOString(),
      };

      const decisionContext = await new Promise<{
        decision: PermissionDecision;
        suggestions?: PermissionUpdate[];
      }>((resolve) => {
        const run = this.activeRuns.get(sessionId);
        if (!run) {
          resolve({
            decision: { behavior: 'deny', message: 'Session no longer active' },
          });
          return;
        }

        run.permissionRequests.set(requestId, {
          request,
          resolve: (decision) =>
            resolve({
              decision,
              suggestions: options.suggestions,
            }),
          suggestions: options.suggestions,
        });
        run.permissionRequestOrder.push(requestId);
        this.promoteNextPendingPermissionRequest(sessionId, state, run);
      });

      const run = this.activeRuns.get(sessionId);
      run?.permissionRequests.delete(requestId);
      if (run) {
        run.permissionRequestOrder = run.permissionRequestOrder.filter(
          (queuedRequestId) => queuedRequestId !== requestId,
        );
      }
      this.emitEvent({
        type: 'permission_resolved',
        payload: {
          sessionId,
          requestId,
          toolUseId: request.toolUseId,
          decision:
            decisionContext.decision.behavior === 'allow'
              ? decisionContext.decision.remember
                ? 'approved_always'
                : 'approved'
              : 'denied',
          interaction: await this.recordInteractionSummary(
            sessionId,
            request,
            decisionContext.decision,
          ),
        },
      });
      if (run) {
        this.promoteNextPendingPermissionRequest(sessionId, state, run);
      } else {
        state.pendingPermissionRequest = null;
        state.runPhase = 'running';
        state.sessionState = 'running';
        this.emitRunState(sessionId);
        await this.claudeHooksService.updateStatus(sessionId, 'running', {
          markCompletion: false,
        });
      }

      if (decisionContext.decision.behavior === 'allow') {
        return {
          behavior: 'allow',
          updatedInput: {
            ...((input ?? {}) as Record<string, unknown>),
            ...(decisionContext.decision.content ?? {}),
          },
          updatedPermissions:
            decisionContext.decision.remember &&
            decisionContext.suggestions?.length
              ? decisionContext.suggestions
              : undefined,
          toolUseID: options.toolUseID,
        } satisfies PermissionResult;
      }

      return {
        behavior: 'deny',
        message:
          decisionContext.decision.message ?? 'User denied tool execution',
        toolUseID: options.toolUseID,
      } satisfies PermissionResult;
    };

    const onElicitation = async (
      request: ElicitationRequest,
    ): Promise<ElicitationResult> => {
      const requestId = randomUUID();
      const pendingRequest: ClaudeUserInputRequest = {
        requestId,
        serverName: request.serverName,
        message: request.message,
        mode: request.mode,
        url: request.url,
        elicitationId: request.elicitationId,
        requestedSchema: request.requestedSchema,
        title: request.title,
        displayName: request.displayName,
        description: request.description,
        createdAt: new Date().toISOString(),
      };

      return new Promise<ElicitationResult>((resolve) => {
        const run = this.activeRuns.get(sessionId);
        if (!run) {
          resolve({ action: 'decline' });
          return;
        }

        run.userInputRequests.set(requestId, {
          request: pendingRequest,
          resolve: (decision) => resolve(decision),
        });
        state.pendingUserInputRequest = pendingRequest;
        state.runPhase = 'waiting';
        state.sessionState = 'requires_action';
        this.emitEvent({
          type: 'user_input_request',
          payload: { sessionId, request: pendingRequest },
        });
        this.emitRunState(sessionId);
        void this.claudeHooksService.updateStatus(sessionId, 'waiting', {
          markCompletion: false,
        });
      });
    };

    let resolveCompletion = () => {};
    const completionPromise = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });

    const runtimeQuery = query({
      prompt: trimmedPrompt,
      options: this.buildQueryOptions(
        sessionId,
        session.worktreePath,
        session.claudeSessionId,
        state.selectedModel,
        state.selectedPermissionMode,
        canUseTool,
        onElicitation,
      ),
    });
    const queryCreatedAtMs = Date.now();
    const resume = Boolean(session.claudeSessionId) && session.claudeSessionId !== '-1';
    this.logStartupTiming(sessionId, runId, startedAtMs, 'runtime_query_created', {
      resume:
        resume,
      model: state.selectedModel ?? 'default',
      permissionMode: state.selectedPermissionMode ?? 'default',
      claudeBinary:
        this.claudeCliOverride?.path
        ?? this.resolveSdkClaudePath()
        ?? findBinary('claude')
        ?? 'sdk-default',
      historyItems: state.lastHistoryItemCount,
      historySource: state.lastHistorySource,
      historyAgeMs:
        state.lastHistoryLoadedAtMs == null
          ? null
          : startedAtMs - state.lastHistoryLoadedAtMs,
      transcriptFallbackUsed: state.transcriptFallbackUsed,
    });
    if (resume) {
      this.logStartupTiming(sessionId, runId, startedAtMs, 'resume_diagnostics', {
        hasClaudeSessionId: true,
        historyItems: state.lastHistoryItemCount,
        historySource: state.lastHistorySource,
        historyAgeMs:
          state.lastHistoryLoadedAtMs == null
            ? null
            : startedAtMs - state.lastHistoryLoadedAtMs,
        transcriptFallbackUsed: state.transcriptFallbackUsed,
      });
    }

    this.activeRuns.set(sessionId, {
      query: runtimeQuery,
      interruptRequested: false,
      tornDown: false,
      permissionRequests: new Map(),
      permissionRequestOrder: [],
      userInputRequests: new Map(),
      partialAssistantItems: new Map(),
      partialThinkingItems: new Map(),
      currentStreamMessageId: null,
      completionPromise,
      resolveCompletion,
      startedAtMs,
      runId,
      queryCreatedAtMs,
      firstSdkMessageAtMs: null,
      firstVisibleAtMs: null,
      sawFirstSdkMessage: false,
      sawFirstVisibleItem: false,
      systemSubtypesBeforeVisible: [],
      observedPreVisibleMarkers: new Set(),
    });

    this.emitRunState(sessionId);
    void this.refreshRuntimeMetadata(sessionId, {
      reason: 'startup',
      runId,
      startedAtMs,
    })
      .then(() => {
        this.logStartupTiming(
          sessionId,
          runId,
          startedAtMs,
          'initial_metadata_refreshed',
        );
      })
      .catch((error) => {
        this.logger.debug(
          `Claude startup metadata refresh failed session=${sessionId} run=${runId} elapsedMs=${Date.now() - startedAtMs} error=${String(error)}`,
        );
      })
      .finally(() => {
        if (this.invalidatedSessions.has(sessionId)) {
          return;
        }
        this.emitRunState(sessionId);
      });

    try {
      for await (const message of runtimeQuery) {
        await this.handleSdkMessage(sessionId, message);
        if (message.type === 'stream_event') {
          await flushIo();
        }
      }
    } catch (error) {
      const run = this.activeRuns.get(sessionId);
      if (
        run?.interruptRequested
        && (
          this.isIgnorableInterruptedRunError(error)
          || this.invalidatedSessions.has(sessionId)
        )
      ) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      state.runPhase = 'error';
      state.sessionState = 'idle';
      state.canInterrupt = false;
      this.emitEvent({ type: 'error', payload: { sessionId, message } });
      this.emitRunState(sessionId);
      await this.claudeHooksService.updateStatus(sessionId, 'idle', {
        markCompletion: false,
      });
      throw error;
    } finally {
      const run = this.activeRuns.get(sessionId);
      const interrupted = Boolean(run?.interruptRequested);
      try {
        run?.query.close();
      } catch {
        // Ignore duplicate close attempts during teardown.
      }
      this.activeRuns.delete(sessionId);
      state.pendingPermissionRequest = null;
      state.pendingUserInputRequest = null;
      state.canInterrupt = false;
      run?.resolveCompletion();
      if (interrupted) {
        this.finalizeInterruptedRun(sessionId);
      }
      if (
        !interrupted
        && !state.lastError
        && state.pendingPrompts.length > 0
      ) {
        const [next, ...rest] = state.pendingPrompts;
        state.pendingPrompts = rest;
        this.emitRunState(sessionId);
        setImmediate(() => {
          this.submitPrompt(sessionId, next.prompt).catch((err) => {
            this.logger.error(
              `Pending prompt drain failed session=${sessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        });
      }
    }
  }

  async cancelPendingPrompt(sessionId: number, id: string): Promise<void> {
    const state = this.ensureRuntimeState(sessionId);
    const before = state.pendingPrompts.length;
    state.pendingPrompts = state.pendingPrompts.filter((p) => p.id !== id);
    if (state.pendingPrompts.length !== before) {
      this.emitRunState(sessionId);
    }
  }

  async interrupt(sessionId: number): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }

    await this.requestRunTeardown(sessionId, run);
    await run.completionPromise.catch(() => undefined);
    if (this.activeRuns.get(sessionId) === run) {
      this.activeRuns.delete(sessionId);
      this.finalizeInterruptedRun(sessionId);
    }
  }

  async approvePermission(
    sessionId: number,
    requestId: string,
    remember = false,
    content?: Record<string, unknown>,
  ): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    const request = run?.permissionRequests.get(requestId);
    if (!request) {
      return;
    }

    request.resolve({ behavior: 'allow', remember, content });
  }

  async denyPermission(
    sessionId: number,
    requestId: string,
    message?: string,
  ): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    const request = run?.permissionRequests.get(requestId);
    if (!request) {
      return;
    }

    request.resolve({ behavior: 'deny', message });
  }

  private promoteNextPendingPermissionRequest(
    sessionId: number,
    state: RuntimeState,
    run: ActiveRunState,
  ): void {
    const nextRequestId = run.permissionRequestOrder[0];
    if (!nextRequestId) {
      state.pendingPermissionRequest = null;
      state.runPhase = 'running';
      state.sessionState = 'running';
      this.emitRunState(sessionId);
      void this.claudeHooksService.updateStatus(sessionId, 'running', {
        markCompletion: false,
      });
      return;
    }

    const nextPermission = run.permissionRequests.get(nextRequestId);
    if (!nextPermission) {
      run.permissionRequestOrder.shift();
      this.promoteNextPendingPermissionRequest(sessionId, state, run);
      return;
    }

    if (state.pendingPermissionRequest?.requestId === nextPermission.request.requestId) {
      return;
    }

    state.pendingPermissionRequest = nextPermission.request;
    state.runPhase = 'waiting';
    state.sessionState = 'requires_action';
    this.emitEvent({
      type: 'permission_request',
      payload: { sessionId, request: nextPermission.request },
    });
    this.emitRunState(sessionId);
    void this.claudeHooksService.updateStatus(sessionId, 'waiting', {
      markCompletion: false,
    });
  }

  async answerUserInput(
    sessionId: number,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel' = 'accept',
    content?: UserInputContent,
  ): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    const request = run?.userInputRequests.get(requestId);
    if (!request) {
      return;
    }

    run?.userInputRequests.delete(requestId);
    const state = this.ensureRuntimeState(sessionId);
    state.pendingUserInputRequest = null;
    state.runPhase = 'running';
    state.sessionState = 'running';
    this.emitRunState(sessionId);
    request.resolve({ action, content });
  }

  getPendingMcpAuthUrl(sessionId: number, serverName: string): string | null {
    const pendingRequest = this.runtimeStates.get(sessionId)?.pendingUserInputRequest;
    if (
      pendingRequest?.serverName === serverName
      && pendingRequest.mode === 'url'
      && typeof pendingRequest.url === 'string'
      && pendingRequest.url.trim()
    ) {
      return pendingRequest.url;
    }

    return null;
  }

  async startMcpAuthFlow(sessionId: number, serverName: string): Promise<string | null> {
    const pendingUrl = this.getPendingMcpAuthUrl(sessionId, serverName);
    if (pendingUrl) {
      return pendingUrl;
    }

    const session = await this.sessionsService.findOne(sessionId);
    const abortController = new AbortController();
    const runtimeQuery = query({
      prompt: this.createIdlePrompt(abortController.signal),
      options: this.buildMcpAuthQueryOptions(
        sessionId,
        session.worktreePath,
        serverName,
        abortController,
      ),
    }) as McpAuthControlQuery;

    try {
      await withTimeout(
        runtimeQuery.initializationResult(),
        15_000,
        `Timed out initializing Claude Code for MCP auth on "${serverName}".`,
      );
      const result = await withTimeout(
        runtimeQuery.mcpAuthenticate(serverName),
        30_000,
        `Timed out starting MCP auth for "${serverName}".`,
      );

      return typeof result.authUrl === 'string' && result.authUrl.trim()
        ? result.authUrl
        : null;
    } finally {
      abortController.abort();
      runtimeQuery.close();
    }
  }

  private async handleSdkMessage(
    sessionId: number,
    message: SDKMessage,
  ): Promise<void> {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const run = this.activeRuns.get(sessionId);
    if (run?.interruptRequested) {
      return;
    }

    if (run && !run.sawFirstSdkMessage) {
      run.sawFirstSdkMessage = true;
      run.firstSdkMessageAtMs = Date.now();
      const details =
        message.type === 'system'
          ? { subtype: message.subtype }
          : undefined;
      this.logStartupTiming(
        sessionId,
        run.runId,
        run.startedAtMs,
        `first_sdk_message:${message.type}`,
        details,
      );
    }

    if (run && !run.sawFirstVisibleItem) {
      this.logPreVisibleMessage(sessionId, run, message);
    }

    await this.captureClaudeSessionId(sessionId, message);
    this.logSdkMessageDiagnostics(sessionId, message);

    if (message.type === 'stream_event') {
      this.handlePartialAssistantMessage(sessionId, message);
      return;
    }

    if (message.type === 'assistant') {
      this.handleAssistantMessage(sessionId, message);
      return;
    }

    if (message.type === 'user') {
      this.handleUserMessage(sessionId, message);
      return;
    }

    if (message.type === 'result') {
      this.handleResultMessage(sessionId, message);
      return;
    }

    if (message.type === 'tool_progress') {
      this.handleToolProgressMessage(sessionId, message);
      return;
    }

    if (message.type === 'tool_use_summary') {
      this.handleToolUseSummaryMessage(sessionId, message);
      return;
    }

    if (message.type === 'auth_status') {
      this.handleAuthStatusMessage(sessionId, message);
      return;
    }

    if (message.type === 'rate_limit_event') {
      this.handleRateLimitEvent(sessionId, message);
      return;
    }

    if (message.type === 'prompt_suggestion') {
      this.handlePromptSuggestionMessage(sessionId, message);
      return;
    }

    if (message.type === 'system') {
      this.handleSystemMessage(sessionId, message);
      return;
    }

    await this.refreshRuntimeMetadata(sessionId);
    this.emitRunState(sessionId);
  }

  private handlePartialAssistantMessage(
    sessionId: number,
    message: SDKPartialAssistantMessage,
  ): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }

    const event = message.event as Record<string, any>;
    if (event.type === 'message_start') {
      const streamedMessageId = event.message?.id;
      if (typeof streamedMessageId === 'string' && streamedMessageId) {
        run.currentStreamMessageId = streamedMessageId;
      }
      return;
    }

    if (event.type === 'message_stop') {
      run.partialAssistantItems.clear();
      run.partialThinkingItems.clear();
      run.currentStreamMessageId = null;
      return;
    }

    const streamMessageId = run.currentStreamMessageId ?? message.uuid;
    const blockKey = `${streamMessageId}:${String(event.index ?? 0)}`;
    const receivedAt = this.resolveMessageTimestamp(message);

    if (event.type === 'content_block_start') {
      const contentBlock = event.content_block as Record<string, any>;
      if (contentBlock?.type === 'text') {
        const item: ClaudeTranscriptItem = {
          id: blockKey,
          kind: 'assistant',
          content: '',
          sourceMessageId: streamMessageId,
          timestamp: receivedAt,
          receivedAt,
        };
        run.partialAssistantItems.set(blockKey, item.id);
        this.pushItem(sessionId, item, 'message_start');
      } else if (contentBlock?.type === 'thinking') {
        const item: ClaudeTranscriptItem = {
          id: blockKey,
          kind: 'thinking',
          content: '',
          sourceMessageId: streamMessageId,
          timestamp: receivedAt,
          receivedAt,
        };
        run.partialThinkingItems.set(blockKey, item.id);
        this.pushItem(sessionId, item, 'thinking_start');
      }
      return;
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, any>;
      if (delta?.type === 'text_delta') {
        const itemId = run.partialAssistantItems.get(blockKey);
        if (itemId && delta.text) {
          this.appendDelta(sessionId, itemId, delta.text, 'message_delta');
        } else if (delta.text) {
          this.logger.debug(
            `Claude stream delta dropped session=${sessionId} blockKey=${blockKey} reason=missing_assistant_item`,
          );
        }
      } else if (delta?.type === 'thinking_delta') {
        const itemId = run.partialThinkingItems.get(blockKey);
        if (itemId && delta.thinking) {
          this.appendDelta(sessionId, itemId, delta.thinking, 'thinking_delta');
        } else if (delta.thinking) {
          this.logger.debug(
            `Claude stream delta dropped session=${sessionId} blockKey=${blockKey} reason=missing_thinking_item`,
          );
        }
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      const assistantItemId = run.partialAssistantItems.get(blockKey);
      if (assistantItemId) {
        this.emitEvent({
          type: 'message_complete',
          payload: { sessionId, itemId: assistantItemId },
        });
      }

      const thinkingItemId = run.partialThinkingItems.get(blockKey);
      if (thinkingItemId) {
        this.emitEvent({
          type: 'thinking_complete',
          payload: { sessionId, itemId: thinkingItemId },
        });
      }
    }
  }

  private handleAssistantMessage(
    sessionId: number,
    message: SDKAssistantMessage,
  ): void {
    const content = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    const run = this.activeRuns.get(sessionId);
    const receivedAt = this.resolveMessageTimestamp(message);
    const streamMessageId = message.message.id ?? run?.currentStreamMessageId ?? message.uuid;
    let assistantPartOrdinal = 0;
    let thinkingPartOrdinal = 0;
    for (const [partIndex, part] of (
      content as Array<Record<string, any>>
    ).entries()) {
      if (part.type === 'text' && typeof part.text === 'string') {
        const partialKey = this.resolvePartialContentBlockKey(
          run,
          'assistant',
          streamMessageId,
          partIndex,
          assistantPartOrdinal,
        );
        const partialId = partialKey
          ? run?.partialAssistantItems.get(partialKey)
          : undefined;
        if (partialId && partialKey) {
          const item = this.findLiveItem(sessionId, partialId);
          if (item && item.content !== part.text) {
            const suffix = part.text.slice(item.content?.length ?? 0);
            if (suffix) {
              this.appendDelta(sessionId, partialId, suffix, 'message_delta');
            }
          }
          run?.partialAssistantItems.delete(partialKey);
          this.emitEvent({
            type: 'message_complete',
            payload: { sessionId, itemId: partialId },
          });
        } else {
          const item: ClaudeTranscriptItem = {
            id: `${message.uuid}:text:${partIndex}`,
            kind: 'assistant',
            content: part.text,
            parentToolUseId: message.parent_tool_use_id ?? undefined,
            sourceMessageId: streamMessageId,
            timestamp: receivedAt,
            receivedAt,
          };
          this.pushItem(sessionId, item, 'message_start');
          this.emitEvent({
            type: 'message_complete',
            payload: { sessionId, itemId: item.id },
          });
        }
        assistantPartOrdinal += 1;
      } else if (
        part.type === 'thinking' &&
        typeof part.thinking === 'string'
      ) {
        const partialKey = this.resolvePartialContentBlockKey(
          run,
          'thinking',
          streamMessageId,
          partIndex,
          thinkingPartOrdinal,
        );
        const partialId = partialKey
          ? run?.partialThinkingItems.get(partialKey)
          : undefined;
        if (partialId && partialKey) {
          const item = this.findLiveItem(sessionId, partialId);
          if (item && item.content !== part.thinking) {
            const suffix = part.thinking.slice(item.content?.length ?? 0);
            if (suffix) {
              this.appendDelta(sessionId, partialId, suffix, 'thinking_delta');
            }
          }
          run?.partialThinkingItems.delete(partialKey);
          this.emitEvent({
            type: 'thinking_complete',
            payload: { sessionId, itemId: partialId },
          });
        } else {
          const item: ClaudeTranscriptItem = {
            id: `${message.uuid}:thinking:${partIndex}`,
            kind: 'thinking',
            content: part.thinking,
            parentToolUseId: message.parent_tool_use_id ?? undefined,
            sourceMessageId: streamMessageId,
            timestamp: receivedAt,
            receivedAt,
          };
          this.pushItem(sessionId, item, 'thinking_start');
          this.emitEvent({
            type: 'thinking_complete',
            payload: { sessionId, itemId: item.id },
          });
        }
        thinkingPartOrdinal += 1;
      } else if (part.type === 'tool_use') {
        const item: ClaudeTranscriptItem = {
          id: `${message.uuid}:tool:${part.id}`,
          kind: 'tool_use',
          toolUseId: part.id,
          parentToolUseId: message.parent_tool_use_id ?? undefined,
          toolName: part.name,
          toolInput: part.input,
          sourceMessageId: streamMessageId,
          timestamp: receivedAt,
          receivedAt,
        };
        this.pushItem(sessionId, item, 'tool_use');
      }
    }
  }

  private handleUserMessage(sessionId: number, message: SDKUserMessage): void {
    const content = Array.isArray(message.message.content)
      ? message.message.content
      : [];
    const authoredAt = this.resolveMessageTimestamp(message);

    for (const [partIndex, part] of (
      content as Array<Record<string, any>>
    ).entries()) {
      if (part.type === 'tool_result') {
        const item: ClaudeTranscriptItem = {
          id: `${message.uuid ?? randomUUID()}:tool_result:${part.tool_use_id ?? partIndex}`,
          kind: 'tool_result',
          toolUseId: part.tool_use_id,
          parentToolUseId: message.parent_tool_use_id ?? undefined,
          content: serializeToolResultContent(part.content),
          isError: Boolean(part.is_error),
          timestamp: authoredAt,
          authoredAt,
        };
        this.pushItem(sessionId, item, 'tool_result');
      }
    }
  }

  private handleResultMessage(
    sessionId: number,
    message: SDKResultMessage,
  ): void {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const run = this.activeRuns.get(sessionId);
    if (run?.interruptRequested) {
      return;
    }

    const state = this.ensureRuntimeState(sessionId);
    if (message.is_error) {
      const errorMessage =
        ('errors' in message ? message.errors.join('\n') : '') ||
        'Claude run failed';
      state.lastError = errorMessage;
      this.emitEvent({
        type: 'error',
        payload: { sessionId, message: errorMessage },
      });
    }

    state.sessionState = 'idle';
    this.finishRun(sessionId);
  }

  private handleSystemMessage(
    sessionId: number,
    message: SDKMessage & { type: 'system' },
  ): void {
    switch (message.subtype) {
      case 'init':
        this.handleSessionInitMessage(sessionId, message);
        return;
      case 'status':
        this.handleStatusMessage(sessionId, message);
        return;
      case 'session_state_changed':
        this.handleSessionStateChangedMessage(sessionId, message);
        return;
      case 'notification':
        this.handleNotificationMessage(sessionId, message);
        return;
      case 'api_retry':
        this.handleApiRetryMessage(sessionId, message);
        return;
      case 'plugin_install':
        this.handlePluginInstallMessage(sessionId, message);
        return;
      case 'hook_started':
        this.handleHookStartedMessage(sessionId, message);
        return;
      case 'hook_progress':
        this.handleHookProgressMessage(sessionId, message);
        return;
      case 'hook_response':
        this.handleHookResponseMessage(sessionId, message);
        return;
      case 'task_started':
        this.handleTaskStartedMessage(sessionId, message);
        return;
      case 'task_updated':
        this.handleTaskUpdatedMessage(sessionId, message);
        return;
      case 'task_progress':
        this.handleTaskProgressMessage(sessionId, message);
        return;
      case 'task_notification':
        this.handleTaskNotificationMessage(sessionId, message);
        return;
      case 'files_persisted':
        this.handleFilesPersistedEvent(sessionId, message);
        return;
      case 'memory_recall':
        this.handleMemoryRecallMessage(sessionId, message);
        return;
      case 'elicitation_complete':
        this.handleElicitationCompleteMessage(sessionId, message);
        return;
      case 'compact_boundary':
        this.handleCompactBoundaryMessage(sessionId, message);
        return;
      case 'mirror_error':
        this.handleMirrorErrorMessage(sessionId, message);
        return;
      case 'local_command_output':
        this.pushItem(sessionId, {
          id: message.uuid,
          kind: 'system',
          content: message.content,
          timestamp: new Date().toISOString(),
        });
        return;
      default:
        void this.refreshRuntimeMetadata(sessionId).finally(() => {
          this.emitRunState(sessionId);
        });
    }
  }

  private handleSessionInitMessage(
    sessionId: number,
    message: SDKSystemMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const metadata: ClaudeRuntimeSessionMetadata = {
      cwd: message.cwd,
      model: message.model,
      permissionMode: message.permissionMode,
      claudeCodeVersion: message.claude_code_version,
      outputStyle: message.output_style,
      apiKeySource: String(message.apiKeySource),
      tools: [...message.tools],
      slashCommands: [...message.slash_commands],
      skills: [...message.skills],
      agents: [...(message.agents ?? [])],
      fastModeState: message.fast_mode_state ?? null,
      mcpServers: message.mcp_servers.map((server) => ({
        name: server.name,
        status: server.status,
      })),
      plugins: message.plugins.map((plugin) => ({
        name: plugin.name,
        path: plugin.path,
      })),
    };

    state.sessionMetadata = metadata;
    state.selectedModel = metadata.model || state.selectedModel;
    this.emitEvent({
      type: 'session_metadata',
      payload: { sessionId, metadata },
    });
    this.emitRunState(sessionId);
  }

  private handleStatusMessage(
    sessionId: number,
    message: SDKStatusMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const runtimeStatus: ClaudeRuntimeStatus = {
      status: message.status,
      permissionMode: message.permissionMode,
      compactResult: message.compact_result,
      compactError: message.compact_error,
    };

    state.runtimeStatus = runtimeStatus;
    if (message.permissionMode && state.sessionMetadata) {
      state.sessionMetadata = {
        ...state.sessionMetadata,
        permissionMode: message.permissionMode,
      };
    }

    this.emitEvent({
      type: 'runtime_status',
      payload: { sessionId, status: runtimeStatus },
    });
    this.emitRunState(sessionId);
  }

  private handleSessionStateChangedMessage(
    sessionId: number,
    message: SDKSessionStateChangedMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.sessionState = message.state;
    if (state.runPhase !== 'error') {
      state.runPhase =
        message.state === 'requires_action'
          ? 'waiting'
          : message.state === 'running'
            ? 'running'
            : 'idle';
    }
    this.emitRunState(sessionId);
  }

  private handleNotificationMessage(
    sessionId: number,
    message: SDKNotificationMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const notification: ClaudeNotification = {
      key: message.key,
      text: message.text,
      priority: message.priority,
      color: message.color,
      timeoutMs: message.timeout_ms,
      timestamp: new Date().toISOString(),
    };

    state.notifications = this.appendRecent(
      state.notifications,
      notification,
      MAX_RECENT_NOTIFICATIONS,
    );
    this.emitEvent({
      type: 'notification',
      payload: { sessionId, notification },
    });
  }

  private handleApiRetryMessage(
    sessionId: number,
    message: SDKAPIRetryMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const retry: ClaudeApiRetry = {
      attempt: message.attempt,
      maxRetries: message.max_retries,
      retryDelayMs: message.retry_delay_ms,
      errorStatus: message.error_status,
      error: message.error,
      timestamp: new Date().toISOString(),
    };
    state.latestApiRetry = retry;
    this.emitEvent({
      type: 'api_retry',
      payload: { sessionId, retry },
    });
  }

  private handlePluginInstallMessage(
    sessionId: number,
    message: SDKPluginInstallMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const progress: ClaudePluginInstallProgress = {
      status: message.status,
      name: message.name,
      error: message.error,
      timestamp: new Date().toISOString(),
    };
    state.latestPluginInstall = progress;
    this.emitEvent({
      type: 'plugin_install',
      payload: { sessionId, progress },
    });
  }

  private handleHookStartedMessage(
    sessionId: number,
    message: SDKHookStartedMessage,
  ): void {
    const startedAt = new Date().toISOString();
    const hook = this.upsertHookExecution(sessionId, {
      hookId: message.hook_id,
      hookName: message.hook_name,
      hookEvent: message.hook_event,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
    });
    this.logger.log(
      `Claude hook started session=${sessionId} hookId=${message.hook_id} hookName=${message.hook_name} hookEvent=${message.hook_event}${this.formatHookMessageDetails(message as Record<string, unknown>)}`,
    );
    this.emitEvent({ type: 'hook_started', payload: { sessionId, hook } });
  }

  private handleHookProgressMessage(
    sessionId: number,
    message: SDKHookProgressMessage,
  ): void {
    const updatedAt = new Date().toISOString();
    const hook = this.upsertHookExecution(sessionId, {
      hookId: message.hook_id,
      hookName: message.hook_name,
      hookEvent: message.hook_event,
      status: 'running',
      output: message.output,
      stdout: message.stdout,
      stderr: message.stderr,
      updatedAt,
    });
    this.logger.log(
      `Claude hook progress session=${sessionId} hookId=${message.hook_id} hookName=${message.hook_name} hookEvent=${message.hook_event} elapsedMs=${this.computeHookElapsedMs(hook, updatedAt)} outputBytes=${this.byteLength(message.output)} stdoutBytes=${this.byteLength(message.stdout)} stderrBytes=${this.byteLength(message.stderr)}${this.formatHookMessageDetails(message as Record<string, unknown>)}`,
    );
    this.emitEvent({ type: 'hook_progress', payload: { sessionId, hook } });
  }

  private handleHookResponseMessage(
    sessionId: number,
    message: SDKHookResponseMessage,
  ): void {
    const updatedAt = new Date().toISOString();
    const hook = this.upsertHookExecution(sessionId, {
      hookId: message.hook_id,
      hookName: message.hook_name,
      hookEvent: message.hook_event,
      status: message.outcome,
      output: message.output,
      stdout: message.stdout,
      stderr: message.stderr,
      exitCode: message.exit_code,
      updatedAt,
    });
    this.logger.log(
      `Claude hook completed session=${sessionId} hookId=${message.hook_id} hookName=${message.hook_name} hookEvent=${message.hook_event} outcome=${message.outcome} exitCode=${String(message.exit_code ?? 'null')} elapsedMs=${this.computeHookElapsedMs(hook, updatedAt)} outputBytes=${this.byteLength(message.output)} stdoutBytes=${this.byteLength(message.stdout)} stderrBytes=${this.byteLength(message.stderr)}${this.formatHookMessageDetails(message as Record<string, unknown>)}`,
    );
    this.emitEvent({ type: 'hook_complete', payload: { sessionId, hook } });
  }

  private handleTaskStartedMessage(
    sessionId: number,
    message: SDKTaskStartedMessage,
  ): void {
    const task = this.upsertTask(sessionId, {
      taskId: message.task_id,
      status: 'running',
      description: message.description,
      taskType: message.task_type,
      workflowName: message.workflow_name,
      toolUseId: message.tool_use_id,
      prompt: message.prompt,
      skipTranscript: message.skip_transcript,
      updatedAt: new Date().toISOString(),
    });
    this.emitEvent({ type: 'task_started', payload: { sessionId, task } });
  }

  private handleTaskUpdatedMessage(
    sessionId: number,
    message: SDKTaskUpdatedMessage,
  ): void {
    const task = this.upsertTask(sessionId, {
      taskId: message.task_id,
      status: message.patch.status ?? 'running',
      description: message.patch.description,
      endTime: message.patch.end_time,
      totalPausedMs: message.patch.total_paused_ms,
      error: message.patch.error,
      isBackgrounded: message.patch.is_backgrounded,
      updatedAt: new Date().toISOString(),
    });
    this.emitEvent({ type: 'task_updated', payload: { sessionId, task } });
  }

  private handleTaskProgressMessage(
    sessionId: number,
    message: SDKTaskProgressMessage,
  ): void {
    const task = this.upsertTask(sessionId, {
      taskId: message.task_id,
      status: 'running',
      description: message.description,
      toolUseId: message.tool_use_id,
      usage: this.toTaskUsage(message.usage),
      lastToolName: message.last_tool_name,
      summary: message.summary,
      updatedAt: new Date().toISOString(),
    });
    this.emitEvent({ type: 'task_progress', payload: { sessionId, task } });
  }

  private handleTaskNotificationMessage(
    sessionId: number,
    message: SDKTaskNotificationMessage,
  ): void {
    const task = this.upsertTask(sessionId, {
      taskId: message.task_id,
      status: message.status,
      toolUseId: message.tool_use_id,
      outputFile: message.output_file,
      summary: message.summary,
      usage: message.usage ? this.toTaskUsage(message.usage) : undefined,
      skipTranscript: message.skip_transcript,
      updatedAt: new Date().toISOString(),
    });
    this.emitEvent({ type: 'task_notification', payload: { sessionId, task } });
  }

  private handleToolProgressMessage(
    sessionId: number,
    message: SDKToolProgressMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const progress: ClaudeToolProgress = {
      toolUseId: message.tool_use_id,
      toolName: message.tool_name,
      parentToolUseId: message.parent_tool_use_id,
      elapsedTimeSeconds: message.elapsed_time_seconds,
      taskId: message.task_id,
      timestamp: new Date().toISOString(),
    };
    state.latestToolProgress = progress;
    this.emitEvent({
      type: 'tool_progress',
      payload: { sessionId, progress },
    });
  }

  private handleToolUseSummaryMessage(
    sessionId: number,
    message: SDKToolUseSummaryMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const summary: ClaudeToolUseSummary = {
      summary: message.summary,
      precedingToolUseIds: [...message.preceding_tool_use_ids],
      timestamp: new Date().toISOString(),
    };
    state.latestToolSummary = summary;
    this.emitEvent({
      type: 'tool_summary',
      payload: { sessionId, summary },
    });
  }

  private handleAuthStatusMessage(
    sessionId: number,
    message: SDKAuthStatusMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const status: ClaudeAuthStatus = {
      isAuthenticating: message.isAuthenticating,
      output: [...message.output],
      error: message.error,
    };
    state.authStatus = status;
    this.emitEvent({
      type: 'auth_status',
      payload: { sessionId, status },
    });
  }

  private handleRateLimitEvent(
    sessionId: number,
    message: SDKRateLimitEvent,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const rateLimit: ClaudeRateLimit = {
      status: message.rate_limit_info.status,
      resetsAt: message.rate_limit_info.resetsAt,
      rateLimitType: message.rate_limit_info.rateLimitType,
      utilization: message.rate_limit_info.utilization,
      overageStatus: message.rate_limit_info.overageStatus,
      overageResetsAt: message.rate_limit_info.overageResetsAt,
      overageDisabledReason: message.rate_limit_info.overageDisabledReason,
      isUsingOverage: message.rate_limit_info.isUsingOverage,
      surpassedThreshold: message.rate_limit_info.surpassedThreshold,
    };
    state.rateLimit = rateLimit;
    this.emitEvent({
      type: 'rate_limit',
      payload: { sessionId, rateLimit },
    });
  }

  private handleFilesPersistedEvent(
    sessionId: number,
    message: SDKFilesPersistedEvent,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const files: ClaudeFilesPersisted = {
      files: message.files.map((file) => ({
        filename: file.filename,
        fileId: file.file_id,
      })),
      failed: message.failed.map((file) => ({
        filename: file.filename,
        error: file.error,
      })),
      processedAt: message.processed_at,
      timestamp: new Date().toISOString(),
    };
    state.latestFilesPersisted = files;
    this.emitEvent({
      type: 'files_persisted',
      payload: { sessionId, files },
    });
  }

  private handleMemoryRecallMessage(
    sessionId: number,
    message: SDKMemoryRecallMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const recall: ClaudeMemoryRecall = {
      mode: message.mode,
      memories: message.memories.map((memory) => ({
        path: memory.path,
        scope: memory.scope,
        content: memory.content,
      })),
      timestamp: new Date().toISOString(),
    };
    state.latestMemoryRecall = recall;
    this.emitEvent({
      type: 'memory_recall',
      payload: { sessionId, recall },
    });
  }

  private handleElicitationCompleteMessage(
    sessionId: number,
    message: SDKElicitationCompleteMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const completion: ClaudeElicitationCompletion = {
      serverName: message.mcp_server_name,
      elicitationId: message.elicitation_id,
      timestamp: new Date().toISOString(),
    };
    state.latestElicitationCompletion = completion;
    this.emitEvent({
      type: 'elicitation_complete',
      payload: { sessionId, completion },
    });
  }

  private handlePromptSuggestionMessage(
    sessionId: number,
    message: SDKPromptSuggestionMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const suggestion: ClaudePromptSuggestion = {
      suggestion: message.suggestion,
      timestamp: new Date().toISOString(),
    };
    state.latestPromptSuggestion = suggestion;
    this.emitEvent({
      type: 'prompt_suggestion',
      payload: { sessionId, suggestion },
    });
  }

  private handleCompactBoundaryMessage(
    sessionId: number,
    message: SDKCompactBoundaryMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const boundary: ClaudeCompactBoundary = {
      trigger: message.compact_metadata.trigger,
      preTokens: message.compact_metadata.pre_tokens,
      postTokens: message.compact_metadata.post_tokens,
      durationMs: message.compact_metadata.duration_ms,
      preservedSegment: message.compact_metadata.preserved_segment
        ? {
            headUuid: message.compact_metadata.preserved_segment.head_uuid,
            anchorUuid: message.compact_metadata.preserved_segment.anchor_uuid,
            tailUuid: message.compact_metadata.preserved_segment.tail_uuid,
          }
        : undefined,
      timestamp: new Date().toISOString(),
    };
    state.latestCompactBoundary = boundary;
    this.emitEvent({
      type: 'compact_boundary',
      payload: { sessionId, boundary },
    });
  }

  private handleMirrorErrorMessage(
    sessionId: number,
    message: SDKMirrorErrorMessage,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const error: ClaudeMirrorError = {
      error: message.error,
      key: {
        projectKey: message.key.projectKey,
        sessionId: message.key.sessionId,
        subpath: message.key.subpath,
      },
      timestamp: new Date().toISOString(),
    };
    state.latestMirrorError = error;
    this.emitEvent({
      type: 'mirror_error',
      payload: { sessionId, error },
    });
  }

  private handleHookEvent(
    sessionId: number,
    payload: Record<string, unknown>,
    timestamp: string,
  ): void {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const state = this.ensureRuntimeState(sessionId);
    const hookEventName =
      typeof payload['hook_event_name'] === 'string'
        ? payload['hook_event_name']
        : null;
    if (!hookEventName) {
      return;
    }

    const hookEvent: ClaudeHookEvent = {
      eventName: hookEventName,
      claudeSessionId:
        typeof payload['session_id'] === 'string'
          ? payload['session_id']
          : undefined,
      cwd: typeof payload['cwd'] === 'string' ? payload['cwd'] : undefined,
      permissionMode:
        typeof payload['permission_mode'] === 'string'
          ? payload['permission_mode']
          : undefined,
      agentId:
        typeof payload['agent_id'] === 'string'
          ? payload['agent_id']
          : undefined,
      agentType:
        typeof payload['agent_type'] === 'string'
          ? payload['agent_type']
          : undefined,
      timestamp,
      raw: payload,
    };

    state.recentHookEvents = this.appendRecent(
      state.recentHookEvents,
      hookEvent,
      MAX_RECENT_HOOK_EVENTS,
    );
    this.emitEvent({
      type: 'hook_event',
      payload: { sessionId, hookEvent },
    });

    if (
      hookEvent.claudeSessionId &&
      state.claudeSessionId !== hookEvent.claudeSessionId
    ) {
      state.claudeSessionId = hookEvent.claudeSessionId;
    }

    if (hookEventName === 'SubagentStart' || hookEventName === 'SubagentStop') {
      const agentId =
        typeof payload['agent_id'] === 'string' ? payload['agent_id'] : null;
      const agentType =
        typeof payload['agent_type'] === 'string'
          ? payload['agent_type']
          : null;
      if (agentId && agentType) {
        const subagent: ClaudeSubagentState = {
          agentId,
          agentType,
          status: hookEventName === 'SubagentStart' ? 'started' : 'stopped',
          transcriptPath:
            typeof payload['agent_transcript_path'] === 'string'
              ? payload['agent_transcript_path']
              : undefined,
          stopHookActive:
            typeof payload['stop_hook_active'] === 'boolean'
              ? payload['stop_hook_active']
              : undefined,
          lastAssistantMessage:
            typeof payload['last_assistant_message'] === 'string'
              ? payload['last_assistant_message']
              : undefined,
          timestamp,
        };
        state.subagents = this.upsertRecentSubagent(state.subagents, subagent);
        this.emitEvent({
          type: 'subagent_lifecycle',
          payload: { sessionId, subagent },
        });
      }
    }

    if (hookEventName === 'TaskCreated' || hookEventName === 'TaskCompleted') {
      const taskId =
        typeof payload['task_id'] === 'string' ? payload['task_id'] : null;
      const subject =
        typeof payload['task_subject'] === 'string'
          ? payload['task_subject']
          : null;
      if (taskId && subject) {
        const lifecycle: ClaudeTaskLifecycle = {
          taskId,
          event: hookEventName === 'TaskCreated' ? 'created' : 'completed',
          subject,
          description:
            typeof payload['task_description'] === 'string'
              ? payload['task_description']
              : undefined,
          teammateName:
            typeof payload['teammate_name'] === 'string'
              ? payload['teammate_name']
              : undefined,
          teamName:
            typeof payload['team_name'] === 'string'
              ? payload['team_name']
              : undefined,
          timestamp,
        };
        state.taskLifecycle = this.appendRecent(
          state.taskLifecycle,
          lifecycle,
          MAX_RECENT_TASK_LIFECYCLE,
        );
        this.upsertTask(sessionId, {
          taskId,
          status: hookEventName === 'TaskCreated' ? 'pending' : 'completed',
          subject,
          description: lifecycle.description,
          teammateName: lifecycle.teammateName,
          teamName: lifecycle.teamName,
          updatedAt: timestamp,
        });
        this.emitEvent({
          type: 'task_lifecycle',
          payload: { sessionId, taskLifecycle: lifecycle },
        });
      }
    }
  }

  private async captureClaudeSessionId(
    sessionId: number,
    message: SDKMessage,
  ): Promise<void> {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const claudeSessionId = 'session_id' in message ? message.session_id : null;
    if (!claudeSessionId) {
      return;
    }

    const state = this.ensureRuntimeState(sessionId);
    if (state.claudeSessionId === claudeSessionId) {
      return;
    }

    state.claudeSessionId = claudeSessionId;
    await this.sessionsService.updateClaudeSessionId(sessionId, claudeSessionId);
    this.emitEvent({
      type: 'session_created',
      payload: { sessionId, claudeSessionId },
    });
  }

  private finishRun(sessionId: number): void {
    if (this.invalidatedSessions.has(sessionId)) {
      this.activeRuns.delete(sessionId);
      return;
    }

    const run = this.activeRuns.get(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = state.lastError ? 'error' : 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = null;
    state.liveItems = [];
    run?.permissionRequests.clear();
    if (run) {
      run.permissionRequestOrder = [];
    }
    if (run) {
      this.logStartupTiming(sessionId, run.runId, run.startedAtMs, 'run_complete', {
        hadError: Boolean(state.lastError),
      });
    }
    void this.refreshRuntimeMetadata(sessionId, {
      reason: 'finish_run',
      runId: run?.runId,
      startedAtMs: run?.startedAtMs,
    })
      .catch(() => undefined)
      .finally(() => {
        this.emitRunState(sessionId);
        this.emitEvent({ type: 'complete', payload: { sessionId } });
        void this.claudeHooksService.updateStatus(sessionId, 'idle');
      });
  }

  private finalizeInterruptedRun(sessionId: number): void {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const run = this.activeRuns.get(sessionId);
    const state = this.ensureRuntimeState(sessionId);
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = null;
    state.liveItems = [];
    state.lastError = null;
    run?.permissionRequests.clear();
    if (run) {
      run.permissionRequestOrder = [];
    }
    void this.refreshRuntimeMetadata(sessionId, {
      reason: 'interrupt_finalize',
    })
      .catch(() => undefined)
      .finally(() => {
        this.emitRunState(sessionId);
        void this.claudeHooksService.updateStatus(sessionId, 'idle', {
          markCompletion: false,
        });
      });
  }

  private isIgnorableInterruptedRunError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    return (
      normalized.includes('request was aborted')
      || normalized.includes('aborted')
      || normalized.includes('fetchrequestcanceledexception')
      || (
        normalized.includes('/v1/messages/count_tokens')
        && normalized.includes('unknown compliance rule')
      )
    );
  }

  private ensureRuntimeState(
    sessionId: number,
    claudeSessionId?: string | null,
  ): RuntimeState {
    const existing = this.runtimeStates.get(sessionId);
    if (existing) {
      if (claudeSessionId && claudeSessionId !== '-1') {
        existing.claudeSessionId = claudeSessionId;
      }
      return existing;
    }

    const state: RuntimeState = {
      claudeSessionId:
        claudeSessionId && claudeSessionId !== '-1' ? claudeSessionId : null,
      runPhase: 'idle',
      sessionState: 'idle',
      canInterrupt: false,
      pendingPermissionRequest: null,
      pendingUserInputRequest: null,
      pendingPrompts: [],
      liveItems: [],
      lastError: null,
      selectedModel: null,
      selectedPermissionMode: 'auto',
      availableModels: [...FALLBACK_MODELS],
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
      metadataRefreshPromise: null,
      metadataRefreshStartedAtMs: null,
      metadataRefreshCompletedAtMs: null,
      lastHistoryItemCount: null,
      lastHistoryLoadedAtMs: null,
      lastHistorySource: null,
      transcriptFallbackUsed: false,
    };
    this.runtimeStates.set(sessionId, state);
    return state;
  }

  private emitRunState(sessionId: number): void {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

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
        permissionMode: state.sessionMetadata?.permissionMode ?? state.selectedPermissionMode ?? null,
        availableModels: state.availableModels,
        contextUsage: state.contextUsage,
        pendingPrompts: state.pendingPrompts,
      },
    });
  }

  private emitEvent(event: ClaudeRuntimeEvent): void {
    this.emit('event', event);
  }

  private logStartupTiming(
    sessionId: number,
    runId: string,
    startedAtMs: number,
    stage: string,
    details?: Record<string, unknown>,
  ): void {
    const elapsedMs = Date.now() - startedAtMs;
    const suffix = details ? ` details=${JSON.stringify(details)}` : '';
    this.logger.log(
      `Claude startup session=${sessionId} run=${runId} stage=${stage} elapsedMs=${elapsedMs}${suffix}`,
    );
  }

  private logPreVisibleMessage(
    sessionId: number,
    run: ActiveRunState,
    message: SDKMessage,
  ): void {
    if (message.type === 'system') {
      run.systemSubtypesBeforeVisible.push(message.subtype);
      run.observedPreVisibleMarkers.add(`system:${message.subtype}`);
      this.logStartupTiming(
        sessionId,
        run.runId,
        run.startedAtMs,
        `pre_visible_system:${message.subtype}`,
      );
      return;
    }

    const marker = this.getPreVisibleMarker(message);
    if (!marker || run.observedPreVisibleMarkers.has(marker)) {
      return;
    }

    run.observedPreVisibleMarkers.add(marker);
    this.logStartupTiming(
      sessionId,
      run.runId,
      run.startedAtMs,
      `pre_visible_${marker.replace(/[:]/g, '_')}`,
    );
  }

  private getPreVisibleMarker(message: SDKMessage): string | null {
    if (message.type === 'assistant') return 'assistant';
    if (message.type === 'tool_progress') return 'tool_progress';
    if (message.type === 'tool_use_summary') return 'tool_use_summary';
    if (message.type === 'auth_status') return 'auth_status';
    if (message.type === 'prompt_suggestion') return 'prompt_suggestion';
    if (message.type === 'rate_limit_event') return 'rate_limit_event';
    return null;
  }

  private summarizePreVisibleActivity(
    run: ActiveRunState,
  ): 'system_only' | 'tooling' | 'auth_or_mcp' | 'opaque' {
    const markers = [...run.observedPreVisibleMarkers];
    if (markers.length === 0) {
      return 'opaque';
    }
    if (
      markers.some((marker) =>
        marker === 'tool_progress'
        || marker === 'tool_use_summary'
        || marker.startsWith('system:hook_')
        || marker.startsWith('system:task_')
        || marker === 'system:files_persisted'
        || marker === 'system:memory_recall'
      )
    ) {
      return 'tooling';
    }
    if (
      markers.some((marker) =>
        marker === 'auth_status'
        || marker === 'system:auth_status'
        || marker === 'system:plugin_install'
        || marker === 'system:elicitation_complete'
      )
    ) {
      return 'auth_or_mcp';
    }
    if (
      markers.every((marker) =>
        marker === 'assistant'
        || marker === 'prompt_suggestion'
        || marker === 'rate_limit_event'
        || marker === 'system:init'
        || marker === 'system:status'
        || marker === 'system:session_state_changed'
        || marker === 'system:notification'
        || marker === 'system:api_retry'
        || marker === 'system:compact_boundary'
        || marker === 'system:mirror_error'
      )
    ) {
      return 'system_only';
    }
    return 'opaque';
  }

  private computeHookElapsedMs(
    hook: ClaudeHookExecution,
    updatedAt: string,
  ): number | null {
    if (!hook.startedAt) {
      return null;
    }
    const started = Date.parse(hook.startedAt);
    const updated = Date.parse(updatedAt);
    if (Number.isNaN(started) || Number.isNaN(updated)) {
      return null;
    }
    return Math.max(0, updated - started);
  }

  private byteLength(value: string | undefined): number {
    return value ? Buffer.byteLength(value, 'utf8') : 0;
  }

  private formatHookMessageDetails(message: Record<string, unknown>): string {
    const extras: Record<string, unknown> = {};
    const interestingKeys = [
      'hook_matcher',
      'matcher',
      'hook_source',
      'source',
      'command',
      'commands',
      'timeout',
      'timeout_ms',
      'cwd',
      'mcp_server_name',
    ];

    for (const key of interestingKeys) {
      const value = message[key];
      if (value == null) {
        continue;
      }
      extras[key] =
        typeof value === 'string' && value.length > 240
          ? `${value.slice(0, 240)}...`
          : value;
    }

    const rawKeys = Object.keys(message).filter(
      (key) =>
        ![
          'hook_id',
          'hook_name',
          'hook_event',
          'outcome',
          'output',
          'stdout',
          'stderr',
          'exit_code',
          'session_id',
          'uuid',
          'type',
          'parent_tool_use_id',
        ].includes(key),
    );

    if (rawKeys.length > 0) {
      extras['rawKeys'] = rawKeys;
    }

    return Object.keys(extras).length > 0
      ? ` details=${JSON.stringify(extras)}`
      : '';
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
    const run = this.activeRuns.get(sessionId);
    if (run && !run.sawFirstVisibleItem) {
      run.sawFirstVisibleItem = true;
      run.firstVisibleAtMs = Date.now();
      const preVisibleSummary = this.summarizePreVisibleActivity(run);
      const details: Record<string, unknown> = {
        queryCreatedToFirstSdkMs:
          run.firstSdkMessageAtMs == null
            ? null
            : run.firstSdkMessageAtMs - run.queryCreatedAtMs,
        firstSdkToFirstVisibleMs:
          run.firstSdkMessageAtMs == null
            ? null
            : run.firstVisibleAtMs - run.firstSdkMessageAtMs,
        submitToFirstVisibleMs: run.firstVisibleAtMs - run.startedAtMs,
        preVisibleSummary,
        systemSubtypes: run.systemSubtypesBeforeVisible,
      };
      this.logStartupTiming(
        sessionId,
        run.runId,
        run.startedAtMs,
        `first_visible_${eventType}`,
        details,
      );
      if (preVisibleSummary === 'opaque') {
        this.logStartupTiming(
          sessionId,
          run.runId,
          run.startedAtMs,
          'opaque_startup_gap',
          details,
        );
      }
    }

    const state = this.ensureRuntimeState(sessionId);
    state.liveItems = [...state.liveItems, item];

    if (eventType === 'thinking_start') {
      this.emitEvent({ type: 'thinking_start', payload: { sessionId, item } });
      return;
    }

    if (eventType === 'tool_use') {
      this.emitEvent({ type: 'tool_use', payload: { sessionId, item } });
      return;
    }

    if (eventType === 'tool_result') {
      this.emitEvent({ type: 'tool_result', payload: { sessionId, item } });
      return;
    }

    this.emitEvent({ type: 'message_start', payload: { sessionId, item } });
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

    if (eventType === 'thinking_delta') {
      this.emitEvent({
        type: 'thinking_delta',
        payload: { sessionId, itemId, delta },
      });
      return;
    }

    this.emitEvent({
      type: 'message_delta',
      payload: { sessionId, itemId, delta },
    });
  }

  private findLiveItem(
    sessionId: number,
    itemId: string,
  ): ClaudeTranscriptItem | undefined {
    return this.ensureRuntimeState(sessionId).liveItems.find(
      (item) => item.id === itemId,
    );
  }

  private resolvePartialContentBlockKey(
    run: ActiveRunState | undefined,
    kind: 'assistant' | 'thinking',
    streamMessageId: string,
    partIndex: number,
    ordinal: number,
  ): string | null {
    const items = kind === 'assistant'
      ? run?.partialAssistantItems
      : run?.partialThinkingItems;
    if (!items) {
      return null;
    }

    const exactKey = `${streamMessageId}:${partIndex}`;
    if (items.has(exactKey)) {
      return exactKey;
    }

    const matchingKeys = [...items.keys()]
      .filter((key) => key.startsWith(`${streamMessageId}:`))
      .sort((left, right) => {
        const leftIndex = Number.parseInt(left.slice(left.lastIndexOf(':') + 1), 10);
        const rightIndex = Number.parseInt(right.slice(right.lastIndexOf(':') + 1), 10);
        return leftIndex - rightIndex;
      });

    return matchingKeys[ordinal] ?? null;
  }

  private resolveSdkClaudePath(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const candidates =
      process.platform === 'linux'
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];

    const scopedRequire = createRequire(__filename);
    for (const candidate of candidates) {
      try {
        return scopedRequire.resolve(candidate);
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  private buildQueryOptions(
    sessionId: number,
    worktreePath: string,
    claudeSessionId: string | null,
    selectedModel: string | null,
    selectedPermissionMode: ClaudePermissionMode | null,
    canUseTool: CanUseTool,
    onElicitation: (request: ElicitationRequest) => Promise<ElicitationResult>,
  ): Options {
    // This runtime uses short-lived SDK queries resumed by Claude session id.
    // Keeping the last N Claude sessions truly warm would require a separate
    // long-lived process/runtime model rather than more tuning at this boundary.
    const pathToClaudeCodeExecutable =
      this.claudeCliOverride?.path
      ?? this.resolveSdkClaudePath()
      ?? findBinary('claude')
      ?? undefined;
    return {
      cwd: worktreePath,
      model: selectedModel ?? undefined,
      permissionMode: (selectedPermissionMode as PermissionMode | undefined) ?? undefined,
      resume:
        claudeSessionId && claudeSessionId !== '-1'
          ? claudeSessionId
          : undefined,
      includeHookEvents: true,
      includePartialMessages: true,
      promptSuggestions: true,
      agentProgressSummaries: true,
      canUseTool,
      onElicitation,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      settingSources: ['project', 'user', 'local'],
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
      },
      tools: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
      },
      env: {
        ...buildAugmentedEnv(),
        ELEVENEX_SESSION_ID: String(sessionId),
        ELEVENEX_PORT: String(getElevenexProxyPort()),
        PLANNOTATOR_BROWSER: this.wrapperScriptPath,
      },
    };
  }

  private buildMcpAuthQueryOptions(
    sessionId: number,
    worktreePath: string,
    serverName: string,
    abortController: AbortController,
  ): Options {
    const pathToClaudeCodeExecutable =
      this.claudeCliOverride?.path
      ?? this.resolveSdkClaudePath()
      ?? findBinary('claude')
      ?? undefined;

    return {
      abortController,
      cwd: worktreePath,
      permissionMode: 'auto',
      persistSession: false,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      settingSources: ['project', 'user', 'local'],
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
      },
      tools: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
      },
      onElicitation: async (request) => {
        if (
          request.serverName === serverName
          && request.mode === 'url'
          && typeof request.url === 'string'
          && request.url.trim()
        ) {
          return { action: 'accept' };
        }

        return { action: 'decline' };
      },
      env: {
        ...buildAugmentedEnv(),
        ELEVENEX_SESSION_ID: String(sessionId),
        ELEVENEX_PORT: String(getElevenexProxyPort()),
        PLANNOTATOR_BROWSER: this.wrapperScriptPath,
      },
    };
  }

  private createIdlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
    return {
      async *[Symbol.asyncIterator]() {
        if (signal.aborted) {
          return;
        }

        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  }

  private resolveClaudeCliOverride(): { path: string; version: string | null } | null {
    const configuredPath = process.env.ELEVENEX_CLAUDE_BIN?.trim();
    if (!configuredPath) {
      return null;
    }

    const resolvedPath = findBinary(configuredPath) ?? configuredPath;
    return {
      path: resolvedPath,
      version: this.readClaudeCliVersion(resolvedPath),
    };
  }

  private readClaudeCliVersion(binaryPath: string): string | null {
    try {
      const output = execFileSync(binaryPath, ['--version'], {
        encoding: 'utf-8',
        env: buildAugmentedEnv(),
        timeout: 5000,
      }).trim();
      return output || null;
    } catch (error) {
      this.logger.warn(
        `Could not read Claude CLI version for override "${binaryPath}": ${String(error)}`,
      );
      return null;
    }
  }

  private logClaudeRuntimeConfiguration(): void {
    const sdkVersion = CLAUDE_SDK_PACKAGE.version;
    const sdkClaudeCodeVersion = CLAUDE_SDK_PACKAGE.claudeCodeVersion ?? 'unknown';

    if (!this.claudeCliOverride) {
      this.logger.log(
        `Claude runtime configured to use the SDK-managed CLI (sdk=${sdkVersion}, claudeCode=${sdkClaudeCodeVersion}).`,
      );
      return;
    }

    const overrideVersion = this.claudeCliOverride.version ?? 'unknown';
    this.logger.log(
      `Claude runtime configured with ELEVENEX_CLAUDE_BIN=${this.claudeCliOverride.path} (sdk=${sdkVersion}, sdkClaudeCode=${sdkClaudeCodeVersion}, overrideVersion=${overrideVersion}).`,
    );

    if (
      CLAUDE_SDK_PACKAGE.claudeCodeVersion
      && overrideVersion !== 'unknown'
      && !overrideVersion.includes(CLAUDE_SDK_PACKAGE.claudeCodeVersion)
    ) {
      this.logger.warn(
        `Claude CLI override version mismatch: sdk expects ${CLAUDE_SDK_PACKAGE.claudeCodeVersion}, override reports ${overrideVersion}. Streaming and SDK behavior may degrade.`,
      );
    }
  }

  private logSdkMessageDiagnostics(sessionId: number, message: SDKMessage): void {
    if (message.type === 'stream_event') {
      const event = message.event as unknown as Record<string, unknown>;
      const delta = event['delta'] as Record<string, unknown> | undefined;
      const deltaSuffix =
        event.type === 'content_block_delta'
          ? ` delta=${String(delta?.type ?? 'unknown')}`
          : '';
      this.logger.debug(
        `Claude stream event session=${sessionId} type=${String(event.type ?? 'unknown')}${deltaSuffix}`,
      );
      return;
    }

    if (message.type === 'assistant') {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : [];
      this.logger.debug(
        `Claude assistant message session=${sessionId} blocks=${content.length}`,
      );
      return;
    }

    if (message.type === 'result') {
      this.logger.debug(
        `Claude result message session=${sessionId} subtype=${message.subtype} stopReason=${String(message.stop_reason ?? 'unknown')}`,
      );
    }
  }

  private toRuntimeStatePayload(
    sessionId: number,
    state: RuntimeState,
  ): ClaudeRuntimeStatePayload {
    return {
      sessionId,
      claudeSessionId: state.claudeSessionId,
      runPhase: state.runPhase,
      canInterrupt: state.canInterrupt,
      sessionState: state.sessionState,
      pendingPermissionRequest: state.pendingPermissionRequest,
      pendingUserInputRequest: state.pendingUserInputRequest,
      pendingPrompts: state.pendingPrompts,
      liveItems: state.liveItems,
      lastError: state.lastError,
      selectedModel: state.selectedModel,
      permissionMode: state.sessionMetadata?.permissionMode ?? state.selectedPermissionMode ?? null,
      availableModels: state.availableModels,
      contextUsage: state.contextUsage,
      sessionMetadata: state.sessionMetadata,
      runtimeStatus: state.runtimeStatus,
      authStatus: state.authStatus,
      rateLimit: state.rateLimit,
      notifications: state.notifications,
      hooks: state.hooks,
      recentHookEvents: state.recentHookEvents,
      tasks: state.tasks,
      taskLifecycle: state.taskLifecycle,
      subagents: state.subagents,
      latestToolProgress: state.latestToolProgress,
      latestToolSummary: state.latestToolSummary,
      latestApiRetry: state.latestApiRetry,
      latestPluginInstall: state.latestPluginInstall,
      latestMemoryRecall: state.latestMemoryRecall,
      latestFilesPersisted: state.latestFilesPersisted,
      latestElicitationCompletion: state.latestElicitationCompletion,
      latestPromptSuggestion: state.latestPromptSuggestion,
      latestCompactBoundary: state.latestCompactBoundary,
      latestMirrorError: state.latestMirrorError,
    };
  }

  private async refreshRuntimeMetadata(
    sessionId: number,
    options: {
      force?: boolean;
      reason?: string;
      runId?: string;
      startedAtMs?: number;
    } = {},
  ): Promise<void> {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const run = this.activeRuns.get(sessionId);
    if (!run) {
      return;
    }

    const state = this.ensureRuntimeState(sessionId);
    if (state.metadataRefreshPromise) {
      this.logger.debug(
        `Claude runtime metadata refresh coalesced session=${sessionId} reason=${options.reason ?? 'unspecified'}`,
      );
      return state.metadataRefreshPromise;
    }

    const now = Date.now();
    if (
      !options.force
      && state.metadataRefreshCompletedAtMs != null
      && now - state.metadataRefreshCompletedAtMs < 1500
    ) {
      this.logger.debug(
        `Claude runtime metadata refresh skipped session=${sessionId} reason=${options.reason ?? 'unspecified'} ageMs=${now - state.metadataRefreshCompletedAtMs}`,
      );
      return;
    }

    const startedAtMs = now;
    state.metadataRefreshStartedAtMs = startedAtMs;
    if (options.runId && options.startedAtMs != null) {
      this.logStartupTiming(
        sessionId,
        options.runId,
        options.startedAtMs,
        'metadata_refresh_started',
        { reason: options.reason ?? 'unspecified' },
      );
    }

    const refreshPromise = (async () => {
      try {
        const [models, contextUsage] = await Promise.all([
          run.query.supportedModels(),
          run.query.getContextUsage(),
        ]);
        state.availableModels = models.map((model) => this.toModelOption(model));
        state.contextUsage = this.toContextUsage(contextUsage);
        state.selectedModel = contextUsage.model || state.selectedModel;
        if (state.sessionMetadata && contextUsage.model) {
          state.sessionMetadata = {
            ...state.sessionMetadata,
            model: contextUsage.model,
          };
        }
        state.metadataRefreshCompletedAtMs = Date.now();
        this.logger.log(
          `Claude runtime metadata refresh session=${sessionId} elapsedMs=${Date.now() - startedAtMs} models=${models.length} reason=${options.reason ?? 'unspecified'}`,
        );
      } catch (error) {
        state.metadataRefreshCompletedAtMs = Date.now();
        this.logger.debug(
          `Failed to refresh Claude runtime metadata for session ${sessionId} elapsedMs=${Date.now() - startedAtMs} reason=${options.reason ?? 'unspecified'}: ${String(error)}`,
        );
        if (!state.availableModels.length) {
          state.availableModels = [...FALLBACK_MODELS];
        }
        throw error;
      } finally {
        state.metadataRefreshPromise = null;
      }
    })();

    state.metadataRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  private toModelOption(model: ModelInfo): ClaudeModelOption {
    return {
      id: model.value,
      displayName: model.displayName,
      description: model.description,
      supportsEffort: model.supportsEffort,
      supportsFastMode: model.supportsFastMode,
      supportsAutoMode: model.supportsAutoMode,
    };
  }

  private toContextUsage(
    usage: SDKControlGetContextUsageResponse,
  ): ClaudeContextUsage {
    return {
      model: usage.model,
      totalTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      percentage: usage.percentage,
      inputTokens: usage.apiUsage?.input_tokens ?? 0,
      outputTokens: usage.apiUsage?.output_tokens ?? 0,
      cacheCreationInputTokens:
        usage.apiUsage?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: usage.apiUsage?.cache_read_input_tokens ?? 0,
      autoCompactThreshold: usage.autoCompactThreshold,
      isAutoCompactEnabled: usage.isAutoCompactEnabled,
      memoryFiles: usage.memoryFiles.map((file) => ({
        path: file.path,
        type: file.type,
        tokens: file.tokens,
      })),
      mcpTools: usage.mcpTools.map((tool) => ({
        name: tool.name,
        serverName: tool.serverName,
        tokens: tool.tokens,
        isLoaded: tool.isLoaded,
      })),
    };
  }

  private toTaskUsage(usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  }): ClaudeTaskUsage {
    return {
      totalTokens: usage.total_tokens,
      toolUses: usage.tool_uses,
      durationMs: usage.duration_ms,
    };
  }

  private upsertHookExecution(
    sessionId: number,
    patch: Partial<ClaudeHookExecution> &
      Pick<
        ClaudeHookExecution,
        'hookId' | 'hookName' | 'hookEvent' | 'status' | 'updatedAt'
      >,
  ): ClaudeHookExecution {
    const state = this.ensureRuntimeState(sessionId);
    const existing = state.hooks.find((hook) => hook.hookId === patch.hookId);
    const hook: ClaudeHookExecution = {
      hookId: patch.hookId,
      hookName: patch.hookName,
      hookEvent: patch.hookEvent,
      status: patch.status,
      output: patch.output ?? existing?.output,
      stdout: patch.stdout ?? existing?.stdout,
      stderr: patch.stderr ?? existing?.stderr,
      exitCode: patch.exitCode ?? existing?.exitCode,
      startedAt: patch.startedAt ?? existing?.startedAt,
      updatedAt: patch.updatedAt,
    };

    state.hooks = [
      hook,
      ...state.hooks.filter((item) => item.hookId !== patch.hookId),
    ].slice(0, MAX_RECENT_HOOKS);
    return hook;
  }

  private upsertTask(
    sessionId: number,
    patch: Partial<ClaudeTaskState> &
      Pick<ClaudeTaskState, 'taskId' | 'status' | 'updatedAt'>,
  ): ClaudeTaskState {
    const state = this.ensureRuntimeState(sessionId);
    const existing = state.tasks.find((task) => task.taskId === patch.taskId);
    const task: ClaudeTaskState = {
      taskId: patch.taskId,
      status: patch.status ?? existing?.status ?? 'pending',
      description: patch.description ?? existing?.description,
      taskType: patch.taskType ?? existing?.taskType,
      workflowName: patch.workflowName ?? existing?.workflowName,
      toolUseId: patch.toolUseId ?? existing?.toolUseId,
      prompt: patch.prompt ?? existing?.prompt,
      outputFile: patch.outputFile ?? existing?.outputFile,
      summary: patch.summary ?? existing?.summary,
      lastToolName: patch.lastToolName ?? existing?.lastToolName,
      usage: patch.usage ?? existing?.usage,
      skipTranscript: patch.skipTranscript ?? existing?.skipTranscript,
      error: patch.error ?? existing?.error,
      endTime: patch.endTime ?? existing?.endTime,
      totalPausedMs: patch.totalPausedMs ?? existing?.totalPausedMs,
      isBackgrounded: patch.isBackgrounded ?? existing?.isBackgrounded,
      subject: patch.subject ?? existing?.subject,
      teammateName: patch.teammateName ?? existing?.teammateName,
      teamName: patch.teamName ?? existing?.teamName,
      updatedAt: patch.updatedAt,
    };

    state.tasks = [
      task,
      ...state.tasks.filter((item) => item.taskId !== patch.taskId),
    ];
    return task;
  }

  private appendRecent<T>(items: T[], item: T, maxItems: number): T[] {
    return [item, ...items].slice(0, maxItems);
  }

  private upsertRecentSubagent(
    items: ClaudeSubagentState[],
    subagent: ClaudeSubagentState,
  ): ClaudeSubagentState[] {
    return [
      subagent,
      ...items.filter((item) => item.agentId !== subagent.agentId),
    ].slice(0, MAX_RECENT_SUBAGENTS);
  }

  private normalizeHistory(
    messages: HistoryMessage[],
    interactionsByToolUseId: Map<string, ClaudeToolInteractionSummary>,
  ): ClaudeTranscriptItem[] {
    const normalized: ClaudeTranscriptItem[] = [];

    for (const message of messages) {
      const payload = message.message as Record<string, any> | null;
      if (!payload || !Array.isArray(payload.content)) {
        continue;
      }
      const timestamp = this.resolveMessageTimestamp(message);
      const parentToolUseId =
        'parent_tool_use_id' in message
          ? (message.parent_tool_use_id ?? undefined)
          : undefined;

      if (message.type === 'user') {
        for (const [index, part] of payload.content.entries()) {
          if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            this.stripInjectedWorktreeContext(part.text).trim()
          ) {
            normalized.push({
              id: `${message.uuid}:user:${index}`,
              kind: 'user',
              content: this.stripInjectedWorktreeContext(part.text),
              parentToolUseId,
              sourceMessageId: message.uuid,
              timestamp,
              authoredAt: timestamp,
            });
          } else if (part.type === 'tool_result') {
            normalized.push({
              id: `${message.uuid}:tool_result:${part.tool_use_id ?? index}`,
              kind: 'tool_result',
              toolUseId: part.tool_use_id,
              parentToolUseId,
              sourceMessageId: message.uuid,
              content:
                typeof part.content === 'string'
                  ? part.content
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              timestamp,
              authoredAt: timestamp,
            });
          }
        }
      } else if (message.type === 'assistant') {
        // Use the Anthropic message id as the prefix so history items share an
        // id namespace with streamed items (which key off message_start.message.id).
        // Without this, frontend dedup compares `msg_xxx:assistant` (history) against
        // `msg_xxx` (stream) prefixes derived from different identifiers and fails,
        // re-rendering the streamed message after history sync.
        const apiMessageId =
          typeof payload.id === 'string' && payload.id ? payload.id : message.uuid;
        for (const [index, part] of payload.content.entries()) {
          if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.text.trim()
          ) {
            normalized.push({
              id: `${apiMessageId}:assistant:${index}`,
              kind: 'assistant',
              content: part.text,
              parentToolUseId,
              sourceMessageId: apiMessageId,
              timestamp,
              receivedAt: timestamp,
            });
          } else if (
            part.type === 'thinking' &&
            typeof part.thinking === 'string'
          ) {
            normalized.push({
              id: `${apiMessageId}:thinking:${index}`,
              kind: 'thinking',
              content: part.thinking,
              parentToolUseId,
              sourceMessageId: apiMessageId,
              timestamp,
              receivedAt: timestamp,
            });
          } else if (part.type === 'tool_use') {
            normalized.push({
              id: `${apiMessageId}:tool_use:${part.id ?? index}`,
              kind: 'tool_use',
              toolUseId: part.id,
              parentToolUseId,
              toolName: part.name,
              toolInput: part.input,
              interaction:
                typeof part.id === 'string'
                  ? interactionsByToolUseId.get(part.id)
                  : undefined,
              sourceMessageId: apiMessageId,
              timestamp,
              receivedAt: timestamp,
            });
          }
        }
      }
    }

    return normalized;
  }

  private normalizeTranscriptRecords(
    records: ClaudeTranscriptRecord[],
    interactionsByToolUseId: Map<string, ClaudeToolInteractionSummary> = new Map(),
  ): ClaudeTranscriptItem[] {
    const messages = records
      .filter((record): record is SessionMessage & ClaudeTranscriptRecord => {
        return (
          (record.type === 'user' || record.type === 'assistant')
          && typeof record.uuid === 'string'
          && !!record.message
        );
      })
      .map((record) => ({
        type: record.type,
        uuid: record.uuid,
        timestamp:
          typeof record.timestamp === 'string'
            ? record.timestamp
            : new Date().toISOString(),
        message: record.message,
      }));

    return this.normalizeHistory(messages, interactionsByToolUseId);
  }

  private recordHistorySnapshot(
    state: RuntimeState,
    items: ClaudeTranscriptItem[],
    source: 'sdk' | 'transcript' | null,
  ): void {
    state.lastHistoryItemCount = items.length;
    state.lastHistoryLoadedAtMs = Date.now();
    state.lastHistorySource = source;
    state.transcriptFallbackUsed = source === 'transcript';
  }

  private async loadHistoryFromTranscript(
    sessionId: number,
    worktreePath: string,
    claudeSessionId: string,
    interactionsByToolUseId: Map<string, ClaudeToolInteractionSummary>,
  ): Promise<ClaudeTranscriptItem[]> {
    const transcriptPath = await this.findTranscriptPath(
      worktreePath,
      claudeSessionId,
    );

    if (!transcriptPath) {
      return [];
    }

    try {
      const records = await this.loadTranscriptRecords(transcriptPath);
      const normalized = this.normalizeTranscriptRecords(
        records,
        interactionsByToolUseId,
      );
      this.recordHistorySnapshot(
        this.ensureRuntimeState(sessionId, claudeSessionId),
        normalized,
        'transcript',
      );
      return normalized;
    } catch (error) {
      this.logger.warn(
        `Failed to load Claude transcript fallback for session ${sessionId}: ${String(error)}`,
      );
      this.recordHistorySnapshot(
        this.ensureRuntimeState(sessionId, claudeSessionId),
        [],
        null,
      );
      return [];
    }
  }

  private async recordInteractionSummary(
    sessionId: number,
    request: ClaudePermissionRequest,
    decision: PermissionDecision,
  ): Promise<ClaudeToolInteractionSummary> {
    const summary = this.buildInteractionSummary(request, decision);
    await this.db
      .insert(schema.claudeToolInteractions)
      .values({
        sessionId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        interactionKind: summary.kind,
        decision: summary.decision,
        remember: summary.remember,
        responseContent: this.stringifyJson(summary.content),
        requestSnapshot: this.stringifyJson(summary.requestSnapshot) ?? '{}',
        createdAt: summary.createdAt,
        resolvedAt: summary.resolvedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.claudeToolInteractions.sessionId,
          schema.claudeToolInteractions.toolUseId,
        ],
        set: {
          toolName: request.toolName,
          interactionKind: summary.kind,
          decision: summary.decision,
          remember: summary.remember,
          responseContent: this.stringifyJson(summary.content),
          requestSnapshot: this.stringifyJson(summary.requestSnapshot) ?? '{}',
          createdAt: summary.createdAt,
          resolvedAt: summary.resolvedAt,
        },
      });

    this.attachInteractionToLiveToolUse(sessionId, request.toolUseId, summary);
    return summary;
  }

  private buildInteractionSummary(
    request: ClaudePermissionRequest,
    decision: PermissionDecision,
  ): ClaudeToolInteractionSummary {
    const requestSnapshot = {
      title: request.title ?? null,
      displayName: request.displayName ?? null,
      description: request.description ?? null,
      decisionReason: request.decisionReason ?? null,
      blockedPath: request.blockedPath ?? null,
      input: request.input ?? null,
    };
    const createdAt = request.createdAt;
    const resolvedAt = new Date().toISOString();
    const kind = this.getInteractionKind(request.toolName);
    const content = decision.behavior === 'allow' ? decision.content ?? null : null;

    if (kind === 'ask_user_question') {
      const answers = this.extractInteractionAnswers(content);
      return {
        kind,
        decision: decision.behavior === 'allow' ? 'answered' : 'declined',
        decisionLabel: decision.behavior === 'allow' ? 'Answered' : 'Declined',
        decisionTone: decision.behavior === 'allow' ? 'ok' : 'warn',
        remember: false,
        answers,
        content,
        requestSnapshot,
        createdAt,
        resolvedAt,
      };
    }

    if (kind === 'plan_mode') {
      return {
        kind,
        decision: decision.behavior === 'allow' ? 'approved' : 'denied',
        decisionLabel: decision.behavior === 'allow' ? 'Start planning' : 'Not now',
        decisionTone: decision.behavior === 'allow' ? 'ok' : 'warn',
        remember: false,
        content,
        requestSnapshot,
        createdAt,
        resolvedAt,
      };
    }

    if (kind === 'exit_plan_mode') {
      return {
        kind,
        decision: decision.behavior === 'allow' ? 'approved' : 'denied',
        decisionLabel: decision.behavior === 'allow' ? 'Approve plan' : 'Keep planning',
        decisionTone: decision.behavior === 'allow' ? 'ok' : 'warn',
        remember: false,
        content,
        requestSnapshot,
        createdAt,
        resolvedAt,
      };
    }

    return {
      kind: 'permission',
      decision:
        decision.behavior === 'allow'
          ? decision.remember
            ? 'approved_always'
            : 'approved'
          : 'denied',
      decisionLabel:
        decision.behavior === 'allow'
          ? decision.remember
            ? 'Always allow'
            : 'Allow once'
          : 'Deny',
      decisionTone: decision.behavior === 'allow' ? 'ok' : 'warn',
      remember: decision.behavior === 'allow' ? decision.remember : false,
      content,
      requestSnapshot,
      createdAt,
      resolvedAt,
    };
  }

  private getInteractionKind(toolName: string | undefined): ClaudeToolInteractionKind {
    const normalized = this.normalizeToolName(toolName ?? '');
    if (normalized === 'askuserquestion') return 'ask_user_question';
    if (normalized === 'enterplanmode') return 'plan_mode';
    if (normalized === 'exitplanmode') return 'exit_plan_mode';
    return 'permission';
  }

  private extractInteractionAnswers(
    content: Record<string, unknown> | null,
  ): ClaudeToolInteractionAnswer[] {
    if (!content || typeof content['answers'] !== 'object' || !content['answers']) {
      return [];
    }
    return Object.entries(content['answers'] as Record<string, unknown>).map(
      ([question, answer]) => ({
        question,
        answer: String(answer ?? ''),
      }),
    );
  }

  private attachInteractionToLiveToolUse(
    sessionId: number,
    toolUseId: string,
    interaction: ClaudeToolInteractionSummary,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.liveItems = state.liveItems.map((item) =>
      item.kind === 'tool_use' && item.toolUseId === toolUseId
        ? { ...item, interaction }
        : item,
    );
  }

  private async getInteractionSummaryMap(
    sessionId: number,
  ): Promise<Map<string, ClaudeToolInteractionSummary>> {
    const rows = await this.db
      .select()
      .from(schema.claudeToolInteractions)
      .where(eq(schema.claudeToolInteractions.sessionId, sessionId));

    return new Map(
      rows.map((row) => [row.toolUseId, this.toInteractionSummary(row)]),
    );
  }

  private toInteractionSummary(
    row: ToolInteractionRow,
  ): ClaudeToolInteractionSummary {
    const content = this.parseJsonRecord(row.responseContent);
    const requestSnapshot = this.parseJsonRecord(row.requestSnapshot);
    return {
      kind: row.interactionKind as ClaudeToolInteractionKind,
      decision: row.decision,
      decisionLabel: this.toDecisionLabel(
        row.interactionKind as ClaudeToolInteractionKind,
        row.decision,
      ),
      decisionTone: this.toDecisionTone(row.decision),
      remember: row.remember,
      answers:
        row.interactionKind === 'ask_user_question'
          ? this.extractInteractionAnswers(content)
          : undefined,
      content,
      requestSnapshot,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    };
  }

  private toDecisionLabel(
    kind: ClaudeToolInteractionKind,
    decision: string,
  ): string {
    if (kind === 'ask_user_question') {
      return decision === 'answered' ? 'Answered' : 'Declined';
    }
    if (kind === 'plan_mode') {
      return decision === 'approved' ? 'Start planning' : 'Not now';
    }
    if (kind === 'exit_plan_mode') {
      return decision === 'approved' ? 'Approve plan' : 'Keep planning';
    }
    if (decision === 'approved_always') return 'Always allow';
    if (decision === 'approved') return 'Allow once';
    return 'Deny';
  }

  private toDecisionTone(
    decision: string,
  ): ClaudeToolInteractionSummary['decisionTone'] {
    return decision === 'denied' || decision === 'declined' ? 'warn' : 'ok';
  }

  private parseJsonRecord(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private stringifyJson(value: Record<string, unknown> | null | undefined): string | null {
    if (!value) return null;
    return JSON.stringify(value);
  }

  private normalizeToolName(name: string): string {
    return name.toLowerCase().replace(/[_-]/g, '');
  }

  private stripInjectedWorktreeContext(text: string): string {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(WORKTREE_CONTEXT_OPEN)) {
      return text;
    }

    const closingIndex = trimmed.indexOf(WORKTREE_CONTEXT_CLOSE);
    if (closingIndex === -1) {
      return text;
    }

    const afterClose = trimmed.slice(closingIndex + WORKTREE_CONTEXT_CLOSE.length);
    return afterClose.replace(/^\s+/, '');
  }

  private resolveMessageTimestamp(message: unknown): string {
    const timestamp =
      message && typeof message === 'object'
        ? (message as { timestamp?: unknown }).timestamp
        : undefined;
    return typeof timestamp === 'string' && timestamp
      ? timestamp
      : new Date().toISOString();
  }

  private async collectCommandItems(
    worktreePath: string,
  ): Promise<ClaudeAutocompleteItem[]> {
    const [projectDirs, userDirs] = await Promise.all([
      this.collectClaudeProjectDirectories(worktreePath, 'commands'),
      this.collectClaudeConfigDirectories('commands'),
    ]);
    const [projectItems, userItems] = await Promise.all([
      Promise.all(projectDirs.map((dir) => this.scanCommandDirectory(dir, 'project'))),
      Promise.all(userDirs.map((dir) => this.scanCommandDirectory(dir, 'user'))),
    ]);
    return [...projectItems.flat(), ...userItems.flat()];
  }

  private async collectClaudeSkillItems(
    worktreePath: string,
  ): Promise<ClaudeAutocompleteItem[]> {
    const [projectDirs, userDirs] = await Promise.all([
      this.collectClaudeProjectDirectories(worktreePath, 'skills'),
      this.collectClaudeConfigDirectories('skills'),
    ]);
    const [projectItems, userItems] = await Promise.all([
      Promise.all(projectDirs.map((dir) => this.scanClaudeSkillDirectory(dir, 'project'))),
      Promise.all(userDirs.map((dir) => this.scanClaudeSkillDirectory(dir, 'user'))),
    ]);
    return [...projectItems.flat(), ...userItems.flat()];
  }

  private async collectExternalSkillItems(
    worktreePath: string,
  ): Promise<ClaudeAutocompleteItem[]> {
    const projectCodexDir = join(worktreePath, '.codex', 'skills');
    const projectAgentsDir = join(worktreePath, '.agents', 'skills');
    const userCodexDir = join(homedir(), '.codex', 'skills');
    const userAgentsDir = join(homedir(), '.agents', 'skills');
    const [projectCodex, projectAgents, userCodex, userAgents] =
      await Promise.all([
        this.scanExternalSkillDirectory(projectCodexDir, 'project'),
        this.scanExternalSkillDirectory(projectAgentsDir, 'project'),
        this.scanExternalSkillDirectory(userCodexDir, 'user'),
        this.scanExternalSkillDirectory(userAgentsDir, 'user'),
      ]);
    return [...projectCodex, ...projectAgents, ...userCodex, ...userAgents];
  }

  private async collectClaudeConfigDirectories(
    subdir: 'commands' | 'skills',
  ): Promise<string[]> {
    const roots = this.getClaudeConfigRoots();
    const results = await Promise.all(
      roots.map(async (root) => {
        const candidate = join(root, subdir);
        return (await this.pathExists(candidate)) ? candidate : null;
      }),
    );
    return results.filter((value): value is string => !!value);
  }

  private async collectClaudeProjectDirectories(
    worktreePath: string,
    subdir: 'commands' | 'skills',
  ): Promise<string[]> {
    const home = resolve(homedir()).normalize('NFC');
    const gitRoot = await this.findGitBoundary(worktreePath);
    const directories: string[] = [];
    let current = resolve(worktreePath).normalize('NFC');

    while (true) {
      if (this.samePath(current, home)) {
        break;
      }

      const candidate = join(current, '.claude', subdir);
      if (await this.pathExists(candidate)) {
        directories.push(candidate);
      }

      if (gitRoot && this.samePath(current, gitRoot)) {
        break;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    if (gitRoot) {
      const canonicalRoot = await this.findCanonicalGitRoot(gitRoot);
      if (canonicalRoot && !this.samePath(canonicalRoot, gitRoot)) {
        const worktreeCandidate = join(gitRoot, '.claude', subdir);
        const canonicalCandidate = join(canonicalRoot, '.claude', subdir);
        if (
          !(await this.pathExists(worktreeCandidate)) &&
          (await this.pathExists(canonicalCandidate))
        ) {
          directories.push(canonicalCandidate);
        }
      }
    }

    return this.uniquePaths(directories);
  }

  private getClaudeConfigRoots(): string[] {
    const configured = process.env['CLAUDE_CONFIG_DIR']?.trim();
    return this.uniquePaths(
      [
        configured ? resolve(configured).normalize('NFC') : null,
        join(homedir(), '.claude').normalize('NFC'),
        join(homedir(), 'claude').normalize('NFC'),
      ].filter((value): value is string => !!value),
    );
  }

  private async findGitBoundary(worktreePath: string): Promise<string | null> {
    let current = resolve(worktreePath).normalize('NFC');
    while (true) {
      if (await this.pathExists(join(current, '.git'))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }

  private async findCanonicalGitRoot(gitRoot: string): Promise<string | null> {
    const gitPath = join(gitRoot, '.git');
    try {
      const raw = await readFile(gitPath, 'utf8');
      const match = raw.match(/gitdir:\s*(.+)\s*$/im);
      if (!match) {
        return gitRoot;
      }

      const gitDir = resolve(gitRoot, match[1].trim());
      const resolvedGitDir = (
        await realpath(gitDir).catch(() => gitDir)
      ).normalize('NFC');
      const worktreesDir = dirname(resolvedGitDir);
      const dotGitDir = dirname(worktreesDir);
      if (
        basename(worktreesDir) === 'worktrees' &&
        basename(dotGitDir) === '.git'
      ) {
        return dirname(dotGitDir).normalize('NFC');
      }
      return dirname(resolvedGitDir).normalize('NFC');
    } catch {
      return gitRoot;
    }
  }

  private samePath(left: string, right: string): boolean {
    return left.normalize('NFC') === right.normalize('NFC');
  }

  private uniquePaths(paths: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const path of paths) {
      const normalized = path.normalize('NFC');
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  private async scanCommandDirectory(
    baseDir: string,
    source: 'project' | 'user',
  ): Promise<ClaudeAutocompleteItem[]> {
    if (!(await this.pathExists(baseDir))) {
      return [];
    }

    const files = await this.walkDirectory(baseDir, (entryName) =>
      entryName.endsWith('.md'),
    );
    const entries = this.normalizeLegacyCommandFiles(baseDir, files);
    const items: Array<ClaudeAutocompleteItem | null> = await Promise.all(entries.map(async (entry) => {
      const metadata = await this.readAutocompleteMetadata(
        entry.filePath,
        entry.isSkillFile ? 'Use this Claude skill' : 'Custom Claude command',
      );
      if (!metadata.userInvocable) {
        return null;
      }

      const commandName = entry.isSkillFile
        ? this.buildLegacySkillCommandName(baseDir, entry.filePath)
        : this.buildLegacyRegularCommandName(baseDir, entry.filePath);
      return {
        id: `${source}:command:${commandName}`,
        kind: entry.isSkillFile ? ('skill' as const) : ('command' as const),
        trigger: '/' as const,
        label: commandName,
        insertText: `${commandName} `,
        description: metadata.description,
        detail: this.getClaudeDetailLabel(dirname(baseDir), 'commands', source),
        source,
      };
    }));
    return items.filter((item): item is ClaudeAutocompleteItem => item !== null);
  }

  private async scanClaudeSkillDirectory(
    baseDir: string,
    source: 'project' | 'user',
  ): Promise<ClaudeAutocompleteItem[]> {
    if (!(await this.pathExists(baseDir))) {
      return [];
    }

    const files = await this.walkDirectory(
      baseDir,
      (entryName) => entryName === 'SKILL.md',
    );
    const items = await Promise.all(files.map(async (filePath) => {
      const metadata = await this.readAutocompleteMetadata(
        filePath,
        `Use the ${basename(dirname(filePath))} skill`,
      );
      if (!metadata.userInvocable) {
        return [];
      }

      const skillDir = basename(dirname(filePath));
      const detail = this.getClaudeDetailLabel(dirname(baseDir), 'skills', source);
      return [
        {
          id: `${source}:skill:slash:${skillDir}`,
          kind: 'skill' as const,
          trigger: '/' as const,
          label: `/${skillDir}`,
          insertText: `/${skillDir} `,
          description: metadata.description,
          detail,
          source,
        },
        {
          id: `${source}:skill:dollar:${skillDir}`,
          kind: 'skill' as const,
          trigger: '$' as const,
          label: `$${skillDir}`,
          insertText: `$${skillDir} `,
          description: metadata.description,
          detail,
          source,
        },
      ];
    }));
    return items.flat();
  }

  private async scanExternalSkillDirectory(
    baseDir: string,
    source: 'project' | 'user',
  ): Promise<ClaudeAutocompleteItem[]> {
    if (!(await this.pathExists(baseDir))) {
      return [];
    }

    const files = await this.walkDirectory(
      baseDir,
      (entryName) => entryName === 'SKILL.md',
    );
    const items = await Promise.all(
      files.map(async (filePath) => {
        const skillDir = basename(dirname(filePath));
        const metadata = await this.readAutocompleteMetadata(
          filePath,
          `Use the ${skillDir} skill`,
        );
        return {
          id: `${source}:external-skill:${skillDir}`,
          kind: 'skill' as const,
          trigger: '$' as const,
          label: `$${skillDir}`,
          insertText: `$${skillDir} `,
          description: metadata.description,
          detail: source === 'project' ? 'Project skill' : 'Installed skill',
          source,
        };
      }),
    );
    return items;
  }

  private normalizeLegacyCommandFiles(
    baseDir: string,
    files: string[],
  ): Array<{ filePath: string; isSkillFile: boolean }> {
    const filesByDir = new Map<string, string[]>();
    for (const file of files) {
      const dir = dirname(file);
      filesByDir.set(dir, [...(filesByDir.get(dir) ?? []), file]);
    }

    const result: Array<{ filePath: string; isSkillFile: boolean }> = [];
    for (const dirFiles of filesByDir.values()) {
      const skillFile = dirFiles.find((file) => /^skill\.md$/i.test(basename(file)));
      if (skillFile) {
        result.push({ filePath: skillFile, isSkillFile: true });
        continue;
      }
      for (const filePath of dirFiles) {
        result.push({ filePath, isSkillFile: false });
      }
    }
    return result;
  }

  private buildLegacySkillCommandName(baseDir: string, filePath: string): string {
    const skillDirectory = dirname(filePath);
    const namespace = this.buildLegacyNamespace(dirname(skillDirectory), baseDir);
    const commandBaseName = basename(skillDirectory);
    return `/${namespace ? `${namespace}/` : ''}${commandBaseName}`;
  }

  private buildLegacyRegularCommandName(baseDir: string, filePath: string): string {
    const namespace = this.buildLegacyNamespace(dirname(filePath), baseDir);
    const commandBaseName = basename(filePath).replace(/\.md$/i, '');
    return `/${namespace ? `${namespace}/` : ''}${commandBaseName}`;
  }

  private buildLegacyNamespace(targetDir: string, baseDir: string): string {
    if (this.samePath(targetDir, baseDir)) {
      return '';
    }
    return relative(baseDir, targetDir).replace(/\\/g, '/');
  }

  private getClaudeDetailLabel(
    configRoot: string,
    subdir: 'commands' | 'skills',
    source: 'project' | 'user',
  ): string {
    if (source === 'project') {
      return `.claude/${subdir}`;
    }
    const dotClaude = join(homedir(), '.claude');
    const bareClaude = join(homedir(), 'claude');
    if (this.samePath(configRoot, dotClaude)) {
      return `~/.claude/${subdir}`;
    }
    if (this.samePath(configRoot, bareClaude)) {
      return `~/claude/${subdir}`;
    }
    return `${configRoot}/${subdir}`;
  }

  private async readAutocompleteMetadata(
    filePath: string,
    fallback: string,
  ): Promise<{ description: string; userInvocable: boolean }> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const { content, frontmatter } = this.parseFrontmatter(raw);
      const description =
        frontmatter['description']
        || this.extractDescription(content)
        || fallback;
      const userInvocableRaw = frontmatter['user-invocable'];
      const userInvocable =
        userInvocableRaw == null
          ? true
          : !['false', '0', 'no', 'off'].includes(
              String(userInvocableRaw).trim().toLowerCase(),
            );
      return { description, userInvocable };
    } catch {
      return { description: fallback, userInvocable: true };
    }
  }

  private parseFrontmatter(
    raw: string,
  ): { content: string; frontmatter: Record<string, string> } {
    const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    if (!match) {
      return { content: raw, frontmatter: {} };
    }

    const frontmatter: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const parts = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (!parts) continue;
      frontmatter[parts[1].toLowerCase()] = parts[2]
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }

    return {
      content: raw.slice(match[0].length),
      frontmatter,
    };
  }

  private extractDescription(content: string): string | null {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.find((line) => !line.startsWith('#') && !line.startsWith('---'))
      ?? null
    );
  }

  private async walkDirectory(
    baseDir: string,
    predicate: (entryName: string) => boolean,
  ): Promise<string[]> {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = join(baseDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.walkDirectory(fullPath, predicate)));
        continue;
      }

      if (entry.isFile() && predicate(entry.name)) {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async readDescription(
    filePath: string,
    fallback: string,
  ): Promise<string> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const firstMeaningfulLine = lines.find(
        (line) => !line.startsWith('---') && !line.startsWith('# '),
      );
      return firstMeaningfulLine ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getTranscriptPath(worktreePath: string, claudeSessionId: string): string {
    return join(
      homedir(),
      '.claude',
      'projects',
      sanitizeClaudeProjectPath(worktreePath),
      `${claudeSessionId}.jsonl`,
    );
  }

  private async findTranscriptPath(
    worktreePath: string,
    claudeSessionId: string,
  ): Promise<string | null> {
    const computedPath = this.getTranscriptPath(worktreePath, claudeSessionId);
    if (await this.pathExists(computedPath)) {
      return computedPath;
    }

    const resolvedPath = await this.resolveWorktreePath(worktreePath);
    if (resolvedPath !== worktreePath) {
      const resolvedComputedPath = this.getTranscriptPath(resolvedPath, claudeSessionId);
      if (await this.pathExists(resolvedComputedPath)) {
        return resolvedComputedPath;
      }
    }

    const projectsDir = join(homedir(), '.claude', 'projects');
    try {
      const entries = await readdir(projectsDir);
      for (const entry of entries) {
        const candidatePath = join(projectsDir, entry, `${claudeSessionId}.jsonl`);
        if (await this.pathExists(candidatePath)) {
          return candidatePath;
        }
      }
    } catch {
      // projects directory doesn't exist or can't be read
    }

    return null;
  }

  private async resolveWorktreePath(worktreePath: string): Promise<string> {
    try {
      const resolved = resolve(worktreePath);
      const real = await realpath(resolved);
      return real.normalize('NFC');
    } catch {
      return worktreePath.normalize('NFC');
    }
  }

  private async loadTranscriptRecords(
    transcriptPath: string,
  ): Promise<ClaudeTranscriptRecord[]> {
    const raw = await readFile(transcriptPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClaudeTranscriptRecord);
  }

  private async persistTranscriptRecords(
    transcriptPath: string,
    records: ClaudeTranscriptRecord[],
  ): Promise<void> {
    const serialized =
      records.map((record) => JSON.stringify(record)).join('\n')
      + (records.length ? '\n' : '');
    await writeFile(transcriptPath, serialized, 'utf8');
  }

  private resetEphemeralRuntimeState(state: RuntimeState): void {
    state.runPhase = 'idle';
    state.sessionState = 'idle';
    state.canInterrupt = false;
    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = null;
    state.liveItems = [];
    state.lastError = null;
  }

  private async requestRunTeardown(
    sessionId: number,
    run: ActiveRunState,
    options: { invalidateSession?: boolean } = {},
  ): Promise<void> {
    if (run.tornDown) {
      return;
    }

    run.tornDown = true;
    run.interruptRequested = true;
    this.logStartupTiming(sessionId, run.runId, run.startedAtMs, 'interrupt_requested', {
      invalidateSession: Boolean(options.invalidateSession),
    });
    if (options.invalidateSession) {
      this.invalidatedSessions.add(sessionId);
    }

    const state = this.ensureRuntimeState(sessionId);
    const pendingUserInputRequest = state.pendingUserInputRequest;

    state.pendingPermissionRequest = null;
    state.pendingUserInputRequest = null;
    state.canInterrupt = false;

    if (!options.invalidateSession) {
      this.emitRunState(sessionId);
    }

    for (const [queuedPermissionRequestId, permission] of run.permissionRequests.entries()) {
      permission?.resolve({
        behavior: 'deny',
        message: 'Run interrupted by user',
      });
      run.permissionRequests.delete(queuedPermissionRequestId);
    }
    run.permissionRequestOrder = [];

    if (pendingUserInputRequest) {
      const userInput = run.userInputRequests.get(
        pendingUserInputRequest.requestId,
      );
      userInput?.resolve({ action: 'cancel' });
      run.userInputRequests.delete(pendingUserInputRequest.requestId);
    }

    try {
      await run.query.interrupt();
    } catch (error) {
      if (!this.isIgnorableInterruptedRunError(error)) {
        this.logger.debug(
          `Interrupt request failed for session ${sessionId}: ${String(error)}`,
        );
      }
    }

    try {
      run.query.close();
    } catch (error) {
      this.logger.debug(
        `Closing interrupted query failed for session ${sessionId}: ${String(error)}`,
      );
    }
  }
}

const MAX_PROJECT_KEY_LENGTH = 200;

function sanitizeClaudeProjectPath(worktreePath: string): string {
  const encoded = worktreePath.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_PROJECT_KEY_LENGTH) {
    return encoded;
  }
  const hash = Math.abs(hashString(encoded)).toString(36);
  return `${encoded.slice(0, MAX_PROJECT_KEY_LENGTH)}-${hash}`;
}

function serializeToolResultContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          return b['text'];
        }
        if (b['type'] === 'image') {
          return '[image]';
        }
      }
      try {
        return JSON.stringify(block);
      } catch {
        return String(block);
      }
    });
    return parts.filter((p) => p.length > 0).join('\n\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}

function flushIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export function loadClaudeSdkPackageMetadata(): ClaudeSdkPackageMetadata {
  const runtimeRoot = getBackendRuntimeRoot();
  const candidates = new Set<string>([
    join(
      runtimeRoot,
      'apps',
      'backend',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
    join(
      runtimeRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
  ]);

  const packageAnchors = [
    join(runtimeRoot, 'package.json'),
    join(runtimeRoot, 'apps', 'backend', 'package.json'),
    join(__dirname, '..', '..', '..', 'package.json'),
    join(__dirname, '..', '..', '..', '..', '..', 'package.json'),
  ];

  for (const packageAnchor of packageAnchors) {
    try {
      const scopedRequire = createRequire(packageAnchor);
      candidates.add(scopedRequire.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    } catch {
      // Ignore missing package resolution for this anchor and continue searching.
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as ClaudeSdkPackageMetadata;
    } catch {
      // Try next package location.
    }
  }

  return { version: 'unknown' };
}
