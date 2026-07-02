import { Injectable, NgZone, Signal, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { toast } from 'ngx-sonner';

import { NavigationService } from '@/shared/services/navigation.service';
import { AgentShowsService } from '@/shared/services/agent-shows.service';
import { AgentControlStateService } from './agent-control-state.service';
import { getWebSocketUrl } from '@/shared/runtime/runtime-config';
import type { AgentShow } from '@/shared/models/agent-channel.model';

export type { AgentShow };

/** Severity levels emitted by the meta-agent for transient notifications. */
export type AgentNotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** A transient notification surfaced as a toast. */
export interface AgentNotification {
  id: string;
  agentSessionId: number;
  level: AgentNotificationLevel;
  message: string;
  deepLink?: string;
  createdAt: string;
}

/**
 * A blocking approval/escalation request. The meta-agent is paused and waiting
 * for the human to pick one of `options`. Replayed on every (re)connect while
 * still pending.
 */
export interface AgentLiveApproval {
  id: string;
  agentSessionId: number;
  title: string;
  detail?: string;
  options: string[];
  deepLink?: string;
  createdAt: string;
}

/** An approval that was answered (here or elsewhere) and should be removed. */
export interface AgentApprovalResolution {
  id: string;
  decision: string;
  note?: string;
}

/** What entry kinds a live selection request allows the human to pick. */
export type AgentSelectionKind = 'file' | 'folder' | 'any';

/**
 * A blocking file/folder picker request from the meta-agent. The agent is
 * paused until the human picks path(s), replies with text, or defers. Replayed
 * on every (re)connect while still pending.
 */
export interface AgentLiveSelection {
  id: string;
  agentSessionId: number;
  title: string;
  detail?: string;
  /** Absolute worktree/repo root the picker browses. */
  rootPath: string;
  selectionKind: AgentSelectionKind;
  multiple: boolean;
  allowText: boolean;
  allowDefer: boolean;
  deepLink?: string;
  createdAt: string;
}

/** A single picked entry, path relative to the request's `rootPath`. */
export interface AgentSelectedPath {
  path: string;
  type: 'file' | 'directory';
}

/** How the human answered a live selection request. */
export interface AgentSelectionResolution {
  id: string;
  outcome: 'selected' | 'text' | 'defer' | 'cancelled';
  paths?: AgentSelectedPath[];
  text?: string;
}

type ServerMessage =
  | { type: 'ready' }
  | { type: 'notification'; notification: AgentNotification }
  | { type: 'show'; show: AgentShow }
  | { type: 'approval'; approval: AgentLiveApproval }
  | { type: 'approval_resolved'; resolution: AgentApprovalResolution }
  | { type: 'selection'; selection: AgentLiveSelection }
  | { type: 'selection_resolved'; resolution: AgentSelectionResolution };

const RECONNECT_DELAYS_MS = [500, 500, 1000, 1000, 2000, 2000, 4000];

/**
 * Raw WebSocket client for the meta-agent live channel (`/agent-channel`).
 *
 * - Lazy, idempotent `connect()` with auto-reconnect + backoff.
 * - Surfaces transient notifications/shows as toasts.
 * - Tracks still-pending blocking approvals as a signal for the panel to render.
 * - All socket callbacks run inside `NgZone` so signals update reactively.
 */
@Injectable({ providedIn: 'root' })
export class AgentChannelWebsocketService {
  private readonly ngZone = inject(NgZone);
  private readonly navigation = inject(NavigationService);
  private readonly router = inject(Router);
  private readonly agentShows = inject(AgentShowsService);
  private readonly agentControlState = inject(AgentControlStateService);

  private socket: WebSocket | null = null;
  private manuallyClosed = false;
  private reconnectAttempts = 0;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private readonly liveApprovalsSignal = signal<AgentLiveApproval[]>([]);
  private readonly liveSelectionsSignal = signal<AgentLiveSelection[]>([]);
  private readonly connectedSignal = signal(false);

  /** Still-pending blocking approvals, deduped by id. */
  readonly liveApprovals: Signal<AgentLiveApproval[]> = this.liveApprovalsSignal.asReadonly();
  /** Still-pending blocking file/folder picker requests, deduped by id. */
  readonly liveSelections: Signal<AgentLiveSelection[]> = this.liveSelectionsSignal.asReadonly();
  /** Whether the channel socket is currently open. */
  readonly connected: Signal<boolean> = this.connectedSignal.asReadonly();

  /** Lazily open the channel. Safe to call repeatedly. */
  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.manuallyClosed = false;
    this.openSocket();
  }

  /** Close the channel and stop reconnecting. */
  disconnect(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimeout();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.ngZone.run(() => this.connectedSignal.set(false));
  }

  /**
   * Answer a blocking approval. Sends `resolve_approval` and optimistically
   * removes the approval from the live list (the server also broadcasts an
   * `approval_resolved` which is idempotent here).
   */
  resolveApproval(id: string, decision: string, note?: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({ type: 'resolve_approval', id, decision, ...(note ? { note } : {}) }),
      );
    }
    this.removeApproval(id);
  }

  /**
   * Answer a blocking file/folder selection. Sends `resolve_selection` and
   * optimistically drops it from the live list (the server also broadcasts a
   * `selection_resolved`, which is idempotent here).
   */
  resolveSelection(resolution: AgentSelectionResolution): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resolve_selection', ...resolution }));
    }
    this.removeSelection(resolution.id);
  }

  /**
   * Navigate to a deep link from a notification/approval. Understands the
   * canonical `/sessions/:id` and `/projects/:id` shapes and routes everything
   * else through the router directly.
   */
  openDeepLink(deepLink: string): void {
    if (!deepLink) {
      return;
    }

    const sessionMatch = /^\/sessions\/(\d+)/.exec(deepLink);
    if (sessionMatch) {
      this.navigation.openSession(Number(sessionMatch[1]));
      return;
    }

    const projectMatch = /^\/projects\/(\d+)/.exec(deepLink);
    if (projectMatch) {
      this.navigation.revealProject(Number(projectMatch[1]));
      return;
    }

    void this.router.navigateByUrl(deepLink);
  }

  private openSocket(): void {
    this.clearReconnectTimeout();

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWebSocketUrl('/agent-channel'));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.ngZone.run(() => {
        this.reconnectAttempts = 0;
        this.connectedSignal.set(true);
      });
    };

    socket.onmessage = (event) => {
      this.ngZone.run(() => this.handleMessage(event.data));
    };

    socket.onclose = () => {
      this.ngZone.run(() => this.connectedSignal.set(false));
      if (this.socket === socket) {
        this.socket = null;
      }
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // Surface via onclose; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimeoutId) {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts += 1;
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null;
      if (!this.manuallyClosed) {
        this.openSocket();
      }
    }, delay);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      return;
    }

    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'ready':
        return;
      case 'notification':
        this.handleNotification(message.notification);
        return;
      case 'show':
        this.handleShow(message.show);
        return;
      case 'approval':
        this.upsertApproval(message.approval);
        return;
      case 'approval_resolved':
        this.removeApproval(message.resolution.id);
        return;
      case 'selection':
        this.upsertSelection(message.selection);
        return;
      case 'selection_resolved':
        this.removeSelection(message.resolution.id);
        return;
    }
  }

  private handleNotification(notification: AgentNotification): void {
    const fn = toast[notification.level] ?? toast.info;
    fn(notification.message, this.toastOptions(notification.deepLink));
  }

  private handleShow(show: AgentShow): void {
    this.agentShows.push(show);
    if (this.agentControlState.isOpen() && show.deepLink) {
      this.openDeepLink(show.deepLink);
    }
  }

  private toastOptions(deepLink?: string): Record<string, unknown> {
    return {
      duration: 30_000,
      closeButton: true,
      ...(deepLink
        ? {
            action: {
              label: 'Open',
              onClick: () => this.openDeepLink(deepLink),
            },
          }
        : {}),
    };
  }

  private upsertApproval(approval: AgentLiveApproval): void {
    this.liveApprovalsSignal.update((approvals) => {
      const next = approvals.filter((existing) => existing.id !== approval.id);
      next.push(approval);
      return next;
    });
  }

  private removeApproval(id: string): void {
    this.liveApprovalsSignal.update((approvals) =>
      approvals.filter((approval) => approval.id !== id),
    );
  }

  private upsertSelection(selection: AgentLiveSelection): void {
    this.liveSelectionsSignal.update((selections) => {
      const next = selections.filter((existing) => existing.id !== selection.id);
      next.push(selection);
      return next;
    });
  }

  private removeSelection(id: string): void {
    this.liveSelectionsSignal.update((selections) =>
      selections.filter((selection) => selection.id !== id),
    );
  }
}
