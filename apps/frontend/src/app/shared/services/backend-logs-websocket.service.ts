import { Injectable, NgZone, OnDestroy } from '@angular/core';
import Anser from 'anser';
import { getWebSocketUrl } from '../runtime/runtime-config';

interface LogEntry {
  level: 'log' | 'error';
  message: string;
  timestamp: string;
}

function parseAnsi(text: string): [string, ...string[]] {
  const spans = Anser.ansiToJson(text, { use_classes: false });
  if (spans.every(s => !s.fg && !s.bg && !s.decorations?.length)) return [text];

  const format = spans.map(s => `%c${s.content}`).join('');
  const styles = spans.map(s => {
    const parts: string[] = [];
    if (s.fg) parts.push(`color: rgb(${s.fg})`);
    if (s.bg) parts.push(`background-color: rgb(${s.bg})`);
    if (s.decorations?.includes('bold')) parts.push('font-weight: bold');
    if (s.decorations?.includes('dim')) parts.push('opacity: 0.5');
    return parts.join('; ');
  });
  return [format, ...styles];
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
        const prefix = `[backend ${entry.timestamp}] `;
        const args = parseAnsi(entry.message);
        args[0] = `%c${prefix}%c` + args[0];
        args.splice(1, 0, 'color: gray', '');
        if (entry.level === 'error') {
          console.error(...args);
        } else {
          console.log(...args);
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
