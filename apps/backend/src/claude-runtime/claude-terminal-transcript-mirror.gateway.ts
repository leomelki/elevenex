import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClaudeTerminalTranscriptMirrorService } from './claude-terminal-transcript-mirror.service.js';

type ClientMessage = { type?: string };

@Injectable()
export class ClaudeTerminalTranscriptMirrorGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly detachByClient = new Map<WebSocket, () => void>();

  constructor(private readonly mirror: ClaudeTerminalTranscriptMirrorService) {}

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/claude-terminal-transcript') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const sessionId = Number(url.searchParams.get('sessionId'));
      if (!sessionId) {
        ws.close(1008, 'Missing sessionId');
        return;
      }

      const detach = this.mirror.attachClient(sessionId, (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });
      this.detachByClient.set(ws, detach);

      ws.on('message', (data) => {
        this.handleMessage(sessionId, ws, data.toString());
      });
      ws.on('close', () => this.detachClient(ws));
      ws.on('error', () => this.detachClient(ws));
    });
  }

  private handleMessage(sessionId: number, ws: WebSocket, raw: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendError(ws, sessionId, 'Invalid message payload');
      return;
    }

    if (message.type === 'hydrate') {
      void this.mirror.hydrate(sessionId, (event) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(event));
        }
      });
      return;
    }

    this.sendError(ws, sessionId, 'Claude transcript mirror is read-only');
  }

  private sendError(ws: WebSocket, sessionId: number, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'error', payload: { sessionId, message } }));
  }

  private detachClient(ws: WebSocket): void {
    const detach = this.detachByClient.get(ws);
    if (!detach) return;
    this.detachByClient.delete(ws);
    detach();
  }

  onModuleDestroy(): void {
    for (const [ws, detach] of this.detachByClient) {
      detach();
      ws.close(1001, 'Server shutting down');
    }
    this.detachByClient.clear();
    this.wss?.close();
  }
}
