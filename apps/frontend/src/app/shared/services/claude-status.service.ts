import { Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import { getBackendOrigin, getWebSocketUrl, isBackendOriginReady } from '../runtime/runtime-config';
import { readOnboardingStateSnapshot } from './onboarding-state.service';

export type ClaudeActivityStatus = 'running' | 'idle' | 'waiting';
export type ClaudeActivityActionKind = 'permission' | 'user_input' | null;

export interface ClaudeSessionActivity {
  activityStatus: ClaudeActivityStatus;
  actionKind: ClaudeActivityActionKind;
  actionLabel: string | null;
  /**
   * Work still running in the background, independently of `activityStatus`.
   * A session parked on a question with agents still working is both
   * `waiting` and `backgroundActive`.
   */
  backgroundActive: boolean;
}

export interface SessionCompletionState {
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: string | null;
  lastStateChangeAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class ClaudeStatusService implements OnDestroy {
  /**
   * Silence after which the socket is assumed dead. The gateway heartbeats
   * every 25s, so this is three missed beats. A half-open TCP socket (tunnel
   * blip, host sleep, network switch) stays `OPEN` with no `close` event, so
   * silence is the only signal the client gets.
   */
  private static readonly SILENCE_TIMEOUT_MS = 75_000;
  /** How often the socket is checked against the currently selected backend. */
  private static readonly ORIGIN_WATCH_INTERVAL_MS = 15_000;
  /** Retry cadence while the selected backend has no reachable origin yet. */
  private static readonly ORIGIN_PENDING_RETRY_MS = 1000;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private originWatchTimer: ReturnType<typeof setInterval> | null = null;
  /** Origin the live socket was opened against, so a backend switch is detectable. */
  private connectedOrigin: string | null = null;
  private destroyed = false;

  private _statuses = signal(new Map<number, ClaudeActivityStatus>());
  readonly statuses = this._statuses.asReadonly();

  private _activities = signal(new Map<number, ClaudeSessionActivity>());
  readonly activities = this._activities.asReadonly();

  private _sessionStatuses = signal(new Map<number, string>());
  readonly sessionStatuses = this._sessionStatuses.asReadonly();

  private _sessionCompletions = signal(new Map<number, SessionCompletionState>());
  readonly sessionCompletions = this._sessionCompletions.asReadonly();

  private _sessionTitles = signal(new Map<number, string>());
  readonly sessionTitles = this._sessionTitles.asReadonly();

  private _sessionWorktreeContexts = signal(new Map<number, boolean>());
  readonly sessionWorktreeContexts = this._sessionWorktreeContexts.asReadonly();

  private _onReconnect = signal(0);
  readonly onReconnect = this._onReconnect.asReadonly();

  private _treeInvalidated = signal(0);
  readonly treeInvalidated = this._treeInvalidated.asReadonly();

  constructor(private readonly ngZone: NgZone) {
    this.connect();
    this.originWatchTimer = setInterval(
      () => this.auditBackendOrigin(),
      ClaudeStatusService.ORIGIN_WATCH_INTERVAL_MS,
    );
  }

  getStatus(sessionId: number): ClaudeActivityStatus {
    return this.getActivity(sessionId).activityStatus;
  }

  getActivity(sessionId: number): ClaudeSessionActivity {
    return this._activities().get(sessionId) ?? {
      activityStatus: this._statuses().get(sessionId) ?? 'idle',
      actionKind: null,
      actionLabel: null,
      backgroundActive: false,
    };
  }

  getSessionStatus(sessionId: number): string | null {
    return this._sessionStatuses().get(sessionId) ?? null;
  }

  getSessionCompletion(sessionId: number): SessionCompletionState | null {
    return this._sessionCompletions().get(sessionId) ?? null;
  }

  hasUnreviewedCompletion(sessionId: number): boolean {
    return this.getSessionCompletion(sessionId)?.hasUnreviewedCompletion ?? false;
  }

  setSessionCompletion(sessionId: number, completion: SessionCompletionState): void {
    const map = new Map(this._sessionCompletions());
    map.set(sessionId, completion);
    this._sessionCompletions.set(map);
  }

  setSessionTitle(sessionId: number, name: string): void {
    const map = new Map(this._sessionTitles());
    map.set(sessionId, name);
    this._sessionTitles.set(map);
  }

  private setSessionWorktreeContext(sessionId: number, hasInjected: boolean): void {
    const map = new Map(this._sessionWorktreeContexts());
    map.set(sessionId, hasInjected);
    this._sessionWorktreeContexts.set(map);
  }

  private setActivity(sessionId: number, activity: ClaudeSessionActivity): void {
    const activities = new Map(this._activities());
    activities.set(sessionId, activity);
    this._activities.set(activities);

    const statuses = new Map(this._statuses());
    statuses.set(sessionId, activity.activityStatus);
    this._statuses.set(statuses);
  }

  private connect(): void {
    if (this.destroyed) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const snapshot = readOnboardingStateSnapshot();
    if (!isBackendOriginReady(snapshot)) {
      // The selected backend is remote and its tunnel is not up yet. Opening
      // now would bind this socket to whatever answers on the local fallback
      // origin — a different backend that knows none of these sessions — and
      // since that socket connects cleanly it would never close, never
      // reconnect, and leave every session stuck on its default 'idle'.
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, ClaudeStatusService.ORIGIN_PENDING_RETRY_MS);
      return;
    }

    const origin = getBackendOrigin(snapshot);
    if (this.connectedOrigin !== null && this.connectedOrigin !== origin) {
      // Session ids are per-backend, so anything held from the previous one is
      // meaningless against the new one.
      this.clearState();
    }
    this.connectedOrigin = origin;

    const ws = new WebSocket(getWebSocketUrl('/claude-status', undefined, origin));
    this.ws = ws;
    // Armed before `open` so a connect that hangs without ever opening is torn
    // down too, instead of sitting there forever.
    this.armSilenceTimeout(ws);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._onReconnect.update(v => v + 1);
    };

    this.ws.onmessage = (event) => {
      this.armSilenceTimeout(ws);
      this.ngZone.run(() => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'init') {
            const map = new Map<number, ClaudeActivityStatus>();
            for (const [id, status] of Object.entries(data.statuses)) {
              map.set(Number(id), status as ClaudeActivityStatus);
            }
            this._statuses.set(map);
            const activityMap = new Map<number, ClaudeSessionActivity>();
            for (const [id, activity] of Object.entries(data.activities ?? {})) {
              activityMap.set(Number(id), this.normalizeActivity(activity, map.get(Number(id)) ?? 'idle'));
            }
            for (const [id, status] of map.entries()) {
              if (!activityMap.has(id)) {
                activityMap.set(id, {
                  activityStatus: status,
                  actionKind: null,
                  actionLabel: null,
                  backgroundActive: false,
                });
              }
            }
            this._activities.set(activityMap);
            const completionMap = new Map<number, SessionCompletionState>();
            for (const [id, completion] of Object.entries(data.completions ?? {})) {
              completionMap.set(Number(id), completion as SessionCompletionState);
            }
            this._sessionCompletions.set(completionMap);
            const worktreeContextMap = new Map<number, boolean>();
            for (const [id, hasInjected] of Object.entries(data.worktreeContexts ?? {})) {
              worktreeContextMap.set(Number(id), Boolean(hasInjected));
            }
            this._sessionWorktreeContexts.set(worktreeContextMap);
          } else if (data.type === 'status-changed') {
            this.setActivity(data.sessionId, this.normalizeActivity(data, data.status as ClaudeActivityStatus));
          } else if (data.type === 'session-status-changed') {
            const map = new Map(this._sessionStatuses());
            map.set(data.sessionId, data.status as string);
            this._sessionStatuses.set(map);
          } else if (data.type === 'session-completion-changed') {
            const current = this.getSessionCompletion(data.sessionId);
            this.setSessionCompletion(data.sessionId, {
              hasUnreviewedCompletion: Boolean(data.hasUnreviewedCompletion),
              lastCompletionAt: data.lastCompletionAt ?? null,
              lastCompletionKind: data.lastCompletionKind ?? null,
              lastStateChangeAt: 'lastStateChangeAt' in data
                ? data.lastStateChangeAt ?? null
                : current?.lastStateChangeAt ?? null,
            });
          } else if (data.type === 'session-last-state-change-changed') {
            const current = this.getSessionCompletion(data.sessionId);
            this.setSessionCompletion(data.sessionId, {
              hasUnreviewedCompletion: current?.hasUnreviewedCompletion ?? false,
              lastCompletionAt: current?.lastCompletionAt ?? null,
              lastCompletionKind: current?.lastCompletionKind ?? null,
              lastStateChangeAt: data.lastStateChangeAt ?? null,
            });
          } else if (data.type === 'session-title-changed') {
            if (typeof data.name === 'string' && data.name.trim()) {
              this.setSessionTitle(data.sessionId, data.name);
            }
          } else if (data.type === 'session-worktree-context-changed') {
            this.setSessionWorktreeContext(
              data.sessionId,
              Boolean(data.hasInjectedWorktreeContext),
            );
          } else if (data.type === 'tree-invalidated') {
            this._treeInvalidated.update(v => v + 1);
          }
        } catch {
          // Ignore malformed messages
        }
      });
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.clearSilenceTimer();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      if (this.ws === ws) {
        ws.close();
      }
    };
  }

  private normalizeActivity(value: unknown, fallbackStatus: ClaudeActivityStatus): ClaudeSessionActivity {
    const record = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    const status = record['activityStatus'] === 'running'
      || record['activityStatus'] === 'waiting'
      || record['activityStatus'] === 'idle'
      ? record['activityStatus'] as ClaudeActivityStatus
      : fallbackStatus;
    const actionKind = record['actionKind'] === 'permission' || record['actionKind'] === 'user_input'
      ? record['actionKind'] as ClaudeActivityActionKind
      : null;
    const actionLabel = typeof record['actionLabel'] === 'string' && record['actionLabel'].trim()
      ? record['actionLabel']
      : actionKind === 'permission'
        ? 'Permission needed'
        : actionKind === 'user_input'
          ? 'Input needed'
          : null;

    return {
      activityStatus: status,
      actionKind,
      actionLabel,
      backgroundActive: record['backgroundActive'] === true,
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Closes a socket that has gone quiet. Closing rather than reconnecting
   * directly keeps the single reconnect path in `onclose`.
   */
  private armSilenceTimeout(ws: WebSocket): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.ws === ws) {
        ws.close();
      }
    }, ClaudeStatusService.SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /**
   * Repoints the socket when the selected backend changes. Switching
   * environment does not reload the app, so without this the sidebar keeps
   * reporting the previous machine's sessions for the rest of the session.
   */
  private auditBackendOrigin(): void {
    if (this.destroyed) return;

    const snapshot = readOnboardingStateSnapshot();
    if (!isBackendOriginReady(snapshot)) {
      // connect() is already retrying on its own cadence.
      return;
    }

    if (!this.ws) {
      if (!this.reconnectTimer) this.connect();
      return;
    }

    if (
      this.connectedOrigin !== null &&
      getBackendOrigin(snapshot) !== this.connectedOrigin
    ) {
      this.teardownSocket();
      this.reconnectDelay = 1000;
      this.connect();
    }
  }

  private teardownSocket(): void {
    this.clearSilenceTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;

    // Detach first: closing a socket we are deliberately replacing must not
    // run the onclose reconnect path on top of the one we are starting.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already gone.
    }
  }

  /** Everything held here is keyed by session id, which is per-backend. */
  private clearState(): void {
    this.ngZone.run(() => {
      this._statuses.set(new Map());
      this._activities.set(new Map());
      this._sessionStatuses.set(new Map());
      this._sessionCompletions.set(new Map());
      this._sessionTitles.set(new Map());
      this._sessionWorktreeContexts.set(new Map());
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.originWatchTimer) {
      clearInterval(this.originWatchTimer);
      this.originWatchTimer = null;
    }
    this.teardownSocket();
  }
}
