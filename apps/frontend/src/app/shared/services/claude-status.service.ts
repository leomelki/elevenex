import { Injectable, NgZone, OnDestroy, signal } from '@angular/core';
import { getWebSocketUrl } from '../runtime/runtime-config';

export type ClaudeActivityStatus = 'running' | 'idle' | 'waiting';

export interface SessionCompletionState {
  hasUnreviewedCompletion: boolean;
  lastCompletionAt: string | null;
  lastCompletionKind: string | null;
  lastStateChangeAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class ClaudeStatusService implements OnDestroy {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  private _statuses = signal(new Map<number, ClaudeActivityStatus>());
  readonly statuses = this._statuses.asReadonly();

  private _sessionStatuses = signal(new Map<number, string>());
  readonly sessionStatuses = this._sessionStatuses.asReadonly();

  private _sessionCompletions = signal(new Map<number, SessionCompletionState>());
  readonly sessionCompletions = this._sessionCompletions.asReadonly();

  private _onReconnect = signal(0);
  readonly onReconnect = this._onReconnect.asReadonly();

  constructor(private readonly ngZone: NgZone) {
    this.connect();
  }

  getStatus(sessionId: number): ClaudeActivityStatus {
    return this._statuses().get(sessionId) ?? 'idle';
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

  private connect(): void {
    const wsUrl = getWebSocketUrl('/claude-status');

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this._onReconnect.update(v => v + 1);
    };

    this.ws.onmessage = (event) => {
      this.ngZone.run(() => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'init') {
            const map = new Map<number, ClaudeActivityStatus>();
            for (const [id, status] of Object.entries(data.statuses)) {
              map.set(Number(id), status as ClaudeActivityStatus);
            }
            this._statuses.set(map);
            const completionMap = new Map<number, SessionCompletionState>();
            for (const [id, completion] of Object.entries(data.completions ?? {})) {
              completionMap.set(Number(id), completion as SessionCompletionState);
            }
            this._sessionCompletions.set(completionMap);
          } else if (data.type === 'status-changed') {
            const map = new Map(this._statuses());
            map.set(data.sessionId, data.status as ClaudeActivityStatus);
            this._statuses.set(map);
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
          }
        } catch {
          // Ignore malformed messages
        }
      });
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  ngOnDestroy(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }
}
