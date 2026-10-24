import {
  Injectable,
  OnModuleDestroy,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { sendBounded } from '../websocket/bounded-send.js';
import { isAbsolute } from 'node:path';
import { FileWatcherService, FileChangeEvent } from './file-watcher.service.js';
import { FilesService } from '../files/files.service.js';

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
  private pending = new Map<
    string,
    {
      events: Map<string, FileChangeEvent>;
      timer: ReturnType<typeof setTimeout>;
      resync: boolean;
    }
  >();

  /**
   * Constructor with forwardRef for circular dependency with FileWatcherService.
   * FileWatcherService injects FileChangeGateway for broadcasting events.
   */
  constructor(
    @Inject(forwardRef(() => FileWatcherService))
    private readonly fileWatcher: FileWatcherService,
    @Optional() private readonly files?: FilesService,
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

      if (!worktreePath || !isAbsolute(worktreePath)) {
        ws.close(1008, 'worktreePath must be an absolute path');
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
    if (!this.clients.has(worktreePath))
      this.files?.invalidateEditorWorkspace(worktreePath);
    // Start watching this worktree (if not already)
    // The callback will broadcast events to all clients
    try {
      this.fileWatcher.watchWorktree(worktreePath, (event) => {
        this.broadcast(worktreePath, event);
      });
    } catch (error) {
      // fs.watch throws synchronously if a worktree disappeared or is unreadable.
      // A failed WebSocket request must not terminate the backend process.
      console.warn(`Could not watch worktree ${worktreePath}:`, error);
      ws.close(1011, 'Unable to watch worktree');
      return;
    }

    // Add client only after the watcher has started successfully.
    if (!this.clients.has(worktreePath)) {
      this.clients.set(worktreePath, new Set());
    }
    this.clients.get(worktreePath)!.add(ws);

    // Handle client disconnect
    const disconnect = () => {
      const clients = this.clients.get(worktreePath);
      if (clients) {
        clients.delete(ws);
        // Unwatch worktree when last client disconnects
        if (clients.size === 0) {
          this.clients.delete(worktreePath);
          const batch = this.pending.get(worktreePath);
          if (batch) clearTimeout(batch.timer);
          this.pending.delete(worktreePath);
          this.fileWatcher.unwatchWorktree(worktreePath);
        }
      }
    };
    ws.on('close', disconnect);

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error(`WebSocket error for worktree ${worktreePath}:`, error);
      disconnect();
    });
  }

  /**
   * Broadcast a file change event to all clients watching a specific worktree.
   *
   * @param worktreePath - The worktree path to broadcast to
   * @param event - The file change event from FileWatcherService
   */
  broadcast(worktreePath: string, event: FileChangeEvent): void {
    if (!this.clients.has(worktreePath)) return;
    if (event.event !== 'git')
      this.files?.markEditorWorkspaceChanged(worktreePath);
    let batch = this.pending.get(worktreePath);
    if (!batch) {
      batch = {
        events: new Map(),
        resync: false,
        timer: setTimeout(() => this.flush(worktreePath), 50),
      };
      this.pending.set(worktreePath, batch);
    }
    if (batch.resync) return;
    if (event.event === 'resync') {
      batch.resync = true;
      batch.events.clear();
      return;
    }
    if (batch.events.size >= 512 && !batch.events.has(event.path)) {
      batch.events.clear();
      batch.resync = true;
    } else {
      const previous = batch.events.get(event.path);
      batch.events.set(
        event.path,
        previous?.event === 'add' && event.event === 'change'
          ? previous
          : event,
      );
    }
  }

  private flush(worktreePath: string): void {
    const batch = this.pending.get(worktreePath);
    this.pending.delete(worktreePath);
    if (!batch) return;
    const message = JSON.stringify(
      batch.resync
        ? [{ type: 'resync', worktreePath }]
        : [...batch.events.values()].map((event) => ({
            type: 'file-change',
            ...event,
          })),
    );
    for (const ws of this.clients.get(worktreePath) ?? [])
      if (ws.readyState === WebSocket.OPEN) sendBounded(ws, message);
  }

  /**
   * Lifecycle hook called when the module is destroyed.
   * Closes all WebSocket connections and the server cleanly.
   */
  onModuleDestroy(): void {
    for (const batch of this.pending.values()) clearTimeout(batch.timer);
    this.pending.clear();
    // Close all WebSocket connections
    for (const [worktreePath, clients] of this.clients) {
      void this.fileWatcher.unwatchWorktree(worktreePath);
      for (const ws of clients) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
    this.wss?.close();
  }
}
