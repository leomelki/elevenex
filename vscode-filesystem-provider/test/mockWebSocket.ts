import { FileChangeType, Uri } from 'vscode';

/**
 * BackendFileChangeEvent - File change event from backend
 *
 * Matches backend FileChangeGateway event format:
 * { type: 'add'|'change'|'unlink', path: string, worktreeId: string }
 */
export interface BackendFileChangeEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  worktreeId: string;
}

/**
 * MockWebSocket - Mock WebSocket client for isolated testing
 *
 * Simulates WebSocket connection to backend FileChangeGateway
 * Allows tests to trigger file change events without real WebSocket
 *
 * Usage in tests:
 * const mockWs = new MockWebSocket('test-worktree');
 * mockWs.connect();
 * mockWs.simulateFileChange({ type: 'change', path: 'test.txt', worktreeId: 'test-worktree' });
 *
 * Tests run without WebSocket server - fully isolated
 */
export class MockWebSocket {
  /**
   * Worktree identifier for WebSocket subscription
   */
  private worktreeId: string;

  /**
   * Message queue for simulated file change events
   */
  private messageQueue: BackendFileChangeEvent[] = [];

  /**
   * Message callback (called when message received)
   * Matches WebSocket.onmessage signature
   */
  private onMessageCallback: ((event: MessageEvent) => void) | null = null;

  /**
   * Connection state (true if connected)
   */
  private connected = false;

  /**
   * Create MockWebSocket instance
   *
   * @param worktreeId - Worktree identifier for subscription
   */
  constructor(worktreeId: string) {
    this.worktreeId = worktreeId;
  }

  /**
   * Simulate WebSocket connection
   *
   * Sets connected state to true
   * In real WebSocket, this opens connection to ws://localhost:3001/ws/file-changes/:worktreeId
   */
  connect(): void {
    this.connected = true;
    console.log(`MockWebSocket connected to worktree: ${this.worktreeId}`);
  }

  /**
   * Simulate WebSocket disconnection
   *
   * Sets connected state to false, clears message callback
   */
  disconnect(): void {
    this.connected = false;
    this.onMessageCallback = null;
    console.log('MockWebSocket disconnected');
  }

  /**
   * Check if WebSocket is connected
   *
   * @returns true if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Set message callback (matches WebSocket.onmessage)
   *
   * WebSocketClient sets this callback to handle file change events
   *
   * @param callback - Message event handler
   */
  setOnMessage(callback: (event: MessageEvent) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Simulate file change event from backend
   *
   * Triggers onMessageCallback with BackendFileChangeEvent array
   * Matches backend FileChangeGateway broadcast format
   *
   * @param event - File change event (add/change/unlink)
   */
  simulateFileChange(event: BackendFileChangeEvent): void {
    // Add to message queue
    this.messageQueue.push(event);

    // Trigger callback if set
    if (this.onMessageCallback && this.connected) {
      // Backend sends array of events
      const messageData = JSON.stringify([event]);
      const messageEvent = { data: messageData } as MessageEvent;

      this.onMessageCallback(messageEvent);
    }
  }

  /**
   * Simulate multiple file change events
   *
   * Useful for testing batch file changes
   *
   * @param events - Array of file change events
   */
  simulateFileChanges(events: BackendFileChangeEvent[]): void {
    events.forEach(event => this.messageQueue.push(event));

    if (this.onMessageCallback && this.connected) {
      const messageData = JSON.stringify(events);
      const messageEvent = { data: messageData } as MessageEvent;

      this.onMessageCallback(messageEvent);
    }
  }

  /**
   * Clear message queue
   *
   * Useful for test cleanup
   */
  clearQueue(): void {
    this.messageQueue = [];
  }

  /**
   * Get pending messages
   *
   * Useful for verifying events were queued
   *
   * @returns Array of pending events
   */
  getPendingMessages(): BackendFileChangeEvent[] {
    return this.messageQueue;
  }

  /**
   * Get worktree ID
   *
   * @returns Worktree identifier
   */
  getWorktreeId(): string {
    return this.worktreeId;
  }

  /**
   * Simulate connection error
   *
   * Useful for testing error handling
   */
  simulateError(): void {
    if (this.onMessageCallback) {
      // Trigger error callback (WebSocket.onerror pattern)
      console.error('MockWebSocket connection error simulated');
    }
  }

  /**
   * Simulate connection close
   *
   * Useful for testing reconnection logic
   */
  simulateClose(): void {
    this.connected = false;
    console.log('MockWebSocket connection closed (simulated)');
  }

  /**
   * Create VS Code FileChangeEvent from backend event
   *
   * Helper for tests to verify event mapping
   *
   * @param backendEvent - Backend file change event
   * @returns VS Code FileChangeEvent
   */
static mapToVSCodeEvent(backendEvent: BackendFileChangeEvent): { type: FileChangeType; uri: Uri } {
     // Map backend type to VS Code FileChangeType
     let type: FileChangeType;
     switch (backendEvent.type) {
       case 'add':
         type = FileChangeType.Created; // 1
         break;
       case 'change':
         type = FileChangeType.Changed; // 0
         break;
       case 'unlink':
         type = FileChangeType.Deleted; // 2
         break;
       default:
         type = FileChangeType.Changed; // Default fallback
     }

    // Build VS Code URI
    const uri = Uri.parse(`workspace-vfs://${backendEvent.worktreeId}/${backendEvent.path}`);

    return { type, uri };
  }
}