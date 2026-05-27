import {
  Injectable,
  OnModuleDestroy,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { UserPtyManager } from './user-pty-manager.service.js';
import { UserTerminalService } from './user-terminal.service.js';

interface TerminalConnection {
  ws: WebSocket;
  startupReady: boolean;
  queuedResize: TerminalResizeMessage | null;
  queuedInput: string[];
  queuedInputBytes: number;
}

interface TerminalResizeMessage {
  cols: number;
  rows: number;
}

const MAX_STARTUP_INPUT_QUEUE_BYTES = 256 * 1024;

@Injectable()
export class UserTerminalGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private connections = new Map<number, TerminalConnection>();

  constructor(
    @Inject(forwardRef(() => UserPtyManager))
    private readonly ptyManager: UserPtyManager,
    @Inject(forwardRef(() => UserTerminalService))
    private readonly terminalService: UserTerminalService,
  ) {}

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/user-terminal') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Don't destroy socket — let other gateways handle their paths
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const terminalId = parseInt(url.searchParams.get('terminalId') || '0');

      if (!terminalId) {
        ws.close(1008, 'Missing terminalId');
        return;
      }

      this.handleConnection(ws, terminalId);
    });
  }

  private handleConnection(ws: WebSocket, terminalId: number): void {
    // Close existing connection for this terminal if any
    const existing = this.connections.get(terminalId);
    if (existing) {
      existing.ws.close(1000, 'New connection established');
    }

    const connection: TerminalConnection = {
      ws,
      startupReady: false,
      queuedResize: null,
      queuedInput: [],
      queuedInputBytes: 0,
    };

    this.connections.set(terminalId, connection);
    const isCurrentConnection = () =>
      this.connections.get(terminalId)?.ws === ws;

    // Start or reattach the terminal
    void this.terminalService
      .startTerminal(terminalId)
      .then((result) => {
        if (!isCurrentConnection()) {
          return;
        }

        if (!result.success) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              `\x1b[31mFailed to start terminal: ${result.error}\x1b[0m\r\n`,
            );
            ws.close(1011, 'Failed to start terminal');
          }
          if (isCurrentConnection()) {
            this.connections.delete(terminalId);
          }
          return;
        }

        connection.startupReady = true;
        this.flushStartupQueue(terminalId, connection);
      })
      .catch((error) => {
        if (!isCurrentConnection()) {
          return;
        }

        console.error(`Failed to start user terminal ${terminalId}:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('\x1b[31mFailed to start terminal.\x1b[0m\r\n');
          ws.close(1011, 'Failed to start terminal');
        }
        if (isCurrentConnection()) {
          this.connections.delete(terminalId);
        }
      });

    ws.on('message', (data) => {
      if (!isCurrentConnection()) {
        return;
      }

      try {
        const message = data.toString();

        const resize = this.parseResizeMessage(message);

        if (!connection.startupReady) {
          this.queueStartupMessage(connection, message, resize);
          return;
        }

        if (resize) {
          this.ptyManager.resize(terminalId, resize.cols, resize.rows);
          return;
        }

        this.ptyManager.write(terminalId, message);
      } catch (error) {
        console.error(
          `Error handling message for terminal ${terminalId}:`,
          error,
        );
      }
    });

    ws.on('close', () => {
      console.log(`WebSocket closed for user terminal ${terminalId}`);
      if (!isCurrentConnection()) {
        return;
      }
      // Kill PTY attachment but tmux session persists
      this.ptyManager.kill(terminalId);
      this.connections.delete(terminalId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for user terminal ${terminalId}:`, error);
      if (!isCurrentConnection()) {
        return;
      }
      this.ptyManager.kill(terminalId);
      this.connections.delete(terminalId);
    });
  }

  sendToTerminal(terminalId: number, data: Buffer | string): void {
    const conn = this.connections.get(terminalId);
    if (conn?.ws?.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }

  private parseResizeMessage(message: string): TerminalResizeMessage | null {
    try {
      const parsed = JSON.parse(message) as {
        type?: unknown;
        cols?: unknown;
        rows?: unknown;
      };
      const cols = Number(parsed.cols);
      const rows = Number(parsed.rows);
      if (
        parsed.type === 'resize' &&
        Number.isFinite(cols) &&
        Number.isFinite(rows)
      ) {
        return { cols, rows };
      }
    } catch {
      // Not JSON, treat as terminal input.
    }

    return null;
  }

  private queueStartupMessage(
    connection: TerminalConnection,
    message: string,
    resize: TerminalResizeMessage | null,
  ): void {
    if (resize) {
      connection.queuedResize = resize;
      return;
    }

    connection.queuedInput.push(message);
    connection.queuedInputBytes += Buffer.byteLength(message);

    while (
      connection.queuedInputBytes > MAX_STARTUP_INPUT_QUEUE_BYTES &&
      connection.queuedInput.length > 0
    ) {
      const dropped = connection.queuedInput.shift();
      connection.queuedInputBytes -= Buffer.byteLength(dropped ?? '');
    }
  }

  private flushStartupQueue(
    terminalId: number,
    connection: TerminalConnection,
  ): void {
    if (connection.queuedResize) {
      this.ptyManager.resize(
        terminalId,
        connection.queuedResize.cols,
        connection.queuedResize.rows,
      );
      connection.queuedResize = null;
    }

    for (const input of connection.queuedInput) {
      this.ptyManager.write(terminalId, input);
    }
    connection.queuedInput = [];
    connection.queuedInputBytes = 0;
  }

  onModuleDestroy(): void {
    for (const [, { ws }] of this.connections) {
      ws.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    this.wss?.close();
  }
}
