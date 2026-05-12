import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';

type ServerConnectionMessageType = 'ready' | 'heartbeat';

interface ServerConnectionMessage {
  type: ServerConnectionMessageType;
  serverTime: string;
}

@Injectable()
export class ServerConnectionGateway implements OnModuleDestroy {
  private static readonly HEARTBEAT_INTERVAL_MS = 5000;

  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/server-connection') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      this.send(ws, 'ready');
      this.ensureHeartbeat();

      ws.on('close', () => this.removeClient(ws));
      ws.on('error', () => this.removeClient(ws));
    });
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.broadcast('heartbeat');
    }, ServerConnectionGateway.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatIfIdle(): void {
    if (this.clients.size > 0 || !this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.stopHeartbeatIfIdle();
  }

  private broadcast(type: ServerConnectionMessageType): void {
    for (const client of this.clients) {
      this.send(client, type);
    }
  }

  private send(client: WebSocket, type: ServerConnectionMessageType): void {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: ServerConnectionMessage = {
      type,
      serverTime: new Date().toISOString(),
    };
    client.send(JSON.stringify(message));
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.wss?.close();
  }
}
