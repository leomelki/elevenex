import { Injectable, NgZone, inject } from '@angular/core';
import { BehaviorSubject, Observable, Subject, of } from 'rxjs';
import { AgentProviderId, AgentRuntimeEvent } from '../models/agent-runtime.model';
import { getWebSocketUrl } from '../runtime/runtime-config';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';

export type AgentConnectionPhase = 'connecting' | 'connected' | 'disconnected';

interface Connection {
  ws: WebSocket;
  subject: Subject<AgentRuntimeEvent>;
  /**
   * True once an owner called `connect()`. Owners control the socket lifetime;
   * borrowers must never close a socket an owner is relying on.
   */
  owned: boolean;
  /** Number of outstanding `borrow()` calls that have not been released. */
  borrowers: number;
}

@Injectable({ providedIn: 'root' })
export class AgentRuntimeWebsocketService {
  private readonly connections = new Map<string, Connection>();
  private readonly sessionStateSubjects = new Map<string, BehaviorSubject<AgentConnectionPhase>>();
  private readonly providerSelection = inject(AgentRuntimeProviderService);

  constructor(private readonly ngZone: NgZone) {}

  connect(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): Observable<AgentRuntimeEvent> {
    const key = this.connectionKey(sessionId, provider);
    const existing = this.liveConnection(key);
    if (existing) {
      existing.owned = true;
      return existing.subject.asObservable();
    }

    return this.open(key, sessionId, provider, { owned: true }).subject.asObservable();
  }

  /**
   * Attach to a session's socket *without* owning its lifetime.
   *
   * Secondary surfaces (the review workspace thread dock, for example) need to
   * observe a session another component already owns. They must not call
   * `disconnect()`, which force-closes the socket out from under that owner —
   * they pair `borrow()` with `releaseBorrow()` instead.
   */
  borrow(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): Observable<AgentRuntimeEvent> {
    const key = this.connectionKey(sessionId, provider);
    const existing = this.liveConnection(key);
    if (existing) {
      existing.borrowers += 1;
      return existing.subject.asObservable();
    }

    const connection = this.open(key, sessionId, provider, { owned: false });
    connection.borrowers = 1;
    return connection.subject.asObservable();
  }

  /**
   * Drop one `borrow()` reference. The socket is closed only when no borrowers
   * remain *and* no owner ever claimed it via `connect()`.
   */
  releaseBorrow(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): void {
    const key = this.connectionKey(sessionId, provider);
    const connection = this.connections.get(key);
    if (!connection) {
      return;
    }

    connection.borrowers = Math.max(0, connection.borrowers - 1);
    if (connection.borrowers > 0 || connection.owned) {
      return;
    }

    this.connections.delete(key);
    connection.ws.close();
  }

  private open(
    key: string,
    sessionId: number,
    provider: AgentProviderId,
    options: { owned: boolean },
  ): Connection {
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
    const connection: Connection = {
      ws,
      subject,
      owned: options.owned,
      borrowers: 0,
    };

    const stateSubject = this.getOrCreateStateSubject(key);
    stateSubject.next('connecting');

    ws.onopen = () => {
      this.ngZone.run(() => stateSubject.next('connected'));
    };

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
          stateSubject.next('disconnected');
        }
      });
    };

    ws.onerror = () => {
      ws.close();
    };

    this.connections.set(key, connection);
    return connection;
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

  /**
   * Owner-side close. Force-closes the socket regardless of borrowers, which is
   * what the owning surface wants on teardown. Borrowers use `releaseBorrow()`.
   */
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

  connectionState$(
    sessionId: number,
    provider: AgentProviderId = this.providerSelection.currentProvider,
  ): Observable<AgentConnectionPhase> {
    const key = this.connectionKey(sessionId, provider);
    const stateSubject = this.sessionStateSubjects.get(key);
    return stateSubject ? stateSubject.asObservable() : of('disconnected');
  }

  private getOrCreateStateSubject(key: string): BehaviorSubject<AgentConnectionPhase> {
    let subject = this.sessionStateSubjects.get(key);
    if (!subject) {
      subject = new BehaviorSubject<AgentConnectionPhase>('connecting');
      this.sessionStateSubjects.set(key, subject);
    }
    return subject;
  }

  private liveConnection(key: string): Connection | null {
    const existing = this.connections.get(key);
    if (
      existing &&
      existing.ws.readyState !== WebSocket.CLOSED &&
      existing.ws.readyState !== WebSocket.CLOSING
    ) {
      return existing;
    }
    return null;
  }

  private connectionKey(sessionId: number, provider: AgentProviderId): string {
    return `${provider}:${sessionId}`;
  }
}
