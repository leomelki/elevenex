import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ActionPtyManager } from './action-pty-manager.service.js';
import { ActionsService } from './actions.service.js';

interface ActionConnection {
  ws: WebSocket;
}

@Injectable()
export class ActionsGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private connections = new Map<number, Set<ActionConnection>>();

  constructor(
    private readonly ptyManager: ActionPtyManager,
    private readonly actionsService: ActionsService,
  ) {
    this.ptyManager.registerGateway(this);
  }

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/action-terminal') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const actionId = parseInt(url.searchParams.get('actionId') || '0', 10);

      if (!actionId) {
        ws.close(1008, 'Missing actionId');
        return;
      }

      void this.handleConnection(ws, actionId);
    });
  }

  private async handleConnection(ws: WebSocket, actionId: number): Promise<void> {
    const set = this.connections.get(actionId) ?? new Set<ActionConnection>();
    const connection = { ws };
    set.add(connection);
    this.connections.set(actionId, set);

    const action = await this.actionsService.findOne(actionId);
    const output = this.ptyManager.isRunning(actionId)
      ? this.ptyManager.getCurrentOutput(actionId)
      : action.currentOutput || action.lastOutput;

    if (output) {
      ws.send(output);
    }

    ws.send(JSON.stringify({
      type: 'status',
      status: this.ptyManager.isRunning(actionId) ? 'running' : action.status,
    }));

    ws.on('close', () => {
      const connections = this.connections.get(actionId);
      if (!connections) return;
      connections.delete(connection);
      if (connections.size === 0) {
        this.connections.delete(actionId);
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  }

  sendToAction(actionId: number, data: Buffer | string): void {
    const payload = typeof data === 'string' ? data : data.toString();
    for (const connection of this.connections.get(actionId) ?? []) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(payload);
      }
    }
  }

  notifyStatus(actionId: number, status: string): void {
    const payload = JSON.stringify({ type: 'status', status });
    for (const connection of this.connections.get(actionId) ?? []) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.send(payload);
      }
    }
  }

  onModuleDestroy(): void {
    for (const connections of this.connections.values()) {
      for (const { ws } of connections) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.connections.clear();
    this.wss?.close();
  }
}
