import { Injectable, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { FileWatcherService, FileChangeEvent } from './file-watcher.service.js';

/**
 * WebSocket gateway for broadcasting file change events to connected clients.
 *
 * The gateway follows the same pattern as terminal.gateway.ts:
 * - Manual upgrade handling on HTTP server (noServer mode)
 * - Worktree-based connections via URL params
 * - Clean disconnect handling with OnModuleDestroy
 *
 * Clients connect to /file-changes?worktreePath=/path/to/worktree
 * and receive JSON messages when files change in that worktree.
 *
 * Event format:
 * {
 *   type: 'file-change',
 *   event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir',
 *   path: string, // Relative path from worktree root
 *   worktreePath: string, // Absolute worktree path
 * }
 *
 * @example
 * // Connect from VS Code Web
 * const ws = new WebSocket('ws://localhost:3000/file-changes?worktreePath=/path/to/worktree');
 * ws.onmessage = (event) => {
 *   const data = JSON.parse(event.data);
 *   console.log(`File ${data.path} changed: ${data.event}`);
 * };
 */
@Injectable()
export class FileChangeGateway implements OnModuleDestroy {
  /** WebSocket server instance in noServer mode */
  private wss: WebSocketServer | null = null;

  /** Map of worktree paths to their connected WebSocket clients */
  private clients = new Map<string, Set<WebSocket>>();

  /**
   * Constructor with forwardRef for circular dependency with FileWatcherService.
   * FileWatcherService injects FileChangeGateway for broadcasting events.
   */
  constructor(
    @Inject(forwardRef(() => FileWatcherService))
    private readonly fileWatcher: FileWatcherService,
  ) {}

  /**
   * Attach the WebSocket gateway to the HTTP server.
   * Handles upgrade requests for /file-changes path.
   *
   * @param server - The HTTP server to attach to
   */
  attachToServer(server: HttpServer): void {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle WebSocket upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      if (url.pathname === '/file-changes') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Don't destroy socket - other gateways handle other paths (terminal, user-terminal)
    });

    this.wss.on('connection', (ws, request) => {
      const url = new URL(request.url!, `ws://${request.headers.host}`);
      const worktreePath = url.searchParams.get('worktreePath');

      if (!worktreePath) {
        ws.close(1008, 'Missing worktreePath');
        return;
      }

      this.handleConnection(ws, worktreePath);
    });
  }

  /**
   * Handle a new WebSocket connection for a specific worktree.
   * Adds the client to the worktree's client set and starts watching.
   *
   * @param ws - The WebSocket connection
   * @param worktreePath - The worktree path to watch
   */
  private handleConnection(ws: WebSocket, worktreePath: string): void {
    // Add client to worktree group
    if (!this.clients.has(worktreePath)) {
      this.clients.set(worktreePath, new Set());
    }
    this.clients.get(worktreePath)!.add(ws);

    // Start watching this worktree (if not already)
    // The callback will broadcast events to all clients
    this.fileWatcher.watchWorktree(worktreePath, (event) => {
      this.broadcast(worktreePath, event);
    });

    // Handle client disconnect
    ws.on('close', () => {
      const clients = this.clients.get(worktreePath);
      if (clients) {
        clients.delete(ws);
        // Unwatch worktree when last client disconnects
        if (clients.size === 0) {
          this.clients.delete(worktreePath);
          this.fileWatcher.unwatchWorktree(worktreePath);
        }
      }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error(`WebSocket error for worktree ${worktreePath}:`, error);
      const clients = this.clients.get(worktreePath);
      if (clients) {
        clients.delete(ws);
      }
    });
  }

  /**
   * Broadcast a file change event to all clients watching a specific worktree.
   *
   * @param worktreePath - The worktree path to broadcast to
   * @param event - The file change event from FileWatcherService
   */
  broadcast(worktreePath: string, event: FileChangeEvent): void {
    const clients = this.clients.get(worktreePath);
    if (!clients) return;

    const message = JSON.stringify({
      type: 'file-change',
      event: event.event,
      path: event.path,
      worktreePath: event.worktreePath,
    });

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  /**
   * Lifecycle hook called when the module is destroyed.
   * Closes all WebSocket connections and the server cleanly.
   */
  onModuleDestroy(): void {
    // Close all WebSocket connections
    for (const [worktreePath, clients] of this.clients) {
      for (const ws of clients) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
    this.wss?.close();
  }
}