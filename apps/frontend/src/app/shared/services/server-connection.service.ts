import { Injectable, NgZone, OnDestroy, computed, signal } from '@angular/core';
import { getWebSocketUrl } from '../runtime/runtime-config';

export type ServerConnectionPhase = 'connecting' | 'connected' | 'disconnected' | 'restored';

export interface ServerConnectionState {
  phase: ServerConnectionPhase;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  reconnectAttempt: number;
}

type Waiter = () => void;

@Injectable({ providedIn: 'root' })
export class ServerConnectionService implements OnDestroy {
  private static readonly HEARTBEAT_TIMEOUT_MS = 12000;
  private static readonly RESTORED_GRACE_MS = 1500;
  private static readonly RECONNECT_DELAYS_MS = [0, 500, 1000, 2000];

  private ws: WebSocket | null = null;
  private started = false;
  private hasConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private restoredTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Waiter[] = [];

  private readonly _state = signal<ServerConnectionState>({
    phase: 'connecting',
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    reconnectAttempt: 0,
  });
  private readonly _reconnectCount = signal(0);

  readonly state = this._state.asReadonly();
  readonly reconnectCount = this._reconnectCount.asReadonly();
  readonly showOverlay = computed(() => {
    const phase = this._state().phase;
    return phase === 'disconnected' || phase === 'restored';
  });
  readonly isInteractive = computed(() => this._state().phase === 'connected');

  constructor(private readonly ngZone: NgZone) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.openSocket();
  }

  waitUntilInteractive(): Promise<void> {
    this.start();

    if (this.isInteractive()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private openSocket(): void {
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();

    const ws = new WebSocket(getWebSocketUrl('/server-connection'));
    this.ws = ws;

    if (!this.hasConnected) {
      this._state.update((state) => ({ ...state, phase: 'connecting' }));
    }

    ws.onopen = () => {
      this.ngZone.run(() => {
        this.armHeartbeatTimeout(ws);
      });
    };

    ws.onmessage = (event) => {
      this.ngZone.run(() => {
        if (this.ws !== ws || !this.isServerConnectionMessage(event.data)) {
          return;
        }

        this.markConnected();
        this.armHeartbeatTimeout(ws);
      });
    };

    ws.onclose = () => {
      this.ngZone.run(() => {
        if (this.ws !== ws) {
          return;
        }

        this.handleDisconnect();
      });
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private isServerConnectionMessage(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }

    try {
      const parsed = JSON.parse(value) as { type?: unknown; serverTime?: unknown };
      return (
        (parsed.type === 'ready' || parsed.type === 'heartbeat') &&
        typeof parsed.serverTime === 'string'
      );
    } catch {
      return false;
    }
  }

  private markConnected(): void {
    const now = Date.now();
    const wasPreviouslyConnected = this.hasConnected;
    this.hasConnected = true;
    this.clearReconnectTimer();

    if (!wasPreviouslyConnected) {
      this._state.set({
        phase: 'connected',
        lastConnectedAt: now,
        lastDisconnectedAt: null,
        reconnectAttempt: 0,
      });
      this.resolveWaiters();
      return;
    }

    if (this._state().phase === 'connected') {
      this._state.update((state) => ({
        ...state,
        lastConnectedAt: now,
        reconnectAttempt: 0,
      }));
      return;
    }

    this._reconnectCount.update((count) => count + 1);
    this._state.update((state) => ({
      ...state,
      phase: 'restored',
      lastConnectedAt: now,
      reconnectAttempt: 0,
    }));
    this.clearRestoredTimer();
    this.restoredTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.restoredTimer = null;
        if (this.ws?.readyState === WebSocket.OPEN) {
          this._state.update((state) => ({ ...state, phase: 'connected' }));
          this.resolveWaiters();
        }
      });
    }, ServerConnectionService.RESTORED_GRACE_MS);
  }

  private handleDisconnect(): void {
    this.clearHeartbeatTimer();
    this.clearRestoredTimer();
    const nextAttempt = this._state().reconnectAttempt + 1;
    this._state.update((state) => ({
      ...state,
      phase: this.hasConnected ? 'disconnected' : 'connecting',
      lastDisconnectedAt: this.hasConnected ? Date.now() : state.lastDisconnectedAt,
      reconnectAttempt: nextAttempt,
    }));
    this.scheduleReconnect(nextAttempt);
  }

  private armHeartbeatTimeout(ws: WebSocket): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      this.ngZone.run(() => {
        if (this.ws === ws) {
          ws.close();
        }
      });
    }, ServerConnectionService.HEARTBEAT_TIMEOUT_MS);
  }

  private scheduleReconnect(attempt: number): void {
    this.clearReconnectTimer();
    const delay = ServerConnectionService.RECONNECT_DELAYS_MS[
      Math.min(attempt - 1, ServerConnectionService.RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectTimer = setTimeout(() => {
      this.ngZone.run(() => {
        this.reconnectTimer = null;
        if (this.started) {
          this.openSocket();
        }
      });
    }, delay);
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearRestoredTimer(): void {
    if (this.restoredTimer) {
      clearTimeout(this.restoredTimer);
      this.restoredTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.started = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearRestoredTimer();
    this.ws?.close(1000, 'Service destroyed');
    this.ws = null;
  }
}
