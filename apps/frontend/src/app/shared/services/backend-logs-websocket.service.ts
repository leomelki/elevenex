import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { getWebSocketUrl } from '../runtime/runtime-config';

interface LogEntry {
  level: 'log' | 'error';
  message: string;
  timestamp: string;
}

@Injectable({ providedIn: 'root' })
export class BackendLogsWebsocketService implements OnDestroy {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private readonly ngZone: NgZone) {}

  start(): void {
    this.ngZone.runOutsideAngular(() => {
      this.connect();
    });
  }

  private connect(): void {
    if (this.destroyed) return;

    this.ws = new WebSocket(getWebSocketUrl('/backend-logs'));

    this.ws.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry;
        const prefix = `[backend ${entry.timestamp}]`;
        if (entry.level === 'error') {
          console.error(prefix, entry.message);
        } else {
          console.log(prefix, entry.message);
        }
      } catch {
        // ignore malformed entries
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }
}
