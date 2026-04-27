import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { getWebSocketUrl } from '../runtime/runtime-config';

export type TerminalConnectionPhase = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface TerminalConnectionState {
  phase: TerminalConnectionPhase;
  retryAttempt: number;
  retryActive: boolean;
  nextRetryAt: number | null;
  msUntilNextRetry: number | null;
}

interface Connection {
  ws: WebSocket;
  dataSubject: Subject<string>;
  openSubject: Subject<void>;
  closeSubject: Subject<CloseEvent>;
  errorSubject: Subject<Event>;
  stateSubject: BehaviorSubject<TerminalConnectionState>;
  hasOpened: boolean;
  manuallyClosed: boolean;
  reconnectAttempts: number;
  retryActive: boolean;
  nextRetryAt: number | null;
  handshakeTimeoutId: ReturnType<typeof setTimeout> | null;
  reconnectTimeoutId: ReturnType<typeof setTimeout> | null;
  retryCountdownIntervalId: ReturnType<typeof setInterval> | null;
}

@Injectable({ providedIn: 'root' })
export class TerminalWebsocketService {
  private static readonly HANDSHAKE_TIMEOUT_MS = 8000;
  private connections = new Map<number, Connection>();

  constructor(private readonly ngZone: NgZone) {}

  connect(sessionId: number): {
    onData$: Observable<string>;
    onOpen$: Observable<void>;
    onClose$: Observable<CloseEvent>;
    onError$: Observable<Event>;
    state$: Observable<TerminalConnectionState>;
  } {
    const existing = this.connections.get(sessionId);
    if (existing) {
      if (existing.ws.readyState === WebSocket.OPEN) {
        return this.toObservers(existing);
      }

      if (existing.ws.readyState === WebSocket.CONNECTING) {
        this.ensureHandshakeTimeout(sessionId, existing);
        return this.toObservers(existing);
      }

      return this.toObservers(existing);
    }

    const connection = this.createConnection(sessionId);
    this.connections.set(sessionId, connection);
    this.openSocket(sessionId, connection, 'connecting');
    return this.toObservers(connection);
  }

  send(sessionId: number, data: string): void {
    const conn = this.connections.get(sessionId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }

  resize(sessionId: number, cols: number, rows: number): void {
    const conn = this.connections.get(sessionId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  disconnect(sessionId: number): void {
    const conn = this.connections.get(sessionId);
    if (conn) {
      conn.manuallyClosed = true;
      this.clearTimers(conn);
      this.updateState(conn, {
        phase: 'disconnected',
        retryActive: false,
        nextRetryAt: null,
        msUntilNextRetry: null,
      });
      conn.ws.close();
      this.connections.delete(sessionId);
    }
  }

  setRetryActive(sessionId: number, active: boolean): void {
    const connection = this.connections.get(sessionId);
    if (!connection || connection.manuallyClosed) {
      return;
    }

    connection.retryActive = active;
    this.updateState(connection, {
      retryActive: active,
    });

    if (!active) {
      this.clearReconnectTimeout(connection);
      this.clearRetryCountdown(connection);
      this.updateState(connection, {
        nextRetryAt: null,
        msUntilNextRetry: null,
      });
      return;
    }

    if (connection.stateSubject.value.phase === 'disconnected') {
      this.retryNow(sessionId, connection);
    }
  }

  isConnected(sessionId: number): boolean {
    const conn = this.connections.get(sessionId);
    return conn?.ws.readyState === WebSocket.OPEN;
  }

  private createConnection(sessionId: number): Connection {
    const ws = this.createWebSocket(sessionId);
    return {
      ws,
      dataSubject: new Subject<string>(),
      openSubject: new Subject<void>(),
      closeSubject: new Subject<CloseEvent>(),
      errorSubject: new Subject<Event>(),
      stateSubject: new BehaviorSubject<TerminalConnectionState>({
        phase: 'connecting',
        retryAttempt: 0,
        retryActive: false,
        nextRetryAt: null,
        msUntilNextRetry: null,
      }),
      hasOpened: false,
      manuallyClosed: false,
      reconnectAttempts: 0,
      retryActive: false,
      nextRetryAt: null,
      handshakeTimeoutId: null,
      reconnectTimeoutId: null,
      retryCountdownIntervalId: null,
    };
  }

  private createWebSocket(sessionId: number): WebSocket {
    const wsUrl = getWebSocketUrl('/terminal', new URLSearchParams({
      sessionId: String(sessionId),
    }));
    console.log(`Creating WebSocket connection for session ${sessionId}:`, wsUrl);
    return new WebSocket(wsUrl);
  }

  private openSocket(
    sessionId: number,
    connection: Connection,
    phase: Extract<TerminalConnectionPhase, 'connecting' | 'reconnecting'>,
  ): void {
    this.clearReconnectTimeout(connection);
    this.clearRetryCountdown(connection);
    connection.nextRetryAt = null;
    this.updateState(connection, {
      phase,
      nextRetryAt: null,
      msUntilNextRetry: null,
    });

    connection.ws.onopen = () => {
      console.log(`WebSocket connected for session ${sessionId}`);
      connection.hasOpened = true;
      connection.reconnectAttempts = 0;
      this.clearHandshakeTimeout(connection);
      this.clearReconnectTimeout(connection);
      this.clearRetryCountdown(connection);
      this.ngZone.run(() => {
        this.updateState(connection, {
          phase: 'connected',
          retryAttempt: 0,
          nextRetryAt: null,
          msUntilNextRetry: null,
        });
        connection.openSubject.next();
      });
    };

    connection.ws.onmessage = (event) => {
      this.ngZone.run(() => {
        connection.dataSubject.next(event.data);
      });
    };

    connection.ws.onclose = (event) => {
      console.log(`WebSocket closed for session ${sessionId}:`, event.code, event.reason);
      this.clearHandshakeTimeout(connection);
      this.clearReconnectTimeout(connection);
      this.clearRetryCountdown(connection);

      this.ngZone.run(() => {
        connection.closeSubject.next(event);
      });

      if (connection.manuallyClosed) {
        this.ngZone.run(() => {
          if (this.connections.get(sessionId) === connection) {
            this.connections.delete(sessionId);
          }
        });
        return;
      }

      this.updateState(connection, {
        phase: 'disconnected',
        nextRetryAt: null,
        msUntilNextRetry: null,
      });

      if (this.shouldRetry(connection, event)) {
        this.scheduleReconnect(sessionId, connection);
        return;
      }
    };

    connection.ws.onerror = (error) => {
      console.error(`WebSocket error for session ${sessionId}:`, error);
      this.ngZone.run(() => {
        connection.errorSubject.next(error);
      });
    };

    this.ensureHandshakeTimeout(sessionId, connection);
  }

  private ensureHandshakeTimeout(sessionId: number, connection: Connection): void {
    if (connection.handshakeTimeoutId || connection.hasOpened || connection.manuallyClosed) {
      return;
    }

    connection.handshakeTimeoutId = setTimeout(() => {
      connection.handshakeTimeoutId = null;
      if (
        this.connections.get(sessionId) === connection &&
        connection.ws.readyState === WebSocket.CONNECTING
      ) {
        connection.ws.close();
      }
    }, TerminalWebsocketService.HANDSHAKE_TIMEOUT_MS);
  }

  private shouldRetry(connection: Connection, _event: CloseEvent): boolean {
    return !connection.manuallyClosed && connection.retryActive;
  }

  private scheduleReconnect(sessionId: number, connection: Connection): void {
    connection.reconnectAttempts += 1;
    const delay = this.getReconnectDelay(connection.reconnectAttempts);
    connection.nextRetryAt = Date.now() + delay;
    this.updateState(connection, {
      retryAttempt: connection.reconnectAttempts,
      nextRetryAt: connection.nextRetryAt,
      msUntilNextRetry: delay,
    });
    this.startRetryCountdown(connection);
    connection.reconnectTimeoutId = setTimeout(() => {
      connection.reconnectTimeoutId = null;
      if (this.connections.get(sessionId) !== connection || connection.manuallyClosed) {
        return;
      }

      connection.nextRetryAt = null;
      connection.ws = this.createWebSocket(sessionId);
      this.openSocket(sessionId, connection, 'reconnecting');
    }, delay);
  }

  private retryNow(sessionId: number, connection: Connection): void {
    if (
      this.connections.get(sessionId) !== connection ||
      connection.manuallyClosed ||
      connection.ws.readyState === WebSocket.OPEN ||
      connection.ws.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.clearReconnectTimeout(connection);
    this.clearRetryCountdown(connection);
    connection.nextRetryAt = null;
    connection.ws = this.createWebSocket(sessionId);
    this.openSocket(sessionId, connection, 'reconnecting');
  }

  private startRetryCountdown(connection: Connection): void {
    this.clearRetryCountdown(connection);
    connection.retryCountdownIntervalId = setInterval(() => {
      this.updateRetryCountdown(connection);
    }, 100);
  }

  private updateRetryCountdown(connection: Connection): void {
    const nextRetryAt = connection.nextRetryAt;
    if (!nextRetryAt) {
      this.updateState(connection, {
        msUntilNextRetry: null,
      });
      return;
    }

    const msUntilNextRetry = Math.max(0, nextRetryAt - Date.now());
    this.ngZone.run(() => {
      this.updateState(connection, {
        msUntilNextRetry,
      });
    });
  }

  private clearRetryCountdown(connection: Connection): void {
    if (connection.retryCountdownIntervalId) {
      clearInterval(connection.retryCountdownIntervalId);
      connection.retryCountdownIntervalId = null;
    }
  }

  private clearHandshakeTimeout(connection: Connection): void {
    if (connection.handshakeTimeoutId) {
      clearTimeout(connection.handshakeTimeoutId);
      connection.handshakeTimeoutId = null;
    }
  }

  private clearReconnectTimeout(connection: Connection): void {
    if (connection.reconnectTimeoutId) {
      clearTimeout(connection.reconnectTimeoutId);
      connection.reconnectTimeoutId = null;
    }
  }

  private clearTimers(connection: Connection): void {
    this.clearHandshakeTimeout(connection);
    this.clearReconnectTimeout(connection);
    this.clearRetryCountdown(connection);
  }

  private toObservers(connection: Connection) {
    return {
      onData$: connection.dataSubject.asObservable(),
      onOpen$: connection.openSubject.asObservable(),
      onClose$: connection.closeSubject.asObservable(),
      onError$: connection.errorSubject.asObservable(),
      state$: connection.stateSubject.asObservable(),
    };
  }

  private updateState(
    connection: Connection,
    patch: Partial<TerminalConnectionState>,
  ): void {
    connection.stateSubject.next({
      ...connection.stateSubject.value,
      ...patch,
    });
  }

  private getReconnectDelay(attempt: number): number {
    if (attempt <= 2) {
      return 500;
    }
    if (attempt <= 4) {
      return 1000;
    }
    if (attempt <= 6) {
      return 2000;
    }
    return 4000;
  }
}
