import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { getWebSocketUrl } from '../runtime/runtime-config';
import { ActionStatus } from '../models/action.model';

interface ActionMessage {
  type: 'status';
  status: ActionStatus;
}

interface Connection {
  ws: WebSocket;
  dataSubject: Subject<string>;
  openSubject: Subject<void>;
  closeSubject: Subject<CloseEvent>;
  errorSubject: Subject<Event>;
  statusSubject: Subject<ActionStatus>;
}

@Injectable({ providedIn: 'root' })
export class ActionTerminalWebsocketService {
  private connections = new Map<number, Connection>();

  constructor(private readonly ngZone: NgZone) {}

  connect(actionId: number): {
    onData$: Observable<string>;
    onOpen$: Observable<void>;
    onClose$: Observable<CloseEvent>;
    onError$: Observable<Event>;
    onStatus$: Observable<ActionStatus>;
  } {
    if (this.connections.has(actionId)) {
      const existing = this.connections.get(actionId)!;
      return {
        onData$: existing.dataSubject.asObservable(),
        onOpen$: existing.openSubject.asObservable(),
        onClose$: existing.closeSubject.asObservable(),
        onError$: existing.errorSubject.asObservable(),
        onStatus$: existing.statusSubject.asObservable(),
      };
    }

    const ws = new WebSocket(getWebSocketUrl('/action-terminal', new URLSearchParams({
      actionId: String(actionId),
    })));

    const connection: Connection = {
      ws,
      dataSubject: new Subject<string>(),
      openSubject: new Subject<void>(),
      closeSubject: new Subject<CloseEvent>(),
      errorSubject: new Subject<Event>(),
      statusSubject: new Subject<ActionStatus>(),
    };

    ws.onopen = () => {
      this.ngZone.run(() => connection.openSubject.next());
    };

    ws.onmessage = (event) => {
      this.ngZone.run(() => {
        const payload = typeof event.data === 'string' ? event.data : '';
        try {
          const parsed = JSON.parse(payload) as ActionMessage;
          if (parsed.type === 'status') {
            connection.statusSubject.next(parsed.status);
            return;
          }
        } catch {
          // Plain terminal output.
        }
        connection.dataSubject.next(payload);
      });
    };

    ws.onclose = (event) => {
      this.ngZone.run(() => {
        connection.closeSubject.next(event);
        this.connections.delete(actionId);
      });
    };

    ws.onerror = (event) => {
      this.ngZone.run(() => connection.errorSubject.next(event));
    };

    this.connections.set(actionId, connection);

    return {
      onData$: connection.dataSubject.asObservable(),
      onOpen$: connection.openSubject.asObservable(),
      onClose$: connection.closeSubject.asObservable(),
      onError$: connection.errorSubject.asObservable(),
      onStatus$: connection.statusSubject.asObservable(),
    };
  }

  disconnect(actionId: number): void {
    const connection = this.connections.get(actionId);
    if (!connection) return;
    connection.ws.close();
    this.connections.delete(actionId);
  }
}
