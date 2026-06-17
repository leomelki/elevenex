import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { ToolError } from '../tool-registry/tool.types.js';

/** A notification pushed at the human (toast / panel item). */
export interface AgentNotification {
  id: string;
  agentSessionId: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Optional deep link to "Open" the relevant view. */
  deepLink?: string;
  createdAt: string;
}

/** Something the agent wants the human to look at (richer than a toast). */
export interface AgentShowRequest {
  id: string;
  agentSessionId: number;
  title: string;
  body?: string;
  deepLink?: string;
  createdAt: string;
}

/** A blocking decision the agent needs from the human. */
export interface AgentApprovalRequest {
  id: string;
  agentSessionId: number;
  title: string;
  detail?: string;
  /** Choices offered; defaults to approve/deny. */
  options: string[];
  deepLink?: string;
  createdAt: string;
}

export interface AgentApprovalResolution {
  id: string;
  /** The chosen option, or 'denied' on timeout/decline. */
  decision: string;
  note?: string;
}

/** Per-call sink handed to human-channel tools via `ToolContext.human`. */
export interface HumanChannel {
  notify(input: {
    level?: AgentNotification['level'];
    message: string;
    deepLink?: string;
  }): Promise<{ id: string }>;
  show(input: {
    title: string;
    body?: string;
    deepLink?: string;
  }): Promise<{ id: string }>;
  /** Blocks until the human answers or `timeoutMs` elapses (then resolves 'denied'). */
  requestApproval(input: {
    title: string;
    detail?: string;
    options?: string[];
    deepLink?: string;
    timeoutMs?: number;
  }): Promise<AgentApprovalResolution>;
}

/**
 * Backend hub for the agent→human channel. The agent panel (M5) subscribes to
 * its events to render notifications / escalations and calls `resolveApproval`
 * when the human answers. Tools never touch this directly — they get a
 * connection-bound `HumanChannel` view via `bindFor`.
 */
@Injectable()
export class AgentHumanChannelService extends EventEmitter {
  private readonly logger = new Logger(AgentHumanChannelService.name);
  private readonly pending = new Map<
    string,
    {
      resolve: (r: AgentApprovalResolution) => void;
      timer: NodeJS.Timeout;
      request: AgentApprovalRequest;
    }
  >();

  /** Snapshot of approvals still awaiting a human decision (panel restore). */
  pendingApprovals(agentSessionId?: number): AgentApprovalRequest[] {
    const all = [...this.pending.values()].map((p) => p.request);
    return agentSessionId === undefined
      ? all
      : all.filter((r) => r.agentSessionId === agentSessionId);
  }

  emitNotification(n: AgentNotification): void {
    this.emit('notification', n);
  }

  emitShow(s: AgentShowRequest): void {
    this.emit('show', s);
  }

  /** Called by the panel when the human answers an approval. */
  resolveApproval(resolution: AgentApprovalResolution): boolean {
    const entry = this.pending.get(resolution.id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(resolution.id);
    entry.resolve(resolution);
    this.emit('approval-resolved', resolution);
    return true;
  }

  private awaitApproval(
    request: AgentApprovalRequest,
    timeoutMs: number,
  ): Promise<AgentApprovalResolution> {
    return new Promise<AgentApprovalResolution>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(request.id)) {
          const resolution: AgentApprovalResolution = {
            id: request.id,
            decision: 'denied',
            note: 'timeout',
          };
          this.emit('approval-resolved', resolution);
          resolve(resolution);
        }
      }, timeoutMs);
      // Don't keep the event loop alive solely for a pending approval.
      timer.unref?.();
      // Register BEFORE emitting so a synchronous listener (e.g. an
      // immediately-answering panel/test) can resolve it without racing.
      this.pending.set(request.id, { resolve, timer, request });
      this.emit('approval', request);
    });
  }

  /**
   * Build the per-call `HumanChannel`. `canUseHumanChannel` is false for
   * anonymous clients — those tools throw a structured error instead of
   * silently dropping the human's attention request.
   */
  bindFor(args: {
    agentSessionId: number | null;
    canUseHumanChannel: boolean;
  }): HumanChannel {
    const { agentSessionId, canUseHumanChannel } = args;
    const guard = () => {
      if (!canUseHumanChannel || agentSessionId === null) {
        throw new ToolError({
          code: 'human_channel_unavailable',
          message:
            'This connection has no attached human surface (anonymous/external client).',
          remediation:
            'Run from an agent session (with ELEVENEX_AGENT_TOKEN) so notifications and approvals reach the panel.',
        });
      }
      return agentSessionId;
    };

    return {
      notify: async (input) => {
        guard();
        const id = randomUUID();
        const notification: AgentNotification = {
          id,
          agentSessionId: agentSessionId as number,
          level: input.level ?? 'info',
          message: input.message,
          deepLink: input.deepLink,
          createdAt: new Date().toISOString(),
        };
        this.emitNotification(notification);
        this.logger.debug(`notify[${agentSessionId}]: ${input.message}`);
        return { id };
      },
      show: async (input) => {
        guard();
        const id = randomUUID();
        this.emitShow({
          id,
          agentSessionId: agentSessionId as number,
          title: input.title,
          body: input.body,
          deepLink: input.deepLink,
          createdAt: new Date().toISOString(),
        });
        return { id };
      },
      requestApproval: async (input) => {
        guard();
        const request: AgentApprovalRequest = {
          id: randomUUID(),
          agentSessionId: agentSessionId as number,
          title: input.title,
          detail: input.detail,
          options: input.options ?? ['approve', 'deny'],
          deepLink: input.deepLink,
          createdAt: new Date().toISOString(),
        };
        // Cap the block so a never-answered escalation can't hang a tool call
        // forever; 10 minutes by default.
        return this.awaitApproval(request, input.timeoutMs ?? 10 * 60 * 1000);
      },
    };
  }
}
