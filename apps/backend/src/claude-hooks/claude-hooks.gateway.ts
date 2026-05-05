import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ClaudeHooksService } from './claude-hooks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

@Injectable()
export class ClaudeHooksGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  constructor(
    private readonly hooksService: ClaudeHooksService,
    private readonly sessionsService: SessionsService,
  ) {}

  onModuleInit(): void {
    this.hooksService.on('status-changed', (data: { sessionId: number; status: string }) => {
      this.broadcast({ type: 'status-changed', sessionId: data.sessionId, status: data.status });
    });

    this.sessionsService.on('session-status-changed', (data: { sessionId: number; status: string }) => {
      this.broadcast({ type: 'session-status-changed', sessionId: data.sessionId, status: data.status });
    });

    this.sessionsService.on(
      'session-completion-changed',
      (data: {
        sessionId: number;
        hasUnreviewedCompletion: boolean;
        lastCompletionAt: string | null;
        lastCompletionKind: string | null;
      }) => {
        this.broadcast({ type: 'session-completion-changed', ...data });
      },
    );

    this.sessionsService.on(
      'session-last-state-change-changed',
      (data: { sessionId: number; lastStateChangeAt: string | null }) => {
        this.broadcast({ type: 'session-last-state-change-changed', ...data });
      },
    );

    this.sessionsService.on(
      'session-title-changed',
      (data: { sessionId: number; name: string | null }) => {
        this.broadcast({ type: 'session-title-changed', ...data });
      },
    );
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/claude-status') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', async (ws) => {
      this.clients.add(ws);

      // Send initial state
      const statuses = this.hooksService.getAllStatuses();
      const sessions = await this.sessionsService.findAllCompletionStates().catch(() => []);
      const completions: Record<number, {
        hasUnreviewedCompletion: boolean;
        lastCompletionAt: string | null;
        lastCompletionKind: string | null;
        lastStateChangeAt: string | null;
      }> = {};
      for (const session of sessions) {
        completions[session.id] = {
          hasUnreviewedCompletion: session.hasUnreviewedCompletion,
          lastCompletionAt: session.lastCompletionAt,
          lastCompletionKind: session.lastCompletionKind,
          lastStateChangeAt: session.lastStateChangeAt,
        };
      }
      ws.send(JSON.stringify({ type: 'init', statuses, completions }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });
    });
  }

  private broadcast(data: object): void {
    const message = JSON.stringify(data);
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
