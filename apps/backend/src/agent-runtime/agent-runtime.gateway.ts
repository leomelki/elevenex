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
import {
  MAX_AGENT_FRAME_BYTES,
  sendAgentFrame,
} from '../websocket/bounded-send.js';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentRuntimeEvent } from './agent-runtime.types.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AgentFocusService } from '../agent-focus/agent-focus.service.js';

type AgentRuntimeClientAction =
  | { type: 'hydrate'; includeHistory?: boolean }
  | {
      type: 'submit_prompt';
      prompt: string;
      titlePrompt?: string;
      queue?: boolean;
      images?: {
        mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
        data: string;
      }[];
      /**
       * The code session the user had focused in the UI when they sent this
       * message, if any. Recorded out-of-band (NOT injected into the prompt) so
       * the agent can pull it on demand via `get_focused_session`.
       */
      focusedSessionId?: number | null;
    }
  | { type: 'watch_subagent'; agentId: string }
  | { type: 'unwatch_subagent'; agentId: string }
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
  | { type: 'steer_pending_prompt'; id: string }
  | { type: 'resume_pending_prompts' }
  | { type: 'clear_pending_prompts' }
  | { type: 'open_terminal_fallback' };

@Injectable()
export class AgentRuntimeGateway implements OnModuleInit, OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly watchedAgents = new WeakMap<WebSocket, Set<string>>();
  private readonly hydrationInFlight = new WeakMap<
    WebSocket,
    {
      includeHistory: boolean;
      promise: Promise<void>;
    }
  >();

  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly agentFocus: AgentFocusService,
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
      this.sendFrame(
        ws,
        JSON.stringify({
          type: 'error',
          payload: { sessionId, message: 'Invalid message payload' },
        }),
        'error',
        sessionId,
      );
      return;
    }

    const provider = this.registry.getProvider(providerId);
    try {
      switch (action.type) {
        case 'hydrate': {
          const active = this.hydrationInFlight.get(ws);
          if (
            active &&
            (active.includeHistory || action.includeHistory === false)
          )
            return;
          // History must not wait for provider initialization/auth checks. Each
          // snapshot can render as soon as it is ready, in either order.
          // getHistory returns the full, unpaginated transcript.
          const send = (event: { type: string; payload: unknown }) => {
            if (ws.readyState === WebSocket.OPEN)
              this.sendFrame(ws, JSON.stringify(event), event.type, sessionId);
          };
          const reportError = (error: unknown) =>
            send({
              type: 'error',
              payload: {
                sessionId,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          const hydration = Promise.all([
            provider
              .getRuntimeState(sessionId)
              .then((payload) => send({ type: 'runtime_snapshot', payload }))
              .catch(reportError),
            ...(action.includeHistory === false
              ? []
              : [
                  provider
                    .getHistory(sessionId)
                    .then((history) =>
                      send({
                        type: 'history_snapshot',
                        payload: { sessionId, history },
                      }),
                    )
                    .catch(reportError),
                ]),
          ]).then(() => undefined);
          const request = {
            includeHistory: action.includeHistory !== false,
            promise: hydration,
          };
          this.hydrationInFlight.set(ws, request);
          void hydration.finally(() => {
            if (this.hydrationInFlight.get(ws) === request)
              this.hydrationInFlight.delete(ws);
          });
          return;
        }
        case 'watch_subagent': {
          if (
            typeof action.agentId !== 'string' ||
            !/^[\w-]{1,256}$/.test(action.agentId)
          )
            throw new BadRequestException('Invalid agent ID.');
          const watched = this.watchedAgents.get(ws) ?? new Set<string>();
          if (watched.size >= 32 && !watched.has(action.agentId))
            throw new BadRequestException('Too many watched agents.');
          watched.add(action.agentId);
          this.watchedAgents.set(ws, watched);
          return;
        }
        case 'unwatch_subagent':
          this.watchedAgents.get(ws)?.delete(action.agentId);
          return;
        case 'submit_prompt':
          await this.assertSessionMutable(sessionId);
          if (
            (await this.sessionsService.findOne(sessionId)).status === 'stopped'
          )
            await this.sessionsService.reactivateRuntime(sessionId);
          // Record the UI focus for this turn before submitting so the agent can
          // pull it via get_focused_session. A missing/null id clears any prior
          // focus so a stale tab is never reported.
          this.agentFocus.record(sessionId, action.focusedSessionId);
          await provider.submitPrompt(
            sessionId,
            action.prompt,
            action.titlePrompt,
            action.images,
            { human: true, queue: action.queue === true },
          );
          return;
        case 'interrupt':
          // Stopping remains available when a checkout has drifted or setup failed.
          await this.sessionsService.findOne(sessionId);
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
        case 'steer_pending_prompt':
          await this.assertSessionMutable(sessionId);
          await provider.steerPendingPrompt(sessionId, action.id);
          return;
        case 'resume_pending_prompts':
          await this.assertSessionMutable(sessionId);
          await provider.resumePendingPrompts(sessionId);
          return;
        case 'clear_pending_prompts':
          await this.assertSessionMutable(sessionId);
          await provider.clearPendingPrompts(sessionId);
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
      this.sendFrame(
        ws,
        JSON.stringify({ type: 'error', payload: { sessionId, message } }),
        'error',
        sessionId,
      );
    }
  }

  private sendFrame(
    client: WebSocket,
    serialized: string,
    type: string,
    sessionId: number,
  ): void {
    const snapshot =
      type === 'history_snapshot' ||
      type === 'runtime_snapshot' ||
      type === 'session_snapshot';
    if (sendAgentFrame(client, serialized, snapshot) !== 'oversized') return;

    // Keep the existing error protocol/socket: reconnecting would just request
    // the same oversized snapshot again. The HTTP history/export APIs remain
    // available for full transcripts beyond this transport's finite ceiling.
    sendAgentFrame(
      client,
      JSON.stringify({
        type: 'error',
        payload: {
          sessionId,
          message:
            `The ${type} frame exceeds the ${MAX_AGENT_FRAME_BYTES / (1024 * 1024)} MiB WebSocket limit. ` +
            'Use Export conversation or the HTTP history API for the full transcript, ' +
            'or start a new session. Reconnecting will not reduce its size.',
        },
      }),
    );
  }

  private async assertSessionMutable(sessionId: number): Promise<void> {
    await this.sessionsService.assertSessionWorkspaceLinked(sessionId);
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

    const childId = (event.payload as { item?: { agentId?: string } }).item
      ?.agentId;
    const targets = childId
      ? [...bucket].filter((client) =>
          this.watchedAgents.get(client)?.has(childId),
        )
      : [...bucket];
    if (!targets.length) return;
    const serialized = JSON.stringify(event);
    for (const client of targets) {
      if (client.readyState === WebSocket.OPEN) {
        this.sendFrame(client, serialized, event.type, sessionId);
      }
    }
  }

  private broadcastToProvider(
    providerId: string,
    event: { type: string; payload: unknown },
  ): void {
    const serialized = JSON.stringify(event);
    const prefix = `${providerId}:`;
    for (const [key, bucket] of this.clients.entries()) {
      if (!key.startsWith(prefix)) continue;
      for (const client of bucket) {
        if (client.readyState === WebSocket.OPEN) {
          this.sendFrame(
            client,
            serialized,
            event.type,
            Number(key.slice(prefix.length)),
          );
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
    const hasRemainingClients = Boolean(current && current.size > 0);
    if (current && current.size === 0) {
      this.clients.delete(key);
    }
    if (hadClient && !hasRemainingClients) {
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
