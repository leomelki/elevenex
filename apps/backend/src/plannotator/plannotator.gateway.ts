import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { CookieProxyService } from './cookie-proxy.service.js';
import { PlannotatorRegistryService } from './plannotator-registry.service.js';
import { IpcServerService } from './ipc-server.service.js';
import {
  PlannotatorSessionWatcher,
  SessionMatchResult,
} from './session-watcher.service.js';

export interface PlannotatorUrlEvent {
  type: 'url-received';
  url: string;
  proxyUrl: string;
  sessionId: number | null;
  upstreamPort: number;
}

export interface PlannotatorSessionEvent {
  type: 'session-started' | 'session-ended';
  plannotatorSession?: {
    pid: number;
    port: number;
    url: string;
    mode: string;
    project: string;
    startedAt: string;
    label: string;
  };
  elevenexSessionId?: number | null;
  worktreePath?: string | null;
  pid?: number;
  port?: number;
}

export interface PlannotatorCloseEvent {
  type: 'close';
  upstreamPort: number;
  sessionId?: number | null;
}

@Injectable()
@WebSocketGateway({
  namespace: '/plannotator',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class PlannotatorGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger('PlannotatorGateway');

  constructor(
    private readonly ipcServer: IpcServerService,
    private readonly cookieProxy: CookieProxyService,
    private readonly registry: PlannotatorRegistryService,
    private readonly sessionWatcher: PlannotatorSessionWatcher,
  ) {}

  afterInit(server: Server) {
    this.logger.log('Plannotator WebSocket gateway initialized');

    this.ipcServer.on('url-received', (event) => {
      this.handleIpcUrlReceived(event);
    });

    this.sessionWatcher.on('session-started', (match: SessionMatchResult) => {
      this.handleSessionStarted(match);
    });

    this.sessionWatcher.on('session-ended', (data: { pid: number; port: number }) => {
      this.handleSessionEnded(data);
    });

    this.registry.on('panel-opened', (panel) => {
      this.handlePanelOpened(panel);
    });

    this.cookieProxy.on('close', (upstreamPort: number) => {
      this.handleProxyClose(upstreamPort);
    });

    this.registry.on('panel-closed', (data: { sessionId: number; upstreamPort: number }) => {
      this.handlePanelClosed(data.sessionId, data.upstreamPort);
    });

    for (const session of this.sessionWatcher.getActiveSessions()) {
      this.handleSessionStarted(this.sessionWatcher.getMatchForSession(session));
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`[DEBUG] Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`[DEBUG] Client disconnected: ${client.id}`);
  }

  private handlePanelOpened(panel: {
    sessionId: number;
    url: string;
    proxyUrl: string;
    upstreamPort: number;
  }): void {
    const outgoingEvent: PlannotatorUrlEvent = {
      type: 'url-received',
      url: panel.url,
      proxyUrl: panel.proxyUrl,
      sessionId: panel.sessionId,
      upstreamPort: panel.upstreamPort,
    };

    this.server.emit('event', outgoingEvent);
    this.logger.log(
      `[DEBUG] URL event sent: sessionId=${panel.sessionId}, upstreamPort=${panel.upstreamPort}, proxyUrl=${panel.proxyUrl}`,
    );
  }

  private handleIpcUrlReceived(event: {
    url: string;
    sessionId: number | null;
    upstreamPort: number;
  }): void {
    const resolvedSessionId =
      event.sessionId ?? this.sessionWatcher.getMatchingSessionId(event.upstreamPort);

    if (!resolvedSessionId) {
      this.logger.log(
        `Ignoring IPC plannotator URL for upstreamPort=${event.upstreamPort}: no Elevenex session match`,
      );
      return;
    }

    this.registry.registerDiscoveredOpen({
      sessionId: resolvedSessionId,
      url: event.url,
    });
  }

  private handleSessionStarted(match: SessionMatchResult): void {
    const outgoingEvent: PlannotatorSessionEvent = {
      type: 'session-started',
      plannotatorSession: {
        pid: match.plannotatorSession.pid,
        port: match.plannotatorSession.port,
        url: match.plannotatorSession.url,
        mode: match.plannotatorSession.mode,
        project: match.plannotatorSession.project,
        startedAt: match.plannotatorSession.startedAt,
        label: match.plannotatorSession.label,
      },
      elevenexSessionId: match.elevenexSessionId,
      worktreePath: match.worktreePath,
    };

    this.server.emit('event', outgoingEvent);

    if (!match.elevenexSessionId || !match.plannotatorSession.url) {
      return;
    }

    this.registry.registerDiscoveredOpen({
      sessionId: match.elevenexSessionId,
      url: match.plannotatorSession.url,
      openedAt: match.plannotatorSession.startedAt,
    });
  }

  private handleSessionEnded(data: { pid: number; port: number }): void {
    const sessionId = this.registry.getSessionIdByUpstreamPort(data.port);
    if (sessionId) {
      this.registry.registerClose({ sessionId, upstreamPort: data.port });
    }

    const outgoingEvent: PlannotatorSessionEvent = {
      type: 'session-ended',
      pid: data.pid,
      port: data.port,
    };

    this.server.emit('event', outgoingEvent);
  }

  private handleProxyClose(upstreamPort: number): void {
    this.registry.handleProxyClose(upstreamPort);
    this.sessionWatcher.terminateSessionByPort(upstreamPort);
  }

  private handlePanelClosed(sessionId: number, upstreamPort: number): void {
    const outgoingEvent: PlannotatorCloseEvent = {
      type: 'close',
      upstreamPort,
      sessionId,
    };

    this.server.emit('event', outgoingEvent);
    this.logger.log(`Close event: upstreamPort=${upstreamPort}, sessionId=${sessionId}`);
  }

  @SubscribeMessage('get-sessions')
  handleGetSessions(@ConnectedSocket() client: Socket): void {
    const sessions = this.sessionWatcher.getActiveSessions();
    client.emit('sessions', sessions);
  }

  @SubscribeMessage('get-active-panels')
  handleGetActivePanels(@ConnectedSocket() client: Socket): void {
    const panels: PlannotatorUrlEvent[] = [];
    for (const panel of this.registry.getActivePanels()) {
      panels.push({
        type: 'url-received',
        url: panel.url,
        proxyUrl: panel.proxyUrl,
        sessionId: panel.sessionId,
        upstreamPort: panel.upstreamPort,
      });
    }
    this.logger.log(`[DEBUG] get-active-panels request from ${client.id}: returning ${panels.length} panels: ${JSON.stringify(panels.map(p => ({ sessionId: p.sessionId, port: p.upstreamPort })))}`);
    client.emit('active-panels', panels);
  }

  @SubscribeMessage('close-panel')
  handleClosePanel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: number },
  ): void {
    const panel = this.registry.handleClientClose(data.sessionId);
    if (panel) {
      this.sessionWatcher.terminateSessionByPort(panel.upstreamPort);
    }
    client.emit('panel-closed', { sessionId: data.sessionId });
  }

  @SubscribeMessage('register-worktree')
  handleRegisterWorktree(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { worktreePath: string; sessionId: number },
  ): void {
    this.logger.log(`[DEBUG] register-worktree from ${client.id}: worktreePath="${data.worktreePath}", sessionId=${data.sessionId}`);
    this.ipcServer.registerWorktree(data.worktreePath);
    this.sessionWatcher.registerWorktreeSession(data.worktreePath, data.sessionId);
    client.emit('worktree-registered', { worktreePath: data.worktreePath });
  }

  @SubscribeMessage('unregister-worktree')
  handleUnregisterWorktree(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { worktreePath: string },
  ): void {
    this.ipcServer.unregisterWorktree(data.worktreePath);
    this.sessionWatcher.unregisterWorktreeSession(data.worktreePath);
    client.emit('worktree-unregistered', { worktreePath: data.worktreePath });
  }
}
