import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ClaudeHooksService } from './claude-hooks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';

@Injectable()
export class ClaudeHooksGateway implements OnModuleInit, OnModuleDestroy {
  /**
   * Heartbeat cadence. Serves both directions: `ping` reaps sockets whose peer
   * is gone, and the `heartbeat` message lets the client notice silence.
   * Without it a half-open socket (SSH tunnel blip, host sleep, network
   * switch) stays `OPEN` on both ends forever and the sidebar silently stops
   * updating for the rest of the window's life.
   */
  private static readonly HEARTBEAT_INTERVAL_MS = 25_000;

  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private readonly awaitingPong = new WeakSet<WebSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly hooksService: ClaudeHooksService,
    private readonly sessionsService: SessionsService,
    private readonly navEvents: NavigationEventsService,
  ) {}

  onModuleInit(): void {
    this.hooksService.on(
      'status-changed',
      (data: {
        sessionId: number;
        status: string;
        activityStatus?: string;
        actionKind?: string | null;
        actionLabel?: string | null;
        backgroundActive?: boolean;
      }) => {
        this.broadcast({
          type: 'status-changed',
          sessionId: data.sessionId,
          status: data.status,
          activityStatus: data.activityStatus ?? data.status,
          actionKind: data.actionKind ?? null,
          actionLabel: data.actionLabel ?? null,
          backgroundActive: data.backgroundActive ?? false,
        });
      },
    );

    this.sessionsService.on(
      'session-status-changed',
      (data: { sessionId: number; status: string }) => {
        this.broadcast({
          type: 'session-status-changed',
          sessionId: data.sessionId,
          status: data.status,
        });
      },
    );

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

    this.sessionsService.on(
      'session-worktree-context-changed',
      (data: { sessionId: number; hasInjectedWorktreeContext: boolean }) => {
        this.broadcast({ type: 'session-worktree-context-changed', ...data });
      },
    );

    this.navEvents.on('tree-invalidated', () => {
      this.broadcast({ type: 'tree-invalidated' });
    });
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
      this.awaitingPong.delete(ws);
      ws.on('pong', () => this.awaitingPong.delete(ws));
      // Registered before the await below: a client that disconnects while the
      // initial snapshot is being fetched would otherwise never be removed.
      ws.on('close', () => {
        this.removeClient(ws);
      });
      ws.on('error', () => {
        this.removeClient(ws);
      });
      this.ensureHeartbeat();

      // Fetch DB data first, then snapshot in-memory status. Any status-changed
      // broadcasts that arrive at this client during the DB fetch will be queued
      // before the init message; capturing statuses/activities after the await
      // ensures init reflects those updates and does not overwrite them.
      const sessions = await this.sessionsService
        .findAllCompletionStates()
        .catch(() => []);
      const statuses = this.hooksService.getAllStatuses();
      const activities = this.hooksService.getAllActivities();
      const completions: Record<
        number,
        {
          hasUnreviewedCompletion: boolean;
          lastCompletionAt: string | null;
          lastCompletionKind: string | null;
          lastStateChangeAt: string | null;
        }
      > = {};
      const worktreeContexts: Record<number, boolean> = {};
      for (const session of sessions) {
        completions[session.id] = {
          hasUnreviewedCompletion: session.hasUnreviewedCompletion,
          lastCompletionAt: session.lastCompletionAt,
          lastCompletionKind: session.lastCompletionKind,
          lastStateChangeAt: session.lastStateChangeAt,
        };
        worktreeContexts[session.id] = session.hasInjectedWorktreeContext;
      }
      ws.send(
        JSON.stringify({
          type: 'init',
          statuses,
          activities,
          completions,
          worktreeContexts,
        }),
      );
    });
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(
      () => this.sweep(),
      ClaudeHooksGateway.HEARTBEAT_INTERVAL_MS,
    );
  }

  private removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Drops clients that missed a full heartbeat round-trip, then pings the rest.
   * A `send` to a half-open socket succeeds for as long as the OS keeps
   * retransmitting, so an unanswered ping is the only timely signal we get.
   */
  private sweep(): void {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        this.removeClient(client);
        continue;
      }

      if (this.awaitingPong.has(client)) {
        this.removeClient(client);
        client.terminate();
        continue;
      }

      this.awaitingPong.add(client);
      client.ping();
    }

    this.broadcast({ type: 'heartbeat' });
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
