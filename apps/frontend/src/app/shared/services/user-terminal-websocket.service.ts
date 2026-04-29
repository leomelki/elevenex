import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Subject, Observable } from 'rxjs';
import { getWebSocketUrl } from '../runtime/runtime-config';

export type UserTerminalConnectionPhase = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface UserTerminalConnectionState {
  phase: UserTerminalConnectionPhase;
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
  stateSubject: BehaviorSubject<UserTerminalConnectionState>;
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
export class UserTerminalWebsocketService {
  private static readonly HANDSHAKE_TIMEOUT_MS = 8000;
  private connections = new Map<number, Connection>();

  constructor(private readonly ngZone: NgZone) {}

  connect(terminalId: number): {
    onData$: Observable<string>;
    onOpen$: Observable<void>;
    onClose$: Observable<CloseEvent>;
    onError$: Observable<Event>;
    state$: Observable<UserTerminalConnectionState>;
  } {
    const existing = this.connections.get(terminalId);
    if (existing) {
      if (existing.ws.readyState === WebSocket.OPEN) {
        return this.toObservers(existing);
      }

      if (existing.ws.readyState === WebSocket.CONNECTING) {
        this.ensureHandshakeTimeout(terminalId, existing);
        return this.toObservers(existing);
      }

      return this.toObservers(existing);
    }

    const connection = this.createConnection(terminalId);
    this.connections.set(terminalId, connection);
    this.openSocket(terminalId, connection, 'connecting');
    return this.toObservers(connection);
  }

  send(terminalId: number, data: string): void {
    const conn = this.connections.get(terminalId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }

  resize(terminalId: number, cols: number, rows: number): void {
    const conn = this.connections.get(terminalId);
    if (conn?.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  disconnect(terminalId: number): void {
    const conn = this.connections.get(terminalId);
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
      this.connections.delete(terminalId);
    }
  }

  setRetryActive(terminalId: number, active: boolean): void {
    const connection = this.connections.get(terminalId);
    if (!connection || connection.manuallyClosed) {
      return;
    }

    connection.retryActive = active;
    this.updateState(connection, { retryActive: active });

    if (!active) {
      this.clearReconnectTimeout(connection);
      this.clearRetryCountdown(connection);
      this.updateState(connection, { nextRetryAt: null, msUntilNextRetry: null });
      return;
    }

    if (connection.stateSubject.value.phase === 'disconnected') {
      this.retryNow(terminalId, connection);
    }
  }

  isConnected(terminalId: number): boolean {
    const conn = this.connections.get(terminalId);
    return conn?.ws.readyState === WebSocket.OPEN;
  }

  private createConnection(terminalId: number): Connection {
    const ws = this.createWebSocket(terminalId);
    return {
      ws,
      dataSubject: new Subject<string>(),
      openSubject: new Subject<void>(),
      closeSubject: new Subject<CloseEvent>(),
      errorSubject: new Subject<Event>(),
      stateSubject: new BehaviorSubject<UserTerminalConnectionState>({
        phase: 'connecting',
        retryAttempt: 0,
        retryActive: true,
        nextRetryAt: null,
        msUntilNextRetry: null,
      }),
      hasOpened: false,
      manuallyClosed: false,
      reconnectAttempts: 0,
      retryActive: true,
      nextRetryAt: null,
      handshakeTimeoutId: null,
      reconnectTimeoutId: null,
      retryCountdownIntervalId: null,
    };
  }

  private createWebSocket(terminalId: number): WebSocket {
    const wsUrl = getWebSocketUrl('/user-terminal', new URLSearchParams({
      terminalId: String(terminalId),
    }));
    console.log(`Creating WebSocket connection for user terminal ${terminalId}:`, wsUrl);
    return new WebSocket(wsUrl);
  }

  private openSocket(
    terminalId: number,
    connection: Connection,
    phase: Extract<UserTerminalConnectionPhase, 'connecting' | 'reconnecting'>,
  ): void {
    this.clearReconnectTimeout(connection);
    this.clearRetryCountdown(connection);
    connection.nextRetryAt = null;
    this.updateState(connection, { phase, nextRetryAt: null, msUntilNextRetry: null });

    connection.ws.onopen = () => {
      console.log(`WebSocket connected for user terminal ${terminalId}`);
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
      console.log(`WebSocket closed for user terminal ${terminalId}:`, event.code, event.reason);
      this.clearHandshakeTimeout(connection);
      this.clearReconnectTimeout(connection);
      this.clearRetryCountdown(connection);

      this.ngZone.run(() => {
        connection.closeSubject.next(event);
      });

      if (connection.manuallyClosed) {
        this.ngZone.run(() => {
          if (this.connections.get(terminalId) === connection) {
            this.connections.delete(terminalId);
          }
        });
        return;
      }

      this.updateState(connection, { phase: 'disconnected', nextRetryAt: null, msUntilNextRetry: null });

      if (this.shouldRetry(connection, event)) {
        this.scheduleReconnect(terminalId, connection);
      }
    };

    connection.ws.onerror = (error) => {
      console.error(`WebSocket error for user terminal ${terminalId}:`, error);
      this.ngZone.run(() => {
        connection.errorSubject.next(error);
      });
    };

    this.ensureHandshakeTimeout(terminalId, connection);
  }

  private ensureHandshakeTimeout(terminalId: number, connection: Connection): void {
    if (connection.handshakeTimeoutId || connection.hasOpened || connection.manuallyClosed) {
      return;
    }

    connection.handshakeTimeoutId = setTimeout(() => {
      connection.handshakeTimeoutId = null;
      if (
        this.connections.get(terminalId) === connection &&
        connection.ws.readyState === WebSocket.CONNECTING
      ) {
        connection.ws.close();
      }
    }, UserTerminalWebsocketService.HANDSHAKE_TIMEOUT_MS);
  }

  private shouldRetry(connection: Connection, _event: CloseEvent): boolean {
    return !connection.manuallyClosed && connection.retryActive;
  }

  private scheduleReconnect(terminalId: number, connection: Connection): void {
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
      if (this.connections.get(terminalId) !== connection || connection.manuallyClosed) {
        return;
      }

      connection.nextRetryAt = null;
      connection.ws = this.createWebSocket(terminalId);
      this.openSocket(terminalId, connection, 'reconnecting');
    }, delay);
  }

  private retryNow(terminalId: number, connection: Connection): void {
    if (
      this.connections.get(terminalId) !== connection ||
      connection.manuallyClosed ||
      connection.ws.readyState === WebSocket.OPEN ||
      connection.ws.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.clearReconnectTimeout(connection);
    this.clearRetryCountdown(connection);
    connection.nextRetryAt = null;
    connection.ws = this.createWebSocket(terminalId);
    this.openSocket(terminalId, connection, 'reconnecting');
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
      this.updateState(connection, { msUntilNextRetry: null });
      return;
    }

    const msUntilNextRetry = Math.max(0, nextRetryAt - Date.now());
    this.ngZone.run(() => {
      this.updateState(connection, { msUntilNextRetry });
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
    patch: Partial<UserTerminalConnectionState>,
  ): void {
    connection.stateSubject.next({
      ...connection.stateSubject.value,
      ...patch,
    });
  }

  private getReconnectDelay(attempt: number): number {
    if (attempt <= 2) return 500;
    if (attempt <= 4) return 1000;
    if (attempt <= 6) return 2000;
    return 4000;
  }
}
