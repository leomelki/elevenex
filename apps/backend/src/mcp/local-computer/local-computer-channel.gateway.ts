import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ToolError } from '../tool-registry/tool.types.js';

const LOCAL_COMPUTER_CHANNEL_PATH = '/local-computer-channel';
const MAX_TIMEOUT_MS = 120_000;

export interface LocalBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  cwd: string;
}

interface ReadyClient {
  ws: WebSocket;
  label: string;
  platform: string;
  pendingIds: Set<string>;
}

interface PendingExecution {
  client: ReadyClient;
  resolve: (result: LocalBashResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup: () => void;
}

/**
 * Reverse RPC over the renderer's existing backend connection. The desktop is
 * the client, so this works unchanged through SSH/WSL tunnels and paired links
 * without exposing a listener on the user's computer.
 */
@Injectable()
export class LocalComputerChannelGateway implements OnModuleDestroy {
  private readonly logger = new Logger(LocalComputerChannelGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<ReadyClient>();
  private readonly pending = new Map<string, PendingExecution>();

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname !== LOCAL_COMPUTER_CHANNEL_PATH) return;
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      let client: ReadyClient | null = null;
      ws.on('message', (data) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        if (message['type'] === 'ready' && !client) {
          client = {
            ws,
            label: `${message['label'] || 'Local computer'}`.slice(0, 200),
            platform: `${message['platform'] || 'unknown'}`.slice(0, 40),
            pendingIds: new Set(),
          };
          this.clients.add(client);
          return;
        }

        if (message['type'] === 'result' && typeof message['id'] === 'string') {
          this.resolveExecution(message['id'], message['result']);
        }
      });
      const close = () => {
        if (!client) return;
        this.clients.delete(client);
        for (const id of [...client.pendingIds]) {
          this.rejectExecution(
            id,
            new Error('The local computer disconnected.'),
          );
        }
      };
      ws.on('close', close);
      ws.on('error', close);
    });
  }

  async runBash(args: {
    command: string;
    cwd?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<LocalBashResult> {
    if (args.signal.aborted) {
      throw new ToolError({
        code: 'local_bash_cancelled',
        message: 'Local Bash command was cancelled before it started.',
      });
    }
    const client = [...this.clients].find(
      (candidate) => candidate.ws.readyState === WebSocket.OPEN,
    );
    if (!client) {
      throw new ToolError({
        code: 'local_bash_unavailable',
        message:
          'Local computer Bash access is not enabled or its desktop is disconnected.',
        remediation:
          'Ask the user to enable “Local computer Bash” in Elevenex Settings on the computer they are working from.',
        retryable: true,
      });
    }

    const id = randomUUID();
    const timeoutMs = Math.min(Math.max(1_000, args.timeoutMs), MAX_TIMEOUT_MS);
    return new Promise<LocalBashResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'cancel', id }));
        }
        this.rejectExecution(id, new Error('Local Bash command timed out.'));
      }, timeoutMs + 2_000);
      timer.unref?.();

      const onAbort = () => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'cancel', id }));
        }
        this.rejectExecution(
          id,
          new Error('Local Bash command was cancelled.'),
        );
      };
      args.signal.addEventListener('abort', onAbort, { once: true });
      const abortCleanup = () =>
        args.signal.removeEventListener('abort', onAbort);

      this.pending.set(id, { client, resolve, reject, timer, abortCleanup });
      client.pendingIds.add(id);
      client.ws.send(
        JSON.stringify({
          type: 'execute',
          id,
          command: args.command,
          cwd: args.cwd,
          timeoutMs,
        }),
      );
    });
  }

  private resolveExecution(id: string, raw: unknown): void {
    const pending = this.takePending(id);
    if (!pending) return;
    if (!raw || typeof raw !== 'object') {
      pending.reject(new Error('Local computer returned an invalid result.'));
      return;
    }
    const result = raw as Record<string, unknown>;
    if (typeof result['error'] === 'string') {
      pending.reject(new Error(result['error']));
      return;
    }
    pending.resolve({
      stdout: typeof result['stdout'] === 'string' ? result['stdout'] : '',
      stderr: typeof result['stderr'] === 'string' ? result['stderr'] : '',
      exitCode:
        typeof result['exitCode'] === 'number' ? result['exitCode'] : null,
      signal: typeof result['signal'] === 'string' ? result['signal'] : null,
      timedOut: result['timedOut'] === true,
      truncated: result['truncated'] === true,
      cwd: typeof result['cwd'] === 'string' ? result['cwd'] : '',
    });
  }

  private rejectExecution(id: string, error: Error): void {
    this.takePending(id)?.reject(error);
  }

  private takePending(id: string): PendingExecution | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    pending.client.pendingIds.delete(id);
    clearTimeout(pending.timer);
    pending.abortCleanup();
    return pending;
  }

  onModuleDestroy(): void {
    for (const id of [...this.pending.keys()]) {
      this.rejectExecution(id, new Error('Backend is shutting down.'));
    }
    for (const client of this.clients)
      client.ws.close(1001, 'Server shutting down');
    this.clients.clear();
    this.wss?.close();
    this.logger.debug('Local computer channel stopped');
  }
}
