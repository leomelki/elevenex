import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { EventEmitter } from 'events';
import { SessionsService } from '../sessions/sessions.service.js';

export type ClaudeActivityStatus = 'running' | 'idle' | 'waiting';

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

@Injectable()
export class ClaudeHooksService extends EventEmitter {
  private readonly logger = new Logger('ClaudeHooksService');
  private statuses = new Map<number, StatusEntry>();
  private readonly invalidatedSessions = new Set<number>();

  constructor(
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
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
    this.statuses.set(sessionId, { status, updatedAt: Date.now() });
    try {
      await this.sessionsService.markLastStateChange(sessionId, changedAt);
    } catch (error) {
      this.invalidatedSessions.add(sessionId);
      this.statuses.delete(sessionId);
      this.logger.warn(
        `Ignoring Claude hook status update for missing session ${sessionId}: ${String(error)}`,
      );
      return;
    }
    this.logger.log(
      `Session ${sessionId}: ${prev?.status ?? 'unknown'} → ${status}`,
    );
    this.emit('status-changed', { sessionId, status });

    if (
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
    return this.statuses.get(sessionId)?.status ?? 'idle';
  }

  async handleHookEvent(
    sessionId: number,
    payload: ClaudeHookPayload,
  ): Promise<void> {
    if (this.invalidatedSessions.has(sessionId)) {
      return;
    }

    const startedAtMs = Date.now();
    this.logger.log(
      `Hook bridge received session=${sessionId} event=${payload.hook_event_name ?? 'unknown'} details=${JSON.stringify(this.summarizeHookPayload(payload))}`,
    );

    this.emit('hook-event', {
      sessionId,
      payload: payload as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });

    const claudeSessionId = payload.session_id?.trim();
    if (claudeSessionId) {
      try {
        await this.sessionsService.updateClaudeSessionId(
          sessionId,
          claudeSessionId,
        );
      } catch (error) {
        this.invalidatedSessions.add(sessionId);
        this.logger.warn(
          `Failed to persist Claude session id for session ${sessionId}: ${String(error)}`,
        );
        return;
      }
    }

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

    this.logger.log(
      `Hook bridge processed session=${sessionId} event=${payload.hook_event_name ?? 'unknown'} elapsedMs=${Date.now() - startedAtMs} status=${status ?? 'unchanged'}`,
    );
  }

  async handleInterrupt(sessionId: number): Promise<void> {
    await this.updateStatus(sessionId, 'idle', { markCompletion: false });
  }

  getAllStatuses(): Record<number, ClaudeActivityStatus> {
    const result: Record<number, ClaudeActivityStatus> = {};
    for (const [id, entry] of this.statuses) {
      result[id] = entry.status;
    }
    return result;
  }

  clearStatus(sessionId: number): void {
    this.invalidatedSessions.add(sessionId);
    this.statuses.delete(sessionId);
    this.emit('status-changed', { sessionId, status: 'idle' });
  }

  private summarizeHookPayload(payload: ClaudeHookPayload): Record<string, unknown> {
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
