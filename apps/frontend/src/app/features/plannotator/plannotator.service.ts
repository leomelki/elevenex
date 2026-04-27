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
  private socket: Socket | null = null;
  private eventSubject = new ReplaySubject<PlannotatorEvent>(5);

  events$ = this.eventSubject.asObservable();

  private _connected = signal(false);
  readonly connected = this._connected.asReadonly();

  constructor() {
    this.connect();
  }

  private connect(): void {
    const socketUrl = getSocketIoBaseUrl('/plannotator');

    this.socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      path: '/socket.io',
    });

    this.socket.on('connect', () => {
      console.log('[Plannotator] WebSocket connected, id:', this.socket?.id);
      this._connected.set(true);
      setTimeout(() => this.requestActivePanels(), 100);
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('[Plannotator] WebSocket disconnected, reason:', reason);
      this._connected.set(false);
    });

    this.socket.on('event', (event: PlannotatorEvent) => {
      console.log('[Plannotator] Received event:', JSON.stringify(event));
      this.eventSubject.next(event);
    });

    this.socket.on('connect_error', (error: Error) => {
      console.error('[Plannotator] Connection error:', error.message);
    });
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
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.eventSubject.complete();
  }
}
