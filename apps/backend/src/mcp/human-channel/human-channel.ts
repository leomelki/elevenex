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

/** What kinds of entries the human may pick in a selection request. */
export type SelectionKind = 'file' | 'folder' | 'any';

/**
 * A blocking request for the human to point the agent at file(s)/folder(s) via
 * the panel's interactive picker. Used when the agent genuinely can't resolve a
 * path itself. The human can pick paths, reply with free text, or hand the
 * decision back ("let the agent decide").
 */
export interface AgentSelectionRequest {
  id: string;
  agentSessionId: number;
  title: string;
  detail?: string;
  /** Absolute worktree/repo root the human browses from. */
  rootPath: string;
  /** Which entry kinds are pickable. */
  selectionKind: SelectionKind;
  /** Allow picking more than one entry. */
  multiple: boolean;
  /** Human may answer with free text instead of a path selection. */
  allowText: boolean;
  /** Human may hand the decision back to the agent. */
  allowDefer: boolean;
  deepLink?: string;
  createdAt: string;
}

/** A single picked entry, path relative to the request's `rootPath`. */
export interface SelectedPath {
  path: string;
  type: 'file' | 'directory';
}

export interface AgentSelectionResolution {
  id: string;
  /**
   * How the human answered:
   *  - `selected` — picked one or more `paths`.
   *  - `text`     — replied with free `text` instead of a selection.
   *  - `defer`    — explicitly handed the decision back to the agent.
   *  - `cancelled`— dismissed the picker or it timed out (same as defer).
   */
  outcome: 'selected' | 'text' | 'defer' | 'cancelled';
  paths?: SelectedPath[];
  text?: string;
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
  /**
   * Opens an interactive file/folder picker and blocks until the human answers
   * or `timeoutMs` elapses (then resolves `cancelled`). The human may pick
   * paths, reply with free text, or defer back to the agent.
   */
  requestSelection(input: {
    title: string;
    detail?: string;
    rootPath: string;
    selectionKind?: SelectionKind;
    multiple?: boolean;
    allowText?: boolean;
    allowDefer?: boolean;
    deepLink?: string;
    timeoutMs?: number;
  }): Promise<AgentSelectionResolution>;
}

/** A blocking request parked in the pending map, discriminated by `kind`. */
type PendingEntry =
  | {
      kind: 'approval';
      resolve: (r: AgentApprovalResolution) => void;
      timer: NodeJS.Timeout;
      request: AgentApprovalRequest;
    }
  | {
      kind: 'selection';
      resolve: (r: AgentSelectionResolution) => void;
      timer: NodeJS.Timeout;
      request: AgentSelectionRequest;
    };

/**
 * Backend hub for the agent→human channel. The agent panel (M5) subscribes to
 * its events to render notifications / escalations and calls `resolveApproval`
 * when the human answers. Tools never touch this directly — they get a
 * connection-bound `HumanChannel` view via `bindFor`.
 */
@Injectable()
export class AgentHumanChannelService extends EventEmitter {
  private readonly logger = new Logger(AgentHumanChannelService.name);
  private readonly pending = new Map<string, PendingEntry>();

  /** Snapshot of approvals still awaiting a human decision (panel restore). */
  pendingApprovals(agentSessionId?: number): AgentApprovalRequest[] {
    const out: AgentApprovalRequest[] = [];
    for (const entry of this.pending.values()) {
      if (entry.kind !== 'approval') continue;
      if (
        agentSessionId === undefined ||
        entry.request.agentSessionId === agentSessionId
      ) {
        out.push(entry.request);
      }
    }
    return out;
  }

  /** Snapshot of selection requests still awaiting a human answer (panel restore). */
  pendingSelections(agentSessionId?: number): AgentSelectionRequest[] {
    const out: AgentSelectionRequest[] = [];
    for (const entry of this.pending.values()) {
      if (entry.kind !== 'selection') continue;
      if (
        agentSessionId === undefined ||
        entry.request.agentSessionId === agentSessionId
      ) {
        out.push(entry.request);
      }
    }
    return out;
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
    if (!entry || entry.kind !== 'approval') return false;
    clearTimeout(entry.timer);
    this.pending.delete(resolution.id);
    entry.resolve(resolution);
    this.emit('approval-resolved', resolution);
    return true;
  }

  /** Called by the panel when the human answers a selection request. */
  resolveSelection(resolution: AgentSelectionResolution): boolean {
    const entry = this.pending.get(resolution.id);
    if (!entry || entry.kind !== 'selection') return false;
    clearTimeout(entry.timer);
    this.pending.delete(resolution.id);
    entry.resolve(resolution);
    this.emit('selection-resolved', resolution);
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
      this.pending.set(request.id, { kind: 'approval', resolve, timer, request });
      this.emit('approval', request);
    });
  }

  private awaitSelection(
    request: AgentSelectionRequest,
    timeoutMs: number,
  ): Promise<AgentSelectionResolution> {
    return new Promise<AgentSelectionResolution>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(request.id)) {
          const resolution: AgentSelectionResolution = {
            id: request.id,
            outcome: 'cancelled',
          };
          this.emit('selection-resolved', resolution);
          resolve(resolution);
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { kind: 'selection', resolve, timer, request });
      this.emit('selection', request);
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
      requestSelection: async (input) => {
        guard();
        const request: AgentSelectionRequest = {
          id: randomUUID(),
          agentSessionId: agentSessionId as number,
          title: input.title,
          detail: input.detail,
          rootPath: input.rootPath,
          selectionKind: input.selectionKind ?? 'any',
          multiple: input.multiple ?? true,
          allowText: input.allowText ?? true,
          allowDefer: input.allowDefer ?? true,
          deepLink: input.deepLink,
          createdAt: new Date().toISOString(),
        };
        return this.awaitSelection(request, input.timeoutMs ?? 10 * 60 * 1000);
      },
    };
  }
}
