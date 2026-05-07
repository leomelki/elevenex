import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import {
  ClaudeRuntimeClientAction,
  ClaudeRuntimeEvent,
} from './claude-runtime.types.js';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';

@Injectable()
export class ClaudeRuntimeGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<number, Set<WebSocket>>();

  constructor(private readonly registry: AgentRuntimeRegistryService) {}

  onModuleInit(): void {
    this.registry
      .getProvider('claude')
      .on('event', (event: ClaudeRuntimeEvent) => {
        const sessionId = event.payload.sessionId;
        this.broadcast(sessionId, event);
      });
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/claude-runtime') {
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

      const bucket = this.clients.get(sessionId) ?? new Set<WebSocket>();
      bucket.add(ws);
      this.clients.set(sessionId, bucket);

      ws.on('message', (data) => {
        void this.handleMessage(sessionId, ws, data.toString());
      });

      ws.on('close', () => {
        const current = this.clients.get(sessionId);
        current?.delete(ws);
        if (current && current.size === 0) {
          this.clients.delete(sessionId);
        }
      });

      ws.on('error', () => {
        const current = this.clients.get(sessionId);
        current?.delete(ws);
        if (current && current.size === 0) {
          this.clients.delete(sessionId);
        }
      });
    });
  }

  private async handleMessage(
    sessionId: number,
    ws: WebSocket,
    rawMessage: string,
  ): Promise<void> {
    let action: ClaudeRuntimeClientAction;
    try {
      action = JSON.parse(rawMessage) as ClaudeRuntimeClientAction;
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { sessionId, message: 'Invalid message payload' },
        }),
      );
      return;
    }

    try {
      const claudeProvider = this.registry.getProvider('claude');
      switch (action.type) {
        case 'hydrate': {
          const snapshot = await claudeProvider.getSnapshot(sessionId);
          ws.send(
            JSON.stringify({ type: 'session_snapshot', payload: snapshot }),
          );
          return;
        }
        case 'submit_prompt':
          await claudeProvider.submitPrompt(
            sessionId,
            action.prompt,
            action.titlePrompt,
            action.images,
          );
          return;
        case 'interrupt':
          await claudeProvider.interrupt(sessionId);
          return;
        case 'approve_permission':
          await this.registry
            .getProviderFeature('claude', 'approvePermission')
            .approvePermission(
              sessionId,
              action.requestId,
              action.remember ?? false,
              action.content,
            );
          return;
        case 'deny_permission':
          await this.registry
            .getProviderFeature('claude', 'denyPermission')
            .denyPermission(sessionId, action.requestId, action.message);
          return;
        case 'answer_user_input':
          await this.registry
            .getProviderFeature('claude', 'answerUserInput')
            .answerUserInput(
              sessionId,
              action.requestId,
              action.action ?? 'accept',
              action.content as
                | Record<string, string | number | boolean | string[]>
                | undefined,
            );
          return;
        case 'cancel_pending_prompt':
          await claudeProvider.cancelPendingPrompt(sessionId, action.id);
          return;
        case 'open_terminal_fallback':
          await this.registry
            .getProviderFeature('claude', 'openTerminalFallback')
            .openTerminalFallback(sessionId);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ws.send(
        JSON.stringify({ type: 'error', payload: { sessionId, message } }),
      );
    }
  }

  private broadcast(sessionId: number, event: ClaudeRuntimeEvent): void {
    const bucket = this.clients.get(sessionId);
    if (!bucket) {
      return;
    }

    const serialized = JSON.stringify(event);
    for (const client of bucket) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  onModuleDestroy(): void {
    for (const bucket of this.clients.values()) {
      for (const client of bucket) {
        client.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
    this.wss?.close();
  }
}
