import { Injectable, NgZone, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { AgentProviderId, AgentRuntimeEvent } from '../models/agent-runtime.model';
import { getWebSocketUrl } from '../runtime/runtime-config';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

interface Connection {
  ws: WebSocket;
  subject: Subject<AgentRuntimeEvent>;
}

@Injectable({ providedIn: 'root' })
export class AgentRuntimeWebsocketService {
  private readonly connections = new Map<string, Connection>();
  private readonly providerSelection = inject(AgentRuntimeProviderService);

  constructor(private readonly ngZone: NgZone) {}

  connect(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): Observable<AgentRuntimeEvent> {
    const key = this.connectionKey(sessionId, provider);
    const existing = this.connections.get(key);
    if (
      existing &&
      existing.ws.readyState !== WebSocket.CLOSED &&
      existing.ws.readyState !== WebSocket.CLOSING
    ) {
      return existing.subject.asObservable();
    }

    const ws = new WebSocket(
      getWebSocketUrl(
        '/agent-runtime',
        new URLSearchParams({
          sessionId: String(sessionId),
          provider,
        }),
      ),
    );
    const subject = new Subject<AgentRuntimeEvent>();
    const connection: Connection = { ws, subject };

    ws.onmessage = (event) => {
      this.ngZone.run(() => {
        try {
          subject.next(JSON.parse(event.data) as AgentRuntimeEvent);
        } catch {
          // Ignore malformed events.
        }
      });
    };

    ws.onclose = () => {
      this.ngZone.run(() => {
        subject.complete();
        if (this.connections.get(key) === connection) {
          this.connections.delete(key);
        }
      });
    };

    ws.onerror = () => {
      ws.close();
    };

    this.connections.set(key, connection);
    return subject.asObservable();
  }

  send(
    sessionId: number,
    message: Record<string, unknown>,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): void {
    const connection = this.connections.get(this.connectionKey(sessionId, provider));
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

  isConnected(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): boolean {
    const connection = this.connections.get(this.connectionKey(sessionId, provider));
    return (
      connection?.ws.readyState === WebSocket.OPEN
      || connection?.ws.readyState === WebSocket.CONNECTING
    );
  }

  disconnect(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): void {
    const key = this.connectionKey(sessionId, provider);
    const connection = this.connections.get(key);
    if (!connection) {
      return;
    }

    this.connections.delete(key);
    connection.ws.close();
  }

  disconnectSession(sessionId: number): void {
    const suffix = `:${sessionId}`;
    for (const [key, connection] of this.connections) {
      if (!key.endsWith(suffix)) {
        continue;
      }
      this.connections.delete(key);
      connection.ws.close();
    }
  }

  private connectionKey(sessionId: number, provider: AgentProviderId): string {
    return `${provider}:${sessionId}`;
  }
}
