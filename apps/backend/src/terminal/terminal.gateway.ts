// apps/backend/src/terminal/terminal.gateway.ts
import { Injectable, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { PtyManager } from './pty-manager.service.js';
import { TerminalService } from './terminal.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';

interface TerminalSession {
  ws: WebSocket;
  ptyPid?: number;
}

@Injectable()
export class TerminalGateway implements OnModuleDestroy {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<number, TerminalSession>();
  private lastRestartTime = new Map<number, number>();

  constructor(
    @Inject(forwardRef(() => PtyManager)) private readonly ptyManager: PtyManager,
    @Inject(forwardRef(() => TerminalService)) private readonly terminalService: TerminalService,
    private readonly claudeHooksService: ClaudeHooksService,
  ) {}

  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/terminal') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Don't destroy socket here - let other gateways handle their paths
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const sessionId = parseInt(url.searchParams.get('sessionId') || '0');

      if (!sessionId) {
        ws.close(1008, 'Missing sessionId');
        return;
      }

      this.handleConnection(ws, sessionId);
    });
  }

  private handleConnection(ws: WebSocket, sessionId: number): void {
    // Close existing connection for this session if any
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.ws.close(1000, 'New connection established');
    }

    this.sessions.set(sessionId, { ws });

    // Start the PTY process when WebSocket connects
    void this.terminalService.startSession(sessionId)
      .then(result => {
        if (!result.success) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`\x1b[31mFailed to start terminal: ${result.error}\x1b[0m\r\n`);
            ws.close(1011, 'Failed to start terminal');
          }

          if (this.sessions.get(sessionId)?.ws === ws) {
            this.sessions.delete(sessionId);
            this.lastRestartTime.delete(sessionId);
          }
        }
      })
      .catch((error) => {
        console.error(`Failed to start terminal session ${sessionId}:`, error);

        if (ws.readyState === WebSocket.OPEN) {
          ws.send('\x1b[31mFailed to start terminal.\x1b[0m\r\n');
          ws.close(1011, 'Failed to start terminal');
        }

        if (this.sessions.get(sessionId)?.ws === ws) {
          this.sessions.delete(sessionId);
          this.lastRestartTime.delete(sessionId);
        }
      });

    ws.on('message', (data) => {
      try {
        const message = data.toString();

        // Check if it's a resize message
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            this.ptyManager.resize(sessionId, parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // Not JSON, treat as terminal input
        }

        if (message.includes('\x03')) {
          void this.claudeHooksService.handleInterrupt(sessionId).catch((error) => {
            console.error(
              `Failed to update Claude status after Ctrl-C for session ${sessionId}:`,
              error,
            );
          });
        }

        // Terminal input
        this.ptyManager.write(sessionId, message);
      } catch (error) {
        console.error(`Error handling message for session ${sessionId}:`, error);
      }
    });

    ws.on('close', () => {
      console.log(`WebSocket closed for session ${sessionId}`);
      // Kill the PTY process (detaches from tmux, but tmux session lives on)
      this.ptyManager.kill(sessionId);
      this.sessions.delete(sessionId);
      this.lastRestartTime.delete(sessionId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for session ${sessionId}:`, error);
      this.ptyManager.kill(sessionId);
      this.sessions.delete(sessionId);
    });
  }

  onUnexpectedExit(sessionId: number, exitCode: number, signal: number | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    const lastRestart = this.lastRestartTime.get(sessionId);

    // Crash loop prevention: don't restart if last restart was < 5s ago
    if (lastRestart && (now - lastRestart) < 5000) {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send('\r\n\x1b[31m[Claude crashed repeatedly — not restarting. Reconnect to try again.]\x1b[0m\r\n');
      }
      return;
    }

    this.lastRestartTime.set(sessionId, now);
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send('\r\n\x1b[33m[Claude exited, restarting...]\x1b[0m\r\n');
    }

    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        void this.terminalService.startSession(sessionId)
          .then(result => {
            if (!result.success && session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(`\r\n\x1b[31m[Failed to restart: ${result.error}]\x1b[0m\r\n`);
            }
          })
          .catch((error) => {
            console.error(`Failed to restart terminal session ${sessionId}:`, error);
            if (session.ws.readyState === WebSocket.OPEN) {
              session.ws.send('\r\n\x1b[31m[Failed to restart terminal.]\x1b[0m\r\n');
            }
          });
      }
    }, 1000);
  }

  sendToSession(sessionId: number, data: Buffer | string): void {
    const session = this.sessions.get(sessionId);
    if (session?.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(data);
    }
  }

  onModuleDestroy(): void {
    // Close all WebSocket connections
    for (const [sessionId, { ws }] of this.sessions) {
      ws.close(1001, 'Server shutting down');
    }
    this.sessions.clear();
    this.wss?.close();
  }
}
