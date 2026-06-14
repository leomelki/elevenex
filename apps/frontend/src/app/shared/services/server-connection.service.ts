import { Injectable, NgZone, OnDestroy, computed, signal } from '@angular/core';
import { getWebSocketUrl } from '../runtime/runtime-config';

export type ServerConnectionPhase = 'connecting' | 'connected' | 'disconnected' | 'restored';

export interface ServerCapabilities {
  /** Whether tmux is available on the machine running the backend. */
  tmuxAvailable: boolean;
  /** Node platform of the backend host (e.g. 'win32', 'darwin', 'linux'). */
  platform: string;
}

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
  private readonly _capabilities = signal<ServerCapabilities | null>(null);

  readonly state = this._state.asReadonly();
  readonly reconnectCount = this._reconnectCount.asReadonly();
  readonly capabilities = this._capabilities.asReadonly();
  /** True once the backend has reported that tmux is not available. */
  readonly tmuxMissing = computed(() => {
    const caps = this._capabilities();
    return caps !== null && !caps.tmuxAvailable;
  });
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
        if (this.ws !== ws) {
          return;
        }

        const message = this.parseServerMessage(event.data);
        if (!message) {
          return;
        }

        if (message.capabilities) {
          this._capabilities.set(message.capabilities);
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

  private parseServerMessage(
    value: unknown,
  ): { type: 'ready' | 'heartbeat'; capabilities?: ServerCapabilities } | null {
    if (typeof value !== 'string') {
      return null;
    }

    try {
      const parsed = JSON.parse(value) as {
        type?: unknown;
        serverTime?: unknown;
        capabilities?: unknown;
      };
      if (
        (parsed.type !== 'ready' && parsed.type !== 'heartbeat') ||
        typeof parsed.serverTime !== 'string'
      ) {
        return null;
      }

      return {
        type: parsed.type,
        capabilities: this.parseCapabilities(parsed.capabilities),
      };
    } catch {
      return null;
    }
  }

  private parseCapabilities(value: unknown): ServerCapabilities | undefined {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }

    const caps = value as { tmuxAvailable?: unknown; platform?: unknown };
    if (typeof caps.tmuxAvailable !== 'boolean') {
      return undefined;
    }

    return {
      tmuxAvailable: caps.tmuxAvailable,
      platform: typeof caps.platform === 'string' ? caps.platform : 'unknown',
    };
  }

  /**
   * Tear down the current socket and immediately reconnect so the backend
   * re-advertises its capabilities (e.g. after the user installs tmux).
   */
  recheck(): void {
    if (!this.started) {
      this.start();
      return;
    }

    this.clearReconnectTimer();
    const previous = this.ws;
    this.ws = null;
    if (previous) {
      try {
        previous.close();
      } catch {
        // Ignore sockets that are already closing.
      }
    }
    this.openSocket();
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
