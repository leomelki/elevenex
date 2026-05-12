import { Injectable, OnDestroy, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { ReplaySubject } from 'rxjs';
import { getSocketIoBaseUrl } from '@/shared/runtime/runtime-config';

export interface PlannotatorUrlEvent {
  type: 'url-received';
  url: string;
  proxyUrl: string;
  sessionId: number | null;
  upstreamPort: number;
}

export interface PlannotatorSessionEvent {
  type: 'session-started' | 'session-ended';
  plannotatorSession?: {
    pid: number;
    port: number;
    url: string;
    mode: string;
    project: string;
    startedAt: string;
    label: string;
  };
  elevenexSessionId?: number | null;
  worktreePath?: string | null;
  pid?: number;
  port?: number;
}

export interface PlannotatorCloseEvent {
  type: 'close';
  upstreamPort: number;
  sessionId?: number | null;
}

export type PlannotatorEvent = PlannotatorUrlEvent | PlannotatorSessionEvent | PlannotatorCloseEvent;

@Injectable({
  providedIn: 'root',
})
export class PlannotatorService implements OnDestroy {
  private static readonly RECONNECT_DELAYS_MS = [0, 500, 1000, 2000];

  private socket: Socket | null = null;
  private eventSubject = new ReplaySubject<PlannotatorEvent>(5);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  events$ = this.eventSubject.asObservable();

  private _connected = signal(false);
  readonly connected = this._connected.asReadonly();

  constructor() {
    this.connect();
  }

  private connect(): void {
    // Re-read the backend origin on every connect attempt so that a newly
    // allocated SSH-tunnel port (written to localStorage by the startup
    // service) is picked up without requiring a page reload.
    const socketUrl = getSocketIoBaseUrl('/plannotator');

    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: false,
      path: '/socket.io',
    });

    this.socket = socket;

    socket.on('connect', () => {
      console.log('[Plannotator] WebSocket connected, id:', socket.id);
      this.reconnectAttempt = 0;
      this._connected.set(true);
      setTimeout(() => this.requestActivePanels(), 100);
    });

    socket.on('disconnect', (reason: string) => {
      console.log('[Plannotator] WebSocket disconnected, reason:', reason);
      this._connected.set(false);
      this.scheduleReconnect();
    });

    socket.on('event', (event: PlannotatorEvent) => {
      console.log('[Plannotator] Received event:', JSON.stringify(event));
      this.eventSubject.next(event);
    });

    socket.on('connect_error', (error: Error) => {
      console.error('[Plannotator] Connection error:', error.message);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.destroyed) {
      return;
    }

    const delay = PlannotatorService.RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, PlannotatorService.RECONNECT_DELAYS_MS.length - 1)
    ];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.destroySocket();
        this.connect();
      }
    }, delay);
  }

  private destroySocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  registerWorktree(worktreePath: string, sessionId: number): void {
    console.log('[Plannotator] registerWorktree:', worktreePath, 'sessionId:', sessionId, 'socket connected:', this.socket?.connected);
    this.socket?.emit('register-worktree', { worktreePath, sessionId });
  }

  unregisterWorktree(worktreePath: string): void {
    this.socket?.emit('unregister-worktree', { worktreePath });
  }

  closePanel(sessionId: number): void {
    this.socket?.emit('close-panel', { sessionId });
  }

  requestActivePanels(): void {
    console.log('[Plannotator] requestActivePanels called, socket connected:', this.socket?.connected);
    if (!this.socket?.connected) return;

    this.socket.once('active-panels', (panels: PlannotatorUrlEvent[]) => {
      console.log('[Plannotator] Received active-panels response:', JSON.stringify(panels));
      for (const panel of panels) {
        this.eventSubject.next(panel);
      }
    });

    this.socket.emit('get-active-panels');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.destroySocket();
    this.eventSubject.complete();
  }
}
