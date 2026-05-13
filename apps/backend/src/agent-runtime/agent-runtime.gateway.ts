import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeEvent } from './agent-runtime.types.js';
import { SessionsService } from '../sessions/sessions.service.js';

type AgentRuntimeClientAction =
  | { type: 'hydrate' }
  | {
      type: 'submit_prompt';
      prompt: string;
      titlePrompt?: string;
      images?: {
        mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
        data: string;
      }[];
    }
  | { type: 'interrupt' }
  | {
      type: 'approve_permission';
      requestId: string;
      remember?: boolean;
      content?: Record<string, unknown>;
    }
  | { type: 'deny_permission'; requestId: string; message?: string }
  | {
      type: 'answer_user_input';
      requestId: string;
      action?: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    }
  | { type: 'cancel_pending_prompt'; id: string }
  | { type: 'open_terminal_fallback' };

@Injectable()
export class AgentRuntimeGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<string, Set<WebSocket>>();

  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {}

  onModuleInit(): void {
    for (const providerInfo of this.registry.listProviders()) {
      const provider = this.registry.getProvider(providerInfo.id);
      provider.on('event', (event: AgentRuntimeEvent) => {
        this.broadcast(providerInfo.id, event.payload.sessionId, event);
      });
      provider.on('auth_status', (status: unknown) => {
        this.broadcastToProvider(providerInfo.id, {
          type: 'auth_status',
          payload: { status },
        });
      });
    }
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/agent-runtime') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const sessionId = Number(url.searchParams.get('sessionId'));
      const providerId = url.searchParams.get('provider') || 'claude';

      if (!sessionId) {
        ws.close(1008, 'Missing sessionId');
        return;
      }

      try {
        this.registry.getProvider(providerId);
      } catch (error) {
        ws.close(
          1008,
          error instanceof Error ? error.message : 'Invalid provider',
        );
        return;
      }

      const key = this.clientKey(providerId, sessionId);
      const bucket = this.clients.get(key) ?? new Set<WebSocket>();
      bucket.add(ws);
      this.clients.set(key, bucket);
      this.registry.getProvider(providerId).onClientAttached?.(sessionId);

      ws.on('message', (data) => {
        void this.handleMessage(providerId, sessionId, ws, data.toString());
      });

      ws.on('close', () => this.removeClient(providerId, sessionId, key, ws));
      ws.on('error', () => this.removeClient(providerId, sessionId, key, ws));
    });
  }

  private async handleMessage(
    providerId: string,
    sessionId: number,
    ws: WebSocket,
    rawMessage: string,
  ): Promise<void> {
    let action: AgentRuntimeClientAction;
    try {
      action = JSON.parse(rawMessage) as AgentRuntimeClientAction;
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { sessionId, message: 'Invalid message payload' },
        }),
      );
      return;
    }

    const provider = this.registry.getProvider(providerId);
    try {
      switch (action.type) {
        case 'hydrate': {
          const snapshot = await provider.getSnapshot(sessionId);
          ws.send(
            JSON.stringify({ type: 'session_snapshot', payload: snapshot }),
          );
          return;
        }
        case 'submit_prompt':
          await this.assertSessionMutable(sessionId);
          await provider.submitPrompt(
            sessionId,
            action.prompt,
            action.titlePrompt,
            action.images,
          );
          return;
        case 'interrupt':
          await this.assertSessionMutable(sessionId);
          await provider.interrupt(sessionId);
          return;
        case 'approve_permission':
          await this.assertSessionMutable(sessionId);
          await this.registry
            .getProviderFeature(providerId, 'approvePermission')
            .approvePermission(
              sessionId,
              action.requestId,
              action.remember ?? false,
              action.content,
            );
          return;
        case 'deny_permission':
          await this.assertSessionMutable(sessionId);
          await this.registry
            .getProviderFeature(providerId, 'denyPermission')
            .denyPermission(sessionId, action.requestId, action.message);
          return;
        case 'answer_user_input':
          await this.assertSessionMutable(sessionId);
          await this.registry
            .getProviderFeature(providerId, 'answerUserInput')
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
          await this.assertSessionMutable(sessionId);
          await provider.cancelPendingPrompt(sessionId, action.id);
          return;
        case 'open_terminal_fallback':
          await this.assertSessionMutable(sessionId);
          await this.registry
            .getProviderFeature(providerId, 'openTerminalFallback')
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

  private async assertSessionMutable(sessionId: number): Promise<void> {
    const session = await this.sessionsService.findOne(sessionId);
    if (session.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only');
    }
  }

  private broadcast(
    providerId: string,
    sessionId: number,
    event: AgentRuntimeEvent,
  ): void {
    const bucket = this.clients.get(this.clientKey(providerId, sessionId));
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

  private broadcastToProvider(providerId: string, event: unknown): void {
    const serialized = JSON.stringify(event);
    const prefix = `${providerId}:`;
    for (const [key, bucket] of this.clients.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const client of bucket) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(serialized);
        }
      }
    }
  }

  private removeClient(
    providerId: string,
    sessionId: number,
    key: string,
    ws: WebSocket,
  ): void {
    const current = this.clients.get(key);
    const hadClient = current?.delete(ws) ?? false;
    if (current && current.size === 0) {
      this.clients.delete(key);
    }
    if (hadClient) {
      this.registry.getProvider(providerId).onClientDetached?.(sessionId);
    }
  }

  private clientKey(providerId: string, sessionId: number): string {
    return `${providerId}:${sessionId}`;
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
