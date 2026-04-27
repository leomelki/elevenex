import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import { getWebSocketUrl } from '../runtime/runtime-config';

interface Connection {
  ws: WebSocket;
  subject: Subject<ClaudeRuntimeEvent>;
}

@Injectable({ providedIn: 'root' })
export class ClaudeRuntimeWebsocketService {
  private readonly connections = new Map<number, Connection>();

  constructor(private readonly ngZone: NgZone) {}

  connect(sessionId: number): Observable<ClaudeRuntimeEvent> {
    const existing = this.connections.get(sessionId);
    if (existing) {
      return existing.subject.asObservable();
    }

    const ws = new WebSocket(
      getWebSocketUrl('/claude-runtime', new URLSearchParams({ sessionId: String(sessionId) })),
    );
    const subject = new Subject<ClaudeRuntimeEvent>();

    ws.onmessage = (event) => {
      this.ngZone.run(() => {
        try {
          subject.next(JSON.parse(event.data) as ClaudeRuntimeEvent);
        } catch {
          // Ignore malformed events.
        }
      });
    };

    ws.onclose = () => {
      this.ngZone.run(() => {
        subject.complete();
        this.connections.delete(sessionId);
      });
    };

    ws.onerror = () => {
      ws.close();
    };

    this.connections.set(sessionId, { ws, subject });
    return subject.asObservable();
  }

  send(sessionId: number, message: Record<string, unknown>): void {
    const connection = this.connections.get(sessionId);
    if (connection?.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(message));
      return;
    }

    if (connection?.ws.readyState === WebSocket.CONNECTING) {
      connection.ws.addEventListener(
        'open',
        () => connection.ws.send(JSON.stringify(message)),
        { once: true },
      );
    }
  }

  disconnect(sessionId: number): void {
    const connection = this.connections.get(sessionId);
    if (!connection) {
      return;
    }

    connection.ws.close();
    this.connections.delete(sessionId);
  }
}
