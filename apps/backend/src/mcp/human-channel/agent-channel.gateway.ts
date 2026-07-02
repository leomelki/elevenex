import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import {
  AgentHumanChannelService,
  type AgentNotification,
  type AgentShowRequest,
  type AgentApprovalRequest,
  type AgentApprovalResolution,
  type AgentSelectionRequest,
  type AgentSelectionResolution,
  type SelectedPath,
} from './human-channel.js';

/** Path the agent panel connects to for the live agent→human channel. */
const AGENT_CHANNEL_PATH = '/agent-channel';

/** Inbound message the panel sends to answer a blocking approval/escalation. */
interface ResolveApprovalMessage {
  type: 'resolve_approval';
  id: string;
  decision: string;
  note?: string;
}

/** Inbound message the panel sends to answer a blocking selection request. */
interface ResolveSelectionMessage {
  type: 'resolve_selection';
  id: string;
  outcome: AgentSelectionResolution['outcome'];
  paths?: SelectedPath[];
  text?: string;
}

type InboundMessage = ResolveApprovalMessage | ResolveSelectionMessage;

/**
 * Bridges the in-memory `AgentHumanChannelService` to the frontend agent panel
 * over a raw WebSocket (same pattern as the other elevenex gateways). On
 * connect it replays any approvals still awaiting a decision; thereafter it
 * streams notifications / show-cards / approval requests, and accepts
 * `resolve_approval` messages from the panel to unblock a waiting tool call.
 *
 * Optional `?agentSessionId=` query param scopes the stream to one agent
 * session; omitted = receive everything (global panel).
 */
@Injectable()
export class AgentChannelGateway implements OnModuleDestroy {
  private readonly logger = new Logger(AgentChannelGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<{
    ws: WebSocket;
    agentSessionId: number | null;
  }>();

  constructor(private readonly channel: AgentHumanChannelService) {
    this.channel.on('notification', (n: AgentNotification) =>
      this.broadcast(n.agentSessionId, { type: 'notification', notification: n }),
    );
    this.channel.on('show', (s: AgentShowRequest) =>
      this.broadcast(s.agentSessionId, { type: 'show', show: s }),
    );
    this.channel.on('approval', (a: AgentApprovalRequest) =>
      this.broadcast(a.agentSessionId, { type: 'approval', approval: a }),
    );
    this.channel.on('approval-resolved', (r: AgentApprovalResolution) =>
      this.broadcast(null, { type: 'approval_resolved', resolution: r }),
    );
    this.channel.on('selection', (s: AgentSelectionRequest) =>
      this.broadcast(s.agentSessionId, { type: 'selection', selection: s }),
    );
    this.channel.on('selection-resolved', (r: AgentSelectionResolution) =>
      this.broadcast(null, { type: 'selection_resolved', resolution: r }),
    );
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname !== AGENT_CHANNEL_PATH) return;
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const raw = url.searchParams.get('agentSessionId');
      const agentSessionId = raw ? Number.parseInt(raw, 10) || null : null;
      const client = { ws, agentSessionId };
      this.clients.add(client);

      // Replay outstanding approvals so a (re)connecting panel can render them.
      for (const approval of this.channel.pendingApprovals(
        agentSessionId ?? undefined,
      )) {
        this.send(ws, { type: 'approval', approval });
      }
      // Replay outstanding selection requests too.
      for (const selection of this.channel.pendingSelections(
        agentSessionId ?? undefined,
      )) {
        this.send(ws, { type: 'selection', selection });
      }
      this.send(ws, { type: 'ready' });

      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('close', () => this.clients.delete(client));
      ws.on('error', () => this.clients.delete(client));
    });
  }

  private onMessage(raw: string): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw) as InboundMessage;
    } catch {
      return;
    }
    if (msg.type === 'resolve_approval' && typeof msg.id === 'string') {
      const ok = this.channel.resolveApproval({
        id: msg.id,
        decision: msg.decision,
        note: msg.note,
      });
      if (!ok) this.logger.debug(`resolve_approval for unknown id ${msg.id}`);
      return;
    }
    if (msg.type === 'resolve_selection' && typeof msg.id === 'string') {
      const ok = this.channel.resolveSelection({
        id: msg.id,
        outcome: msg.outcome,
        paths: msg.paths,
        text: msg.text,
      });
      if (!ok) this.logger.debug(`resolve_selection for unknown id ${msg.id}`);
    }
  }

  /** Send to every client subscribed to this agent session (or to all). */
  private broadcast(
    agentSessionId: number | null,
    payload: Record<string, unknown>,
  ): void {
    for (const client of this.clients) {
      if (
        client.agentSessionId !== null &&
        agentSessionId !== null &&
        client.agentSessionId !== agentSessionId
      ) {
        continue;
      }
      this.send(client.ws, payload);
    }
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  onModuleDestroy(): void {
    for (const client of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.wss?.close();
  }
}
