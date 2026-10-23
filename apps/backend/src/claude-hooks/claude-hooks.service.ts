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
}

interface StatusEntry {
  status: ClaudeActivityStatus;
  updatedAt: number;
}

interface UpdateStatusOptions {
  markCompletion?: boolean;
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
    if (status === 'waiting' && prev?.status !== 'running') {
      return;
    }

    if (prev?.status === status) return; // No change

    const changedAt = new Date().toISOString();
    const entry = { status, updatedAt: Date.now() };
    this.statuses.set(sessionId, entry);
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
    this.emitStatusChanged(sessionId);

    if (
      this.ownsSession(sessionId, generation) &&
      markCompletion &&
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
    return {
      activityStatus: this.statuses.get(sessionId)?.status ?? 'idle',
      actionKind: null,
      actionLabel: null,
      backgroundActive: runtimeActivity?.backgroundActive ?? false,
    };
  }

  updateRuntimeActivity(
    sessionId: number,
    activity: ClaudeSessionActivity,
    options: { authoritative?: boolean } = {},
  ): void {
    const previous = this.getActivity(sessionId);
    // Native providers own their turn state. A leftover TUI hook must not
    // revive a running indicator after their runtime has returned to idle.
    if (options.authoritative) this.statuses.delete(sessionId);
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
      previous.backgroundActive === current.backgroundActive
    ) {
      return;
    }

    this.emitStatusChanged(sessionId);
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

    switch (event) {
      case 'PreToolUse':
      case 'UserPromptSubmit':
      case 'SubagentStart':
      case 'TaskCreated':
        status = 'running';
        break;
      case 'PermissionRequest':
      case 'Elicitation':
      case 'Notification':
        status = 'waiting';
        break;
      case 'ElicitationResult':
      case 'TaskCompleted':
      case 'Stop':
        status = 'idle';
        break;
      default:
        break;
    }

    if (status) {
      await this.updateStatus(sessionId, status);
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

  private emitStatusChanged(sessionId: number): void {
    const activity = this.getActivity(sessionId);
    this.emit('status-changed', {
      sessionId,
      status: activity.activityStatus,
      ...activity,
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
