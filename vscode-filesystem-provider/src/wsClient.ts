import {
  Uri,
  FileChangeType,
  FileChangeEvent,
  EventEmitter,
  Event as VsCodeEvent,
  Disposable
} from 'vscode';

type BrowserLocationLike = {
  protocol?: string;
  host?: string;
};

type BrowserWebSocketCtor = new (url: string) => WebSocket;

function getBrowserLocation(): BrowserLocationLike | undefined {
  return (globalThis as typeof globalThis & { location?: BrowserLocationLike }).location;
}

function getWebSocketCtor(): BrowserWebSocketCtor {
  return (globalThis as typeof globalThis & { WebSocket: BrowserWebSocketCtor }).WebSocket;
}

function toWorkspaceUri(worktreePath: string, relativePath: string): Uri {
  const normalizedRoot = worktreePath.replace(/\/$/, '');
  const normalizedPath = relativePath.replace(/^\/+/, '');
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(normalizedRoot),
    path: normalizedPath ? `/${normalizedPath}` : '/',
  });
}

/**
 * BackendFileChangeEvent - File change event from backend FileChangeGateway
 *
 * Phase 08 (FileChangeGateway) broadcasts events via WebSocket:
 * Endpoint: ws://localhost:3001/ws/file-changes/:worktreeId
 * Event format: { type: 'add'|'change'|'unlink', path: string, worktreeId: string }
 */
interface BackendFileChangeEvent {
  type?: 'add' | 'change' | 'unlink' | 'file-change';
  event?: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  worktreePath: string;
}

function mapBackendEventType(
  backendEvent: BackendFileChangeEvent,
): FileChangeType {
  const eventType = backendEvent.type === 'file-change' ? backendEvent.event : backendEvent.type;

  switch (eventType) {
    case 'add':
      return FileChangeType.Created;
    case 'change':
      return FileChangeType.Changed;
    case 'unlink':
      return FileChangeType.Deleted;
    case 'addDir':
      return FileChangeType.Created;
    case 'unlinkDir':
      return FileChangeType.Deleted;
    default:
      console.warn(`Unknown backend event type: ${backendEvent.type}`, backendEvent);
      return FileChangeType.Changed;
  }
}

/**
 * WebSocketClient - WebSocket connection manager for FileChangeGateway
 *
 * Connects to Phase 08 backend WebSocket endpoint for real-time file sync.
 * Maps backend file change events to VS Code FileChangeEvent format.
 *
 * Flow:
 * 1. Extension activates → WebSocketClient.connect()
 * 2. Backend file changes → WebSocket message
 * 3. handleMessage() → Map to VS Code FileChangeEvent
 * 4. Fire fileChangeEmitter → FileSystemProvider._onDidChangeFile
 * 5. VS Code invalidates cache → Refetch file
 *
 * Reconnection:
 * - Auto-reconnect on WebSocket close with exponential backoff
 * - Max 5 attempts: 1s → 2s → 4s → 8s → 16s
 *
 * Browser-compatible:
 * - Uses native WebSocket API (no Node.js net module)
 * - Works in VS Code Web (WebWorker environment)
 */
export class WebSocketClient implements Disposable {
  private worktreePath: string;
  private baseUrl: string;
  private ws: WebSocket | null = null;

  /**
   * EventEmitter for file change notifications
   *
   * Fires when backend sends file change events via WebSocket
   */
  private fileChangeEmitter = new EventEmitter<FileChangeEvent[]>();

  /**
   * Public event for FileSystemProvider to subscribe
   *
   * FileSystemProvider wires this to its _onDidChangeFile emitter
   */
  onDidChangeFile: VsCodeEvent<FileChangeEvent[]> = this.fileChangeEmitter.event;

  /**
   * Reconnection tracking
   */
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private baseReconnectDelay = 1000; // 1 second
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Create WebSocketClient instance
   *
   * @param worktreeId - Worktree identifier (matches backend subscription)
   * @param baseUrl - WebSocket base URL (default: ws://localhost:3001)
   *                   Note: Backend uses /ws/file-changes/:worktreeId path
   */
  constructor(worktreePath: string, baseUrl: string = (() => {
    const browserLocation = getBrowserLocation();
    const protocol = browserLocation?.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = browserLocation?.host ?? 'localhost:3000';
    return `${protocol}//${host}`;
  })()) {
    this.worktreePath = worktreePath;
    this.baseUrl = baseUrl;
  }

  /**
   * Connect to backend FileChangeGateway WebSocket
   *
   * URL format: ${baseUrl}/ws/file-changes/${worktreeId}
   *
   * Sets up message handler for file change events
   * Auto-reconnects on close with exponential backoff
   */
  connect(): void {
    // Build WebSocket URL
    const url = `${this.baseUrl}/file-changes?worktreePath=${encodeURIComponent(this.worktreePath)}`;

    console.log(`WebSocketClient connecting to: ${url}`);

    try {
      // Create WebSocket connection
      const WebSocketCtor = getWebSocketCtor();
      this.ws = new WebSocketCtor(url);

      // Handle incoming messages (file change events)
      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      // Handle WebSocket errors
      this.ws.onerror = (error: Event) => {
        console.error('WebSocket error:', error);
      };

      // Handle WebSocket close (trigger reconnection)
      this.ws.onclose = () => {
        this.handleClose();
      };

      // Handle WebSocket open (connection established)
      this.ws.onopen = () => {
        this.reconnectAttempts = 0; // Reset on successful connection
        console.log('WebSocket connected successfully');
      };
    } catch (error) {
      console.error('WebSocket connection failed:', error);
      // Trigger reconnection attempt
      this.handleClose();
    }
  }

  /**
   * Handle incoming WebSocket message
   *
   * Parses backend FileChangeEvent and maps to VS Code format:
   * - Backend 'add' → FileChangeType.Added (1)
   * - Backend 'change' → FileChangeType.Updated (0)
   * - Backend 'unlink' → FileChangeType.Deleted (2)
   *
   * Fires fileChangeEmitter for FileSystemProvider to handle
   *
   * @param event - WebSocket MessageEvent with JSON data
   */
  private handleMessage(event: MessageEvent): void {
    try {
      // Parse backend event data
      // Backend sends array of BackendFileChangeEvent
      const payload = JSON.parse(event.data);
      const backendEvents: BackendFileChangeEvent[] = Array.isArray(payload) ? payload : [payload];

      // Map each backend event to VS Code FileChangeEvent
      const vsCodeEvents: FileChangeEvent[] = backendEvents.map(backendEvent => {
        // Build VS Code URI for the changed file
        const uri = toWorkspaceUri(backendEvent.worktreePath, backendEvent.path);

        return { type: mapBackendEventType(backendEvent), uri };
      });

      // Fire emitter to notify FileSystemProvider
      if (vsCodeEvents.length > 0) {
        this.fileChangeEmitter.fire(vsCodeEvents);
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  /**
   * Handle WebSocket close
   *
   * Auto-reconnect with exponential backoff:
   * - Attempt 1: 1s delay
   * - Attempt 2: 2s delay
   * - Attempt 3: 4s delay
   * - Attempt 4: 8s delay
   * - Attempt 5: 16s delay
   * - After 5: Stop, log error
   */
  private handleClose(): void {
    // Clear existing WebSocket reference
    this.ws = null;

    // Check reconnection limit
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      // Calculate exponential backoff delay
      const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts);

      console.log(`WebSocket closed. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

      // Schedule reconnection
      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);

      this.reconnectAttempts++;
    } else {
      console.error('WebSocket max reconnection attempts reached. File sync disabled.');
    }
  }

  /**
   * Disconnect WebSocket and cleanup
   *
   * Called when extension deactivates or worktree changes
   */
  disconnect(): void {
    // Clear any pending reconnection
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Reset reconnection attempts
    this.reconnectAttempts = 0;

    // Close WebSocket if connected
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log('WebSocket disconnected');
  }

  /**
   * Check if WebSocket is connected
   *
   * @returns true if WebSocket is open and ready
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Dispose WebSocket client resources
   *
   * Implements Disposable interface for cleanup
   */
  dispose(): void {
    this.disconnect();
    this.fileChangeEmitter.dispose();
  }
}
