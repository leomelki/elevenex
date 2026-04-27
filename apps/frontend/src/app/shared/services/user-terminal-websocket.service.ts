import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { getWebSocketUrl } from '../runtime/runtime-config';

interface Connection {
  ws: WebSocket;
  dataSubject: Subject<string>;
  openSubject: Subject<void>;
  closeSubject: Subject<CloseEvent>;
  errorSubject: Subject<Event>;
  hasOpened: boolean;
  manuallyClosed: boolean;
  reconnectAttempts: number;
  handshakeTimeoutId: ReturnType<typeof setTimeout> | null;
  reconnectTimeoutId: ReturnType<typeof setTimeout> | null;
}

@Injectable({ providedIn: 'root' })
export class UserTerminalWebsocketService {
  private static readonly HANDSHAKE_TIMEOUT_MS = 8000;
  private static readonly RECONNECT_DELAY_MS = 500;
  private static readonly MAX_RECONNECT_ATTEMPTS = 2;
  private connections = new Map<number, Connection>();

  constructor(private readonly ngZone: NgZone) {}

  connect(terminalId: number): {
    onData$: Observable<string>;
    onOpen$: Observable<void>;
    onClose$: Observable<CloseEvent>;
    onError$: Observable<Event>;
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

      this.disposeConnection(terminalId, existing);
    }

    const connection = this.createConnection(terminalId);
    this.connections.set(terminalId, connection);
    this.openSocket(terminalId, connection);
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
      conn.ws.close();
      this.connections.delete(terminalId);
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
      hasOpened: false,
      manuallyClosed: false,
      reconnectAttempts: 0,
      handshakeTimeoutId: null,
      reconnectTimeoutId: null,
    };
  }

  private createWebSocket(terminalId: number): WebSocket {
    const wsUrl = getWebSocketUrl('/user-terminal', new URLSearchParams({
      terminalId: String(terminalId),
    }));
    console.log(`Creating WebSocket connection for user terminal ${terminalId}:`, wsUrl);
    return new WebSocket(wsUrl);
  }

  private openSocket(terminalId: number, connection: Connection): void {
    connection.ws.onopen = () => {
      console.log(`WebSocket connected for user terminal ${terminalId}`);
      connection.hasOpened = true;
      connection.reconnectAttempts = 0;
      this.clearHandshakeTimeout(connection);
      this.ngZone.run(() => {
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

      if (this.shouldRetry(connection, event)) {
        this.scheduleReconnect(terminalId, connection);
        return;
      }

      this.ngZone.run(() => {
        connection.closeSubject.next(event);
        if (this.connections.get(terminalId) === connection) {
          this.connections.delete(terminalId);
        }
      });
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
    return (
      !connection.manuallyClosed &&
      !connection.hasOpened &&
      connection.reconnectAttempts < UserTerminalWebsocketService.MAX_RECONNECT_ATTEMPTS
    );
  }

  private scheduleReconnect(terminalId: number, connection: Connection): void {
    connection.reconnectAttempts += 1;
    connection.reconnectTimeoutId = setTimeout(() => {
      connection.reconnectTimeoutId = null;
      if (this.connections.get(terminalId) !== connection || connection.manuallyClosed) {
        return;
      }

      connection.ws = this.createWebSocket(terminalId);
      this.openSocket(terminalId, connection);
    }, UserTerminalWebsocketService.RECONNECT_DELAY_MS);
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
  }

  private disposeConnection(terminalId: number, connection: Connection): void {
    this.clearTimers(connection);
    if (
      connection.ws.readyState === WebSocket.CONNECTING ||
      connection.ws.readyState === WebSocket.OPEN
    ) {
      connection.manuallyClosed = true;
      connection.ws.close();
    }
    if (this.connections.get(terminalId) === connection) {
      this.connections.delete(terminalId);
    }
  }

  private toObservers(connection: Connection) {
    return {
      onData$: connection.dataSubject.asObservable(),
      onOpen$: connection.openSubject.asObservable(),
      onClose$: connection.closeSubject.asObservable(),
      onError$: connection.errorSubject.asObservable(),
    };
  }
}
