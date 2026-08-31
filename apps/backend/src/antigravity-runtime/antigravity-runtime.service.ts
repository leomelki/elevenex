import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { SessionsService } from '../sessions/sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';
import {
  ClaudeHooksService,
  type ClaudeSessionActivity,
} from '../claude-hooks/claude-hooks.service.js';
import { resolveAgentStartupSelection } from '../agent-runtime/agent-model-defaults.js';
import type {
  AgentImageInput,
  AgentProviderModelCatalogPayload,
} from '../agent-runtime/agent-runtime.types.js';
import type {
  ClaudeAutocompleteItem,
  ClaudeMcpSnapshot,
  ClaudePermissionMode,
  ClaudeToolInteractionSummary,
  ClaudeTranscriptItem,
} from '../claude-runtime/claude-runtime.types.js';
import { AntigravityAuthService } from './antigravity-auth.service.js';
import { AntigravityMcpService } from './antigravity-mcp.service.js';
import {
  AntigravityProcessClient,
  type AntigravityProcessOptions,
} from './antigravity-process-client.js';
import {
  canonicalizeAntigravityTool,
  toolInfoErrorMessage,
  toolInfoIsComplete,
  toolInfoResultText,
} from './antigravity-transcript.js';
import type {
  AntigravityResultEvent,
  AntigravityRuntimeSessionMetadata,
  AntigravityRuntimeState,
  AntigravityRuntimeStatePayload,
  AntigravitySessionSnapshotPayload,
  AntigravityStepUpdateEvent,
  AntigravityStreamEvent,
} from './antigravity-runtime.types.js';

const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_RUNTIME_CAP = 20;

interface AntigravityActiveRun {
  interruptRequested: boolean;
}

interface AntigravityRuntimeEntry {
  process: AntigravityProcessClient;
  sessionId: number;
  worktreePath: string;
  attachedClients: number;
  idleTimer: NodeJS.Timeout | null;
  lastIdleAt: number;
}

/**
 * Orchestrates `agy` sessions, mirroring `GeminiRuntimeService`'s shape (one
 * process per Elevenex session, idle-shutdown + idle-cap, activeRuns/
 * pendingPrompts queueing) but driving `AntigravityProcessClient`'s flat
 * event stream instead of ACP.
 *
 * Two structural differences from Gemini worth calling out:
 * - There is no `session/load` resume: every process start is a fresh
 *   conversation. `state.antigravitySessionId` is captured from the `init`
 *   event (when present) purely for future use once `--conversation <id>`
 *   resume is verified against a live binary — it is not used to resume yet.
 * - There is no interactive permission channel, so history/transcript state
 *   is accumulated in-memory per session (`sessionHistories`) rather than
 *   read back from an on-disk conversation log the way Gemini/Codex do.
 *   That history is lost on backend restart — a known limitation, see
 *   docs/antigravity-provider-flow.md.
 */
@Injectable()
export class AntigravityRuntimeService
  extends EventEmitter
  implements OnModuleDestroy
{
  private readonly logger = new Logger(AntigravityRuntimeService.name);
  private readonly runtimes = new Map<number, AntigravityRuntimeEntry>();
  private readonly runtimeStates = new Map<number, AntigravityRuntimeState>();
  private readonly sessionHistories = new Map<number, ClaudeTranscriptItem[]>();
  private readonly activeRuns = new Map<number, AntigravityActiveRun>();
  private readonly initializingRuns = new Set<number>();
  private readonly clientCounts = new Map<number, number>();
  /**
   * Live `agy` `step_index` → transcript `toolUseId`, per session. A tool call
   * spans several `step_update` events sharing one `step_index`; this maps
   * them onto a single card. Entries are removed as each call settles and the
   * whole per-session map is dropped when a turn ends.
   */
  private readonly toolCallIds = new Map<number, Map<number, string>>();
  private readonly runtimeStartInFlight = new Map<
    number,
    Promise<AntigravityProcessClient>
  >();

  private readonly idleShutdownMs =
    Number(process.env.ANTIGRAVITY_RUNTIME_IDLE_MS) ||
    DEFAULT_IDLE_SHUTDOWN_MS;
  private readonly idleRuntimeCap =
    Number(process.env.ANTIGRAVITY_RUNTIME_IDLE_CAP) ||
    DEFAULT_IDLE_RUNTIME_CAP;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly authService: AntigravityAuthService,
    private readonly mcpService: AntigravityMcpService,
    private readonly hooksService: ClaudeHooksService,
    private readonly titleService: SessionTitleService,
    private readonly settingsService: SettingsService,
  ) {
    super();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((id) => this.stopRuntime(id)),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Provider surface                                                        */
  /* ---------------------------------------------------------------------- */

  getHistory(sessionId: number): Promise<ClaudeTranscriptItem[]> {
    return Promise.resolve([...(this.sessionHistories.get(sessionId) ?? [])]);
  }

  async getRuntimeState(
    sessionId: number,
  ): Promise<AntigravityRuntimeStatePayload> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(
      sessionId,
      session.antigravitySessionId,
    );
    state.cachedWorktreePath = session.worktreePath;
    state.authStatus = await this.authService.getStatus();
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async getSnapshot(
    sessionId: number,
  ): Promise<AntigravitySessionSnapshotPayload> {
    const [history, runtimeState] = await Promise.all([
      this.getHistory(sessionId),
      this.getRuntimeState(sessionId),
    ]);
    return { ...runtimeState, history };
  }

  getAutocompleteItems(_sessionId: number): Promise<ClaudeAutocompleteItem[]> {
    // No documented slash-command listing event in `agy`'s headless stream.
    return Promise.resolve([]);
  }

  getModelCatalog(): AgentProviderModelCatalogPayload {
    // Real model ids are not confirmed against a live install (see
    // docs/antigravity-provider-flow.md) — report "unavailable" honestly
    // rather than fabricate a catalog that could send a bad `--model` value.
    return {
      models: [],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: false,
      unavailableReason:
        'Antigravity model list is not yet available — leave unset to use the CLI default.',
    };
  }

  async setSelectedModel(
    sessionId: number,
    model: string | null,
  ): Promise<AntigravityRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    if (state.selectedModel !== model) {
      state.selectedModel = model;
      await this.restartWarmRuntimeForConfigChange(sessionId);
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPermissionMode(
    sessionId: number,
    mode: ClaudePermissionMode | null,
  ): Promise<AntigravityRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    if (state.permissionMode !== mode) {
      state.permissionMode = mode;
      await this.restartWarmRuntimeForConfigChange(sessionId);
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setPlanMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<AntigravityRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    if (state.planMode !== enabled) {
      state.planMode = enabled;
      await this.restartWarmRuntimeForConfigChange(sessionId);
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  async setReasoningEffort(
    sessionId: number,
    effort: string | null,
  ): Promise<AntigravityRuntimeStatePayload> {
    const state = this.ensureRuntimeState(sessionId);
    if (state.reasoningEffort !== effort) {
      state.reasoningEffort = effort;
      await this.restartWarmRuntimeForConfigChange(sessionId);
    }
    this.emitRunState(sessionId);
    return this.toRuntimeStatePayload(sessionId, state);
  }

  setFastMode(
    sessionId: number,
    enabled: boolean,
  ): Promise<AntigravityRuntimeStatePayload> {
    // Recorded for the picker only — `agy` has no fast-mode equivalent.
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
    if (!trimmed) return;
    if (images?.length) {
      this.logger.warn(
        `Antigravity does not support image attachments yet; dropping ${images.length} image(s) session=${sessionId}`,
      );
    }

    if (
      this.activeRuns.has(sessionId) ||
      this.initializingRuns.has(sessionId)
    ) {
      this.queuePendingPrompt(sessionId, trimmed, images);
      return;
    }

    this.initializingRuns.add(sessionId);
    let state: AntigravityRuntimeState | null = null;
    let runRegistered = false;

    try {
      const session = await this.sessionsService.findOne(sessionId);
      const isNewSession =
        (!session.antigravitySessionId ||
          session.antigravitySessionId === '-1') &&
        this.titleService.isAutoGeneratedName(session.name);

      state = this.ensureRuntimeState(sessionId, session.antigravitySessionId);
      state.cachedWorktreePath = session.worktreePath;
      state.runPhase = 'running';
      state.sessionState = 'running';
      state.canInterrupt = true;
      state.lastError = null;
      state.liveItems = [];
      state.streamingAssistantMessageId = null;
      state.streamingThoughtMessageId = null;
      this.emitRunState(sessionId);

      const client = await this.ensureRuntime(sessionId);

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

      this.activeRuns.set(sessionId, { interruptRequested: false });
      runRegistered = true;
      this.initializingRuns.delete(sessionId);

      try {
        await this.sessionsService.updateStatus(sessionId, 'active');
        const result = await client.prompt(trimmed);
        this.handleTurnResult(sessionId, result);
      } catch (error) {
        const run = this.activeRuns.get(sessionId);
        if (run?.interruptRequested) {
          this.finalizeInterruptedRun(sessionId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
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

  private handleTurnResult(
    sessionId: number,
    result: AntigravityResultEvent,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    if (result.status === 'ERROR' || result.status === 'INVALID') {
      this.emitError(sessionId, result.error || 'Antigravity turn failed.');
      return;
    }
    // `agy` reports both a user-requested stop and its own mid-turn abort as
    // CANCELED. Only the former is an interrupt; the latter is what happens
    // when headless mode auto-denies a tool the agent needed, and reporting
    // it as a clean interrupt is what makes the chat look silently broken.
    const interrupted = this.activeRuns.get(sessionId)?.interruptRequested;
    if (
      result.status === 'INTERRUPTED' ||
      (result.status === 'CANCELED' && interrupted)
    ) {
      this.finalizeInterruptedRun(sessionId);
      return;
    }
    if (result.status === 'CANCELED') {
      this.emitError(sessionId, this.describeEmptyTurn(sessionId));
      return;
    }
    // `agy` streams prose as `text_delta` on `agent_response` steps and then
    // repeats the whole thing in `result.response`. Only fall back to the
    // final response when nothing streamed, so the text is not shown twice.
    if (!state.streamingAssistantMessageId && result.response) {
      this.pushItem(sessionId, {
        id: randomUUID(),
        kind: 'assistant',
        contentType: 'message',
        content: result.response,
        timestamp: new Date().toISOString(),
      });
      this.finishRun(sessionId);
      return;
    }

    // A turn where every tool call was auto-denied ends `SUCCESS` with an
    // empty response and no prose — the run just stops with nothing rendered.
    // Explain why instead of leaving the chat blank.
    if (!state.streamingAssistantMessageId && !result.response) {
      this.emitError(sessionId, this.describeEmptyTurn(sessionId));
      return;
    }
    this.finishRun(sessionId);
  }

  /**
   * Builds the message shown when a turn produced no output at all.
   *
   * The overwhelmingly common cause is `agy`'s headless permission policy:
   * outside `--dangerously-skip-permissions`, any tool needing approval is
   * auto-denied (there is no prompt channel in headless mode), so an agent
   * that decided to use a tool ends the turn empty.
   */
  private describeEmptyTurn(sessionId: number): string {
    const state = this.ensureRuntimeState(sessionId);
    const bypassing =
      state.permissionMode === 'bypassPermissions' ||
      state.permissionMode === 'dontAsk';
    if (bypassing) {
      return 'Antigravity finished the turn without producing any output.';
    }
    return (
      'Antigravity produced no output: it tried to use a tool, and `agy` ' +
      'auto-denies tool calls in headless mode unless permissions are ' +
      'bypassed. Switch this session\'s permission mode to "Bypass ' +
      'permissions" to let it run tools.'
    );
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
            `Pending Antigravity prompt failed session=${sessionId}: ${String(error)}`,
          );
        },
      );
    });
  }

  interrupt(sessionId: number): Promise<void> {
    const run = this.activeRuns.get(sessionId);
    if (!run) return Promise.resolve();
    run.interruptRequested = true;
    this.runtimes.get(sessionId)?.process.interrupt();
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
    // `agy` reads its MCP config once, at process start, same as Gemini.
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

  private async resolveWorktreePath(
    sessionId: number,
  ): Promise<string | null> {
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
  /* Runtime lifecycle                                                       */
  /* ---------------------------------------------------------------------- */

  private async ensureRuntime(
    sessionId: number,
  ): Promise<AntigravityProcessClient> {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      this.clearIdleTimer(existing);
      return existing.process;
    }
    const inFlight = this.runtimeStartInFlight.get(sessionId);
    if (inFlight) return inFlight;

    const promise = this.startRuntime(sessionId).finally(() => {
      this.runtimeStartInFlight.delete(sessionId);
    });
    this.runtimeStartInFlight.set(sessionId, promise);
    return promise;
  }

  private async startRuntime(
    sessionId: number,
  ): Promise<AntigravityProcessClient> {
    const session = await this.sessionsService.findOne(sessionId);
    const state = this.ensureRuntimeState(sessionId, session.antigravitySessionId);
    state.cachedWorktreePath = session.worktreePath;

    const options: AntigravityProcessOptions = {
      cwd: session.worktreePath,
      env: this.authService.getRuntimeEnv(),
      extraArgs: this.resolveSpawnArgs(state, session.worktreePath),
    };
    const client = new AntigravityProcessClient(options);
    const entry: AntigravityRuntimeEntry = {
      process: client,
      sessionId,
      worktreePath: session.worktreePath,
      attachedClients: this.clientCounts.get(sessionId) ?? 0,
      idleTimer: null,
      lastIdleAt: Date.now(),
    };
    this.runtimes.set(sessionId, entry);

    client.on('step_event', (event: AntigravityStreamEvent) => {
      this.handleStepEvent(sessionId, event);
    });
    client.on('exit', (details: { message?: string; stderr?: string }) => {
      this.handleRuntimeExit(sessionId, details);
    });

    try {
      await client.start();
    } catch (error) {
      this.runtimes.delete(sessionId);
      await client.stop().catch(() => undefined);
      throw error;
    }

    this.enforceIdleRuntimeCap();
    return client;
  }

  /** Maps the session's permission/model/effort selection onto spawn flags. */
  private resolveSpawnArgs(
    state: AntigravityRuntimeState,
    worktreePath: string,
  ): string[] {
    // `agy` does not treat its own process cwd as the workspace: without an
    // explicit `--add-dir` it works out of an empty scratch directory
    // (`~/.gemini/antigravity-cli/scratch`), so the agent cannot see the
    // repository at all and reports it as empty. Adding the worktree is what
    // makes file and command tools operate on the session's code.
    const args: string[] = ['--add-dir', worktreePath];
    // `agy` has no headless approval channel: outside
    // `--dangerously-skip-permissions` every tool call needing approval is
    // auto-denied and the turn ends empty. `--mode` still selects the agent's
    // execution posture, so plan mode maps to `plan` and edit-accepting modes
    // to `accept-edits`.
    if (state.planMode) {
      args.push('--mode', 'plan');
    } else if (
      state.permissionMode === 'bypassPermissions' ||
      state.permissionMode === 'dontAsk'
    ) {
      args.push('--dangerously-skip-permissions');
    } else if (state.permissionMode === 'acceptEdits') {
      args.push('--mode', 'accept-edits');
    }
    if (state.selectedModel) args.push('--model', state.selectedModel);
    if (state.reasoningEffort) args.push('--effort', state.reasoningEffort);
    return args;
  }

  /** Restarts a warm process so a config change takes effect on the next prompt. */
  private async restartWarmRuntimeForConfigChange(
    sessionId: number,
  ): Promise<void> {
    if (this.activeRuns.has(sessionId)) return;
    await this.stopRuntime(sessionId).catch(() => undefined);
  }

  private async stopRuntime(sessionId: number): Promise<void> {
    const entry = this.runtimes.get(sessionId);
    if (!entry) return;
    this.runtimes.delete(sessionId);
    this.clearIdleTimer(entry);
    await entry.process.stop();
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

  private clearIdleTimer(entry: AntigravityRuntimeEntry): void {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  /**
   * Caps how many idle Antigravity processes linger. A repo with hundreds of
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
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    const stderr = details.stderr?.trim();
    this.emitError(
      sessionId,
      `${details.message ?? 'The Antigravity process exited.'}${
        stderr ? ` — ${stderr.slice(-500)}` : ''
      }`,
    );
  }

  async cleanupSession(sessionId: number): Promise<void> {
    await this.stopRuntime(sessionId);
    this.runtimeStates.delete(sessionId);
    this.sessionHistories.delete(sessionId);
    this.clientCounts.delete(sessionId);
    this.activeRuns.delete(sessionId);
    this.toolCallIds.delete(sessionId);
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

  /* ---------------------------------------------------------------------- */
  /* Stream event handling                                                   */
  /* ---------------------------------------------------------------------- */

  private handleStepEvent(
    sessionId: number,
    event: AntigravityStreamEvent,
  ): void {
    switch (event.type) {
      case 'init':
        this.handleInitEvent(sessionId, event as Record<string, unknown>);
        return;
      case 'step_update':
        this.handleStepUpdate(sessionId, event as AntigravityStepUpdateEvent);
        return;
      default:
        return;
    }
  }

  private handleInitEvent(
    sessionId: number,
    event: Record<string, unknown>,
  ): void {
    const conversationId = event['conversation_id'];
    if (typeof conversationId !== 'string' || !conversationId) return;
    const state = this.ensureRuntimeState(sessionId);
    if (state.antigravitySessionId === conversationId) return;
    state.antigravitySessionId = conversationId;
    void this.sessionsService
      .updateAntigravitySessionId(sessionId, conversationId)
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not persist the Antigravity conversation id session=${sessionId}: ${String(error)}`,
        );
      });
    this.emitSessionMetadata(sessionId);
  }

  private handleStepUpdate(
    sessionId: number,
    event: AntigravityStepUpdateEvent,
  ): void {
    if (event.tool_info) {
      this.handleToolInfo(
        sessionId,
        event.tool_info,
        event.step_index,
        event.state,
      );
      return;
    }
    if (typeof event.text_delta === 'string' && event.text_delta) {
      this.handleTextChunk(
        sessionId,
        event.text_delta,
        event.thought ? 'thinking' : 'assistant',
      );
    }
  }

  private handleTextChunk(
    sessionId: number,
    text: string,
    kind: 'assistant' | 'thinking',
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    const idField =
      kind === 'assistant'
        ? ('streamingAssistantMessageId' as const)
        : ('streamingThoughtMessageId' as const);
    const otherField =
      kind === 'assistant'
        ? ('streamingThoughtMessageId' as const)
        : ('streamingAssistantMessageId' as const);

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

  /**
   * Renders one `agy` tool call as one card.
   *
   * A tool call arrives as at least two `step_update` events sharing a
   * `step_index`: `state: 'ACTIVE'` when it starts (parameters only) and
   * `state: 'DONE' | 'ERROR'` when it settles (adding `output` or `error`).
   * `step_index` is therefore the correlation key — emitting a fresh
   * `tool_use` per event would show the same call twice.
   */
  private handleToolInfo(
    sessionId: number,
    info: NonNullable<AntigravityStepUpdateEvent['tool_info']>,
    stepIndex: number | undefined,
    stepState: string | undefined,
  ): void {
    const state = this.ensureRuntimeState(sessionId);
    state.streamingAssistantMessageId = null;
    state.streamingThoughtMessageId = null;

    const timestamp = new Date().toISOString();
    // A step without an index cannot be correlated, so it falls back to a
    // one-off card rather than merging into an unrelated call.
    const key = typeof stepIndex === 'number' ? stepIndex : null;
    const existing =
      key === null ? undefined : this.toolCallIds.get(sessionId)?.get(key);

    let toolUseId = existing;
    if (!toolUseId) {
      const canonical = canonicalizeAntigravityTool(info);
      toolUseId = randomUUID();
      if (key !== null) {
        let perSession = this.toolCallIds.get(sessionId);
        if (!perSession) {
          perSession = new Map<number, string>();
          this.toolCallIds.set(sessionId, perSession);
        }
        perSession.set(key, toolUseId);
      }
      this.pushItem(
        sessionId,
        {
          id: toolUseId,
          kind: 'tool_use',
          toolUseId,
          toolName: canonical.toolDisplayName,
          providerToolName: canonical.providerToolName,
          toolKind: canonical.toolKind,
          toolDisplayName: canonical.toolDisplayName,
          toolInput: canonical.toolInput,
          providerToolInput: info.parameters,
          timestamp,
        },
        'tool_use',
      );
    }

    // `ACTIVE` carries parameters only. Close the card on the settling event —
    // keying off `state` rather than the presence of `output`/`error`, because
    // a tool that headless mode auto-denied settles as `DONE` carrying
    // neither, which would otherwise leave the card spinning forever.
    const settled =
      stepState === 'DONE' || stepState === 'ERROR' || toolInfoIsComplete(info);
    if (stepState === 'ACTIVE' || !settled) return;

    const errorMessage = toolInfoErrorMessage(info);
    const isError = Boolean(errorMessage) || stepState === 'ERROR';
    this.pushItem(
      sessionId,
      {
        id: `${toolUseId}-result`,
        kind: 'tool_result',
        toolUseId,
        content: toolInfoResultText(info),
        ...(isError ? { isError: true } : {}),
        timestamp,
      },
      'tool_result',
    );
    if (key !== null) this.toolCallIds.get(sessionId)?.delete(key);
  }

  /* ---------------------------------------------------------------------- */
  /* State + events                                                          */
  /* ---------------------------------------------------------------------- */

  private ensureRuntimeState(
    sessionId: number,
    antigravitySessionId?: string | null,
  ): AntigravityRuntimeState {
    const existing = this.runtimeStates.get(sessionId);
    if (existing) {
      if (antigravitySessionId && antigravitySessionId !== '-1') {
        existing.antigravitySessionId = antigravitySessionId;
      }
      return existing;
    }

    const catalog = this.getModelCatalog();
    const startup = resolveAgentStartupSelection(
      this.settingsService.getAgentProviderDefaults('antigravity'),
      catalog.models,
      catalog.providerDefaultModelId,
    );

    const state: AntigravityRuntimeState = {
      antigravitySessionId:
        antigravitySessionId && antigravitySessionId !== '-1'
          ? antigravitySessionId
          : null,
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
      availableModels: catalog.models,
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
    // `step_index` restarts per turn, so stale entries would collide.
    this.toolCallIds.delete(sessionId);
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
    const metadata: AntigravityRuntimeSessionMetadata = {
      cwd: state.cachedWorktreePath ?? '',
      model: state.selectedModel ?? 'auto',
      permissionMode: state.planMode
        ? 'plan'
        : (state.permissionMode ?? 'default'),
      antigravityVersion: state.authStatus?.version ?? 'unknown',
      outputStyle: 'default',
      tools: [],
      slashCommands: [],
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
        pendingPermissionRequest: null,
        pendingUserInputRequest: state.pendingUserInputRequest,
        pendingPrompts: state.pendingPrompts,
      },
    });
  }

  private toSidebarActivity(
    state: AntigravityRuntimeState,
  ): ClaudeSessionActivity {
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
    state: AntigravityRuntimeState,
  ): AntigravityRuntimeStatePayload {
    const entry = this.runtimes.get(sessionId);
    return {
      sessionId,
      claudeSessionId: state.antigravitySessionId,
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
    const history = this.sessionHistories.get(sessionId) ?? [];
    this.sessionHistories.set(sessionId, [
      ...history.filter((existing) => existing.id !== item.id),
      item,
    ]);
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
    const history = this.sessionHistories.get(sessionId);
    if (history) {
      this.sessionHistories.set(
        sessionId,
        history.map((item) =>
          item.id === itemId
            ? { ...item, content: `${item.content ?? ''}${delta}` }
            : item,
        ),
      );
    }
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
        'antigravity',
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
