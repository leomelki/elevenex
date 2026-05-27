import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable, Subject, of } from 'rxjs';
import { ClaudeRuntimeEvent } from '../models/claude-runtime.model';
import { getWebSocketUrl } from '../runtime/runtime-config';
import { AgentConnectionPhase } from './agent-runtime-websocket.service';

interface Connection {
  ws: WebSocket;
  subject: Subject<ClaudeRuntimeEvent>;
}

@Injectable({ providedIn: 'root' })
export class ClaudeTerminalTranscriptWebsocketService {
  private readonly connections = new Map<number, Connection>();
  private readonly sessionStateSubjects = new Map<
    number,
    BehaviorSubject<AgentConnectionPhase>
  >();

  constructor(private readonly ngZone: NgZone) {}

  connect(sessionId: number): Observable<ClaudeRuntimeEvent> {
    const existing = this.connections.get(sessionId);
    if (
      existing &&
      existing.ws.readyState !== WebSocket.CLOSED &&
      existing.ws.readyState !== WebSocket.CLOSING
    ) {
      return existing.subject.asObservable();
    }

    const ws = new WebSocket(
      getWebSocketUrl(
        '/claude-terminal-transcript',
        new URLSearchParams({ sessionId: String(sessionId) }),
      ),
    );
    const subject = new Subject<ClaudeRuntimeEvent>();
    const connection: Connection = { ws, subject };
    const stateSubject = this.getOrCreateStateSubject(sessionId);
    stateSubject.next('connecting');

    ws.onopen = () => {
      this.ngZone.run(() => stateSubject.next('connected'));
    };

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
        if (this.connections.get(sessionId) === connection) {
          this.connections.delete(sessionId);
          stateSubject.next('disconnected');
        }
      });
    };

    ws.onerror = () => {
      ws.close();
    };

    this.connections.set(sessionId, connection);
    return subject.asObservable();
  }

  send(sessionId: number, message: Record<string, unknown>): void {
    const connection = this.connections.get(sessionId);
    if (connection?.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify(message));
      return;
    }

    if (connection?.ws.readyState === WebSocket.CONNECTING) {
      connection.ws.addEventListener('open', () => connection.ws.send(JSON.stringify(message)), {
        once: true,
      });
    }
  }

  isConnected(sessionId: number): boolean {
    const connection = this.connections.get(sessionId);
    return (
      connection?.ws.readyState === WebSocket.OPEN ||
      connection?.ws.readyState === WebSocket.CONNECTING
    );
  }

  disconnect(sessionId: number): void {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    this.connections.delete(sessionId);
    connection.ws.close();
  }

  connectionState$(sessionId: number): Observable<AgentConnectionPhase> {
    const stateSubject = this.sessionStateSubjects.get(sessionId);
    return stateSubject ? stateSubject.asObservable() : of('disconnected');
  }

  private getOrCreateStateSubject(
    sessionId: number,
  ): BehaviorSubject<AgentConnectionPhase> {
    let subject = this.sessionStateSubjects.get(sessionId);
    if (!subject) {
      subject = new BehaviorSubject<AgentConnectionPhase>('connecting');
      this.sessionStateSubjects.set(sessionId, subject);
    }
    return subject;
  }
}
