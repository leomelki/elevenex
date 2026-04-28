import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { logEmitter, LogEntry } from './log-interceptor.js';

@Injectable()
export class BackendLogsGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  onModuleInit(): void {
    logEmitter.on('log', (entry: LogEntry) => {
      this.broadcast(entry);
    });
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/backend-logs') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      ws.on('close', () => { this.clients.delete(ws); });
      ws.on('error', () => { this.clients.delete(ws); });
    });
  }

  private broadcast(entry: LogEntry): void {
    const message = JSON.stringify(entry);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  onModuleDestroy(): void {
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.wss?.close();
  }
}
