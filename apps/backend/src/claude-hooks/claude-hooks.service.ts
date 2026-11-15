import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter } from 'events';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreeContextService } from '../worktree-context/worktree-context.service.js';
import { SessionTitleService } from '../session-title/session-title.service.js';

export type ClaudeActivityStatus = 'running' | 'idle' | 'waiting';
export type ClaudeActivityActionKind = 'permission' | 'user_input' | null;

export interface ClaudeSessionActivity {
  activityStatus: ClaudeActivityStatus;
  actionKind: ClaudeActivityActionKind;
  actionLabel: string | null;
  /**
   * Work still executing in the background while `activityStatus` describes the
   * main turn. The two are independent: a session can be parked on a question
   * (`waiting`) with several agents still running behind it. Without this the
   * sidebar reports only the blocked turn and the session reads as stalled.
   */
  backgroundActive: boolean;
  /** Terminal turn failure; optional for older status consumers. */
  failed?: boolean;
}

interface StatusEntry {
  status: ClaudeActivityStatus;
  updatedAt: number;
  actionKind: ClaudeActivityActionKind;
  failed: boolean;
}

interface UpdateStatusOptions {
  markCompletion?: boolean;
  requireRunning?: boolean;
  actionKind?: ClaudeActivityActionKind;
  failed?: boolean;
}

interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  source?: string;
  notification_type?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  [key: string]: unknown;
}

export interface ClaudeHookResponse {
  continue: boolean;
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
    sessionTitle?: string;
  };
}

interface HandleHookEventOptions {
  origin?: 'tui' | 'unknown';
}

@Injectable()
export class ClaudeHooksService extends EventEmitter {
  private readonly logger = new Logger('ClaudeHooksService');
  private statuses = new Map<number, StatusEntry>();
  private readonly terminalAgents = new Map<number, Set<string>>();
  private runtimeActivities = new Map<number, ClaudeSessionActivity>();
  private readonly invalidatedSessions = new Set<number>();
  private readonly sessionGenerations = new Map<number, number>();
  private readonly userPromptSubmitInFlight = new Map<
    number,
    Promise<ClaudeHookResponse>
  >();
  private readonly sessionTitleInFlight = new Map<number, Promise<void>>();

  constructor(
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly worktreeContextService: WorktreeContextService,
    private readonly sessionTitleService: SessionTitleService,
  ) {
    super();
  }

  async updateStatus(
    sessionId: number,
    status: ClaudeActivityStatus,
    options: UpdateStatusOptions = {},
  ): Promise<void> {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }
    const generation = this.sessionGeneration(sessionId);

    const { markCompletion = true } = options;
    const prev = this.statuses.get(sessionId);

    // Only transition to 'waiting' from 'running'. A Notification that
    // arrives while idle (or after a fresh restart with no prior status) is
    // just Claude's idle-prompt notification, not a real permission request.
    if (
      status === 'waiting' &&
      options.requireRunning !== false &&
      prev?.status !== 'running'
    ) {
      return;
    }

    const actionKind =
      status === 'waiting' ? (options.actionKind ?? null) : null;
    const failed = options.failed === true;
    if (
      prev?.status === status &&
      prev.actionKind === actionKind &&
      prev.failed === failed
    )
      return;

    const changedAt = new Date().toISOString();
    const entry = { status, updatedAt: Date.now(), actionKind, failed };
    this.statuses.set(sessionId, entry);
    // Publish live activity before persistence: slow metadata writes must not
    // delay status delivery. A failed write below clears this provisional state.
    this.emitStatusChanged(sessionId);
    try {
      await this.sessionsService.markLastStateChange(sessionId, changedAt);
    } catch (error) {
      if (
        !this.ownsSession(sessionId, generation) ||
        this.statuses.get(sessionId) !== entry
      )
        return;
      this.clearStatus(sessionId);
      this.logger.warn(
        `Ignoring Claude hook status update for missing session ${sessionId}: ${String(error)}`,
      );
      return;
    }
    if (
      !this.ownsSession(sessionId, generation) ||
      this.statuses.get(sessionId) !== entry
    )
      return;
    this.logger.debug(
      `Session ${sessionId}: ${prev?.status ?? 'unknown'} → ${status}`,
    );

    if (
      this.ownsSession(sessionId, generation) &&
      markCompletion &&
      !failed &&
      status === 'idle' &&
      (prev?.status === 'running' || prev?.status === 'waiting')
    ) {
      try {
        await this.sessionsService.markCompletionUnreviewed(
          sessionId,
          'completed',
        );
      } catch (error) {
        this.logger.warn(
          `Failed to mark session ${sessionId} completion as unreviewed: ${String(error)}`,
        );
      }
    }
  }

  getStatus(sessionId: number): ClaudeActivityStatus {
    return this.getActivity(sessionId).activityStatus;
  }

  getActivity(sessionId: number): ClaudeSessionActivity {
    const runtimeActivity = this.runtimeActivities.get(sessionId);
    if (runtimeActivity && runtimeActivity.activityStatus !== 'idle') {
      return runtimeActivity;
    }

    // An idle runtime activity is still retained when it carries background
    // work, so let the hook-driven status win while keeping that flag.
    const hook = this.statuses.get(sessionId);
    return {
      activityStatus: hook?.status ?? 'idle',
      actionKind: hook?.actionKind ?? null,
      actionLabel:
        hook?.actionKind === 'permission'
          ? 'Permission needed'
          : hook?.actionKind === 'user_input'
            ? 'Input needed'
            : null,
      ...(hook?.failed ? { failed: true } : {}),
      backgroundActive:
        (runtimeActivity?.backgroundActive ?? false) ||
        !!this.terminalAgents.get(sessionId)?.size,
    };
  }

  updateRuntimeActivity(
    sessionId: number,
    activity: ClaudeSessionActivity,
    options: { authoritative?: boolean; provider?: string } = {},
  ): void {
    if (this.invalidatedSessions.has(sessionId)) return;
    const previous = this.getActivity(sessionId);
    // Native providers own their turn state. A leftover TUI hook must not
    // revive a running indicator after their runtime has returned to idle.
    if (options.authoritative) {
      this.statuses.delete(sessionId);
      this.terminalAgents.delete(sessionId);
    }
    if (activity.activityStatus === 'idle' && !activity.backgroundActive) {
      this.runtimeActivities.delete(sessionId);
    } else {
      this.runtimeActivities.set(sessionId, activity);
    }

    const current = this.getActivity(sessionId);
    if (
      previous.activityStatus === current.activityStatus &&
      previous.actionKind === current.actionKind &&
      previous.actionLabel === current.actionLabel &&
      previous.backgroundActive === current.backgroundActive &&
      previous.failed === current.failed
    ) {
      return;
    }

    this.emitStatusChanged(sessionId, options.provider);
  }

  async handleHookEvent(
    sessionId: number,
    payload: ClaudeHookPayload,
    options: HandleHookEventOptions = {},
  ): Promise<ClaudeHookResponse> {
    if (this.invalidatedSessions.has(sessionId)) {
      return this.emptyHookResponse();
    }
    const generation = this.sessionGeneration(sessionId);

    const startedAtMs = Date.now();
    this.logger.debug(
      `Hook bridge received session=${sessionId} event=${payload.hook_event_name ?? 'unknown'} details=${JSON.stringify(this.summarizeHookPayload(payload))}`,
    );

    this.emit('hook-event', {
      sessionId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();

    // Only persist the session ID on SessionStart — it is the canonical event
    // that identifies which session the PTY is actually running.  Other events
    // (e.g. InstructionsLoaded) can carry a different session ID when Claude
    // Code branches on resume, which would overwrite the correct ID in the DB
    // and break the transcript view.
    const claudeSessionId = payload.session_id?.trim();
    if (claudeSessionId && payload.hook_event_name === 'SessionStart') {
      try {
        await this.sessionsService.updateClaudeSessionId(
          sessionId,
          claudeSessionId,
        );
      } catch (error) {
        if (!this.ownsSession(sessionId, generation))
          return this.emptyHookResponse();
        this.clearStatus(sessionId);
        this.logger.warn(
          `Failed to persist Claude session id for session ${sessionId}: ${String(error)}`,
        );
        return this.emptyHookResponse();
      }
    }
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();

    const event = payload.hook_event_name;
    let status: ClaudeActivityStatus | null = null;

    // Terminal children can outlive the main turn. Track only the TUI bridge;
    // native harnesses supply their own authoritative background-work snapshot.
    if (
      options.origin === 'tui' &&
      (event === 'SubagentStart' || event === 'SubagentStop')
    ) {
      const agentId = payload.agent_id;
      if (
        typeof agentId === 'string' &&
        agentId.length > 0 &&
        agentId.length <= 256
      ) {
        const before = this.getActivity(sessionId).backgroundActive;
        const agents = this.terminalAgents.get(sessionId) ?? new Set<string>();
        if (event === 'SubagentStart') agents.add(agentId);
        else agents.delete(agentId);
        if (agents.size) this.terminalAgents.set(sessionId, agents);
        else this.terminalAgents.delete(sessionId);
        if (this.getActivity(sessionId).backgroundActive !== before)
          this.emitStatusChanged(sessionId);
      }
    }
    if (event === 'SessionEnd' && this.terminalAgents.delete(sessionId))
      this.emitStatusChanged(sessionId);
    const statusOptions: UpdateStatusOptions = {};
    switch (event) {
      case 'PreToolUse':
        status =
          payload['tool_name'] === 'AskUserQuestion' ? 'waiting' : 'running';
        if (status === 'waiting') {
          statusOptions.requireRunning = false;
          statusOptions.actionKind = 'user_input';
        }
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'ElicitationResult':
      case 'TaskCreated':
        status = 'running';
        break;
      case 'PermissionRequest':
      case 'Elicitation':
        status = 'waiting';
        statusOptions.requireRunning = false;
        statusOptions.actionKind =
          event === 'PermissionRequest' ? 'permission' : 'user_input';
        break;
      case 'Notification':
        // Authentication, idle reminders and informational notices are not
        // pending decisions. Keep untyped notifications for older hook bridges.
        if (
          !payload.notification_type ||
          payload.notification_type === 'permission_prompt' ||
          payload.notification_type === 'elicitation_dialog'
        ) {
          status = 'waiting';
          statusOptions.actionKind =
            payload.notification_type === 'elicitation_dialog'
              ? 'user_input'
              : 'permission';
        }
        break;
      case 'StopFailure':
        status = 'idle';
        statusOptions.failed = true;
        statusOptions.markCompletion = false;
        break;
      case 'SessionEnd':
        statusOptions.markCompletion = false;
        status = 'idle';
        break;
      case 'Stop':
        status = 'idle';
        break;
      // Task/subagent lifecycle events do not end or resume the main turn.
      default:
        break;
    }

    if (status) {
      await this.updateStatus(sessionId, status, statusOptions);
    }
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();

    let response = this.emptyHookResponse();
    if (event === 'UserPromptSubmit' && options.origin === 'tui') {
      response = await this.handleUserPromptSubmit(
        sessionId,
        payload,
        generation,
      );
    }
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();

    this.logger.debug(
      `Hook bridge processed session=${sessionId} event=${payload.hook_event_name ?? 'unknown'} elapsedMs=${Date.now() - startedAtMs} status=${status ?? 'unchanged'}`,
    );
    return response;
  }

  async handleInterrupt(sessionId: number): Promise<void> {
    await this.updateStatus(sessionId, 'idle', { markCompletion: false });
  }

  getAllStatuses(): Record<number, ClaudeActivityStatus> {
    const result: Record<number, ClaudeActivityStatus> = {};
    const ids = new Set([
      ...this.statuses.keys(),
      ...this.runtimeActivities.keys(),
      ...this.terminalAgents.keys(),
    ]);
    for (const id of ids) {
      result[id] = this.getActivity(id).activityStatus;
    }
    return result;
  }

  getAllActivities(): Record<number, ClaudeSessionActivity> {
    const result: Record<number, ClaudeSessionActivity> = {};
    const ids = new Set([
      ...this.statuses.keys(),
      ...this.runtimeActivities.keys(),
      ...this.terminalAgents.keys(),
    ]);
    for (const id of ids) {
      result[id] = this.getActivity(id);
    }
    return result;
  }

  clearStatus(sessionId: number): void {
    this.sessionGenerations.set(
      sessionId,
      this.sessionGeneration(sessionId) + 1,
    );
    this.invalidatedSessions.add(sessionId);
    this.userPromptSubmitInFlight.delete(sessionId);
    this.sessionTitleInFlight.delete(sessionId);
    this.statuses.delete(sessionId);
    this.runtimeActivities.delete(sessionId);
    this.terminalAgents.delete(sessionId);
    this.emitStatusChanged(sessionId);
  }

  reactivateSession(sessionId: number): void {
    // Keep the generation advanced by clearStatus so old continuations stay stale.
    this.invalidatedSessions.delete(sessionId);
  }

  private sessionGeneration(sessionId: number): number {
    return this.sessionGenerations.get(sessionId) ?? 0;
  }

  private ownsSession(sessionId: number, generation: number): boolean {
    return (
      !this.invalidatedSessions.has(sessionId) &&
      this.sessionGeneration(sessionId) === generation
    );
  }

  private emitStatusChanged(sessionId: number, provider?: string): void {
    const activity = this.getActivity(sessionId);
    this.emit('status-changed', {
      sessionId,
      status: activity.activityStatus,
      ...activity,
      ...(provider ? { provider } : {}),
    });
  }

  private handleUserPromptSubmit(
    sessionId: number,
    payload: ClaudeHookPayload,
    generation: number,
  ): Promise<ClaudeHookResponse> {
    const existing = this.userPromptSubmitInFlight.get(sessionId);
    if (existing) {
      return existing;
    }

    const promise = this.handleUserPromptSubmitInternal(
      sessionId,
      payload,
      generation,
    )
      .catch((error) => {
        this.logger.warn(
          `Failed to prepare TUI prompt hook response for session ${sessionId}: ${String(error)}`,
        );
        return this.emptyHookResponse();
      })
      .finally(() => {
        if (this.userPromptSubmitInFlight.get(sessionId) === promise) {
          this.userPromptSubmitInFlight.delete(sessionId);
        }
      });

    this.userPromptSubmitInFlight.set(sessionId, promise);
    return promise;
  }

  private async handleUserPromptSubmitInternal(
    sessionId: number,
    payload: ClaudeHookPayload,
    generation: number,
  ): Promise<ClaudeHookResponse> {
    const prompt = this.extractUserPrompt(payload);
    if (!prompt.trim()) {
      return this.emptyHookResponse();
    }

    const session = await this.sessionsService.findOne(sessionId);
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();
    this.scheduleSessionTitleGeneration(sessionId, session, prompt, generation);
    const contextSentence = await this.prepareWorktreeContext(
      sessionId,
      session,
      prompt,
      generation,
    );
    if (!this.ownsSession(sessionId, generation))
      return this.emptyHookResponse();

    const hookSpecificOutput: ClaudeHookResponse['hookSpecificOutput'] = {
      hookEventName: 'UserPromptSubmit',
    };
    if (contextSentence) {
      hookSpecificOutput.additionalContext =
        this.buildAdditionalContext(contextSentence);
    }

    const hasHookOutput = Boolean(hookSpecificOutput.additionalContext);
    return hasHookOutput
      ? { continue: true, hookSpecificOutput }
      : this.emptyHookResponse();
  }

  private scheduleSessionTitleGeneration(
    sessionId: number,
    session: { name: string | null; worktreePath: string },
    prompt: string,
    generation: number,
  ): void {
    if (!this.sessionTitleService.isAutoGeneratedName(session.name)) {
      this.logger.debug(
        `TUI session title generation skipped session=${sessionId} reason=current_name_not_auto currentName=${JSON.stringify(session.name)}`,
      );
      return;
    }
    if (this.sessionTitleInFlight.has(sessionId)) {
      this.logger.debug(
        `TUI session title generation skipped session=${sessionId} reason=in_flight`,
      );
      return;
    }

    this.logger.log(
      `TUI session title generation scheduled session=${sessionId} worktreePath=${JSON.stringify(session.worktreePath)} promptLength=${prompt.length}`,
    );
    const scheduled = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.prepareSessionTitle(sessionId, session, prompt, generation)
          .catch((error) => {
            this.logger.warn(
              `Background TUI session title generation failed for session ${sessionId}: ${String(error)}`,
            );
          })
          .finally(resolve);
      });
    });
    const tracked = scheduled.finally(() => {
      if (this.sessionTitleInFlight.get(sessionId) === tracked) {
        this.sessionTitleInFlight.delete(sessionId);
      }
    });
    this.sessionTitleInFlight.set(sessionId, tracked);
  }

  private async prepareWorktreeContext(
    sessionId: number,
    session: {
      repoId: number;
      worktreePath: string;
      hasInjectedWorktreeContext: boolean;
    },
    prompt: string,
    generation: number,
  ): Promise<string | null> {
    if (
      session.hasInjectedWorktreeContext ||
      prompt.trimStart().startsWith('/')
    ) {
      return null;
    }

    try {
      let snapshot = await this.worktreeContextService.getCachedSnapshot(
        session.repoId,
        session.worktreePath,
      );
      if (!this.ownsSession(sessionId, generation)) return null;
      if (snapshot.generationStatus !== 'ready' || !snapshot.contextSentence) {
        snapshot = await this.worktreeContextService.generate(
          session.repoId,
          session.worktreePath,
          { provider: 'claude' },
        );
      }
      if (!this.ownsSession(sessionId, generation)) return null;

      const sentence = snapshot.contextSentence?.trim();
      if (snapshot.generationStatus !== 'ready' || !sentence) {
        return null;
      }

      const consumed = await this.worktreeContextService.consumeForSession(
        sessionId,
        true,
        sentence,
      );
      if (!this.ownsSession(sessionId, generation)) return null;
      return consumed.shouldInject
        ? (consumed.contextSentence ?? sentence).trim()
        : null;
    } catch (error) {
      this.logger.warn(
        `Failed to prepare TUI worktree context for session ${sessionId}: ${String(error)}`,
      );
      return null;
    }
  }

  private async prepareSessionTitle(
    sessionId: number,
    session: { name: string | null; worktreePath: string },
    prompt: string,
    generation: number,
  ): Promise<string | null> {
    if (!this.ownsSession(sessionId, generation)) {
      this.logger.warn(
        `TUI session title generation skipped session=${sessionId} reason=invalidated_before_start`,
      );
      return null;
    }
    if (!this.sessionTitleService.isAutoGeneratedName(session.name)) {
      this.logger.debug(
        `TUI session title generation skipped session=${sessionId} reason=current_name_not_auto currentName=${JSON.stringify(session.name)}`,
      );
      return null;
    }

    try {
      this.logger.log(
        `TUI session title generation started session=${sessionId} worktreePath=${JSON.stringify(session.worktreePath)} promptLength=${prompt.length}`,
      );
      const title = await this.sessionTitleService.generate(
        session.worktreePath,
        prompt,
        'claude',
      );
      if (!title) {
        this.logger.warn(
          `TUI session title generation produced no title session=${sessionId}`,
        );
        return null;
      }
      if (!this.ownsSession(sessionId, generation)) {
        this.logger.warn(
          `TUI session title generation skipped session=${sessionId} reason=invalidated_before_save title=${JSON.stringify(title)}`,
        );
        return null;
      }

      const updated = await this.sessionsService.renameFromGeneratedTitle(
        sessionId,
        title,
      );
      this.logger.log(
        `TUI session title generation saved session=${sessionId} title=${JSON.stringify(title)} persistedName=${JSON.stringify(updated?.name ?? null)}`,
      );
      return updated?.name === title ? title : null;
    } catch (error) {
      this.logger.warn(
        `Failed to prepare TUI session title for session ${sessionId}: ${String(error)}`,
      );
      return null;
    }
  }

  private extractUserPrompt(payload: ClaudeHookPayload): string {
    for (const key of ['prompt', 'user_prompt', 'message']) {
      const value = payload[key];
      if (typeof value === 'string') {
        return value;
      }
    }
    return '';
  }

  private buildAdditionalContext(contextSentence: string): string {
    return [
      '<elevenex-worktree-context>',
      `Context for this session: ${contextSentence}`,
      '</elevenex-worktree-context>',
    ].join('\n');
  }

  private emptyHookResponse(): ClaudeHookResponse {
    return { continue: true };
  }

  private summarizeHookPayload(
    payload: ClaudeHookPayload,
  ): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      source: payload.source ?? null,
      notificationType: payload.notification_type ?? null,
      sessionId: payload.session_id ?? null,
      cwd: payload.cwd ?? null,
      permissionMode: payload.permission_mode ?? null,
      agentId: payload.agent_id ?? null,
      agentType: payload.agent_type ?? null,
    };

    const interestingKeys = [
      'tool_name',
      'tool_use_id',
      'matcher',
      'hook_matcher',
      'hook_name',
      'command',
      'commands',
      'timeout_ms',
      'mcp_server_name',
    ];

    for (const key of interestingKeys) {
      const value = payload[key];
      if (value == null) {
        continue;
      }
      summary[key] =
        typeof value === 'string' && value.length > 240
          ? `${value.slice(0, 240)}...`
          : value;
    }

    summary['payloadKeys'] = Object.keys(payload).sort();
    return summary;
  }
}
