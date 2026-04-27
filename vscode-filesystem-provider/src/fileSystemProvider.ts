import {
  Uri,
  FileType,
  FileStat,
  FileSystemError,
  FileSystemProvider,
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileChangeType
} from 'vscode';
import { BackendClient } from './backendClient';
import { WebSocketClient } from './wsClient';
import { parseUri, isValidWorkspaceVfsUri } from './uriParser';

/**
 * WorkspaceVfsProvider - FileSystemProvider implementation for VS Code Web
 * 
 * Implements VS Code FileSystemProvider interface to provide virtual file system
 * backed by NestJS backend REST API.
 * 
 * URI scheme: workspace-vfs://worktreeId/path
 * - workspace-vfs: Custom scheme registered with VS Code
 * - worktreeId: Authority component (worktree identifier)
 * - path: File/directory path relative to worktree root
 * 
 * Read operations (Plan 01):
 * - stat() → BackendClient.stat()
 * - readFile() → BackendClient.readFile()
 * - readDirectory() → BackendClient.readDirectory()
 * 
 * Write operations (Plan 01):
 * - writeFile() → BackendClient.writeFile()
 * 
 * Real-time sync (Plan 02):
 * - watch() stub (returns Disposable, actual watching via WebSocket)
 * - onDidChangeFile EventEmitter (fires when backend file changes)
 * 
 * Security:
 * - URI scheme validation (workspace-vfs only)
 * - Backend validates path traversal (Phase 08 FILESYSTEM-07)
 */
export class WorkspaceVfsProvider implements FileSystemProvider {
  private backendClient: BackendClient;
  private worktreeId: string;
  private wsClient: WebSocketClient | null = null;

  /**
   * EventEmitter for file change notifications
   * 
   * Plan 02: WebSocket client will fire events from backend FileChangeGateway
   * Format: FileChangeEvent[] with type (Updated/Added/Deleted) and uri
   */
  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();

  /**
   * Public event for VS Code to subscribe to file changes
   * 
   * VS Code invalidates cache and refetches when this event fires
   */
  onDidChangeFile: Event<FileChangeEvent[]> = this._onDidChangeFile.event;

  private emitChanges(changes: FileChangeEvent[]): void {
    this._onDidChangeFile.fire(changes);
  }

  /**
   * Create WorkspaceVfsProvider instance
   * 
   * @param backendClient - Backend REST API client
   * @param worktreeId - Worktree identifier (from extension context)
   * @param wsClient - WebSocket client for real-time file sync (optional for Plan 02)
   */
  constructor(backendClient: BackendClient, worktreeId: string, wsClient?: WebSocketClient) {
    this.backendClient = backendClient;
    this.worktreeId = worktreeId;
    this.wsClient = wsClient ?? null;

    // Wire WebSocket client onDidChangeFile to provider's _onDidChangeFile
    // Backend file changes → WebSocket → provider emitter → VS Code cache invalidation
    if (this.wsClient) {
      this.wsClient.onDidChangeFile((changes: FileChangeEvent[]) => {
        this._onDidChangeFile.fire(changes);
      });
    }
  }

  /**
   * Get file/directory metadata
   * 
   * FileSystemProvider interface method
   * Called by VS Code when:
   * - Opening file in editor
   * - Expanding directory in Explorer
   * - Checking file existence
   * 
   * @param uri - VS Code URI with workspace-vfs scheme
   * @returns FileStat with type, ctime, mtime, size
   * @throws FileSystemError if URI invalid or backend error
   */
  async stat(uri: Uri): Promise<FileStat> {
    // Validate URI scheme
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    try {
      // Parse URI to extract worktreeId and path
      const { worktreeId, path } = parseUri(uri, this.worktreeId);

      // Call backend stat endpoint
      const stat = await this.backendClient.stat(worktreeId, path);

      return stat;
    } catch (error) {
      // Backend errors already mapped to FileSystemError
      throw error;
    }
  }

  /**
   * Read file content
   * 
   * FileSystemProvider interface method
   * Called by VS Code when:
   * - Opening file in editor (text files)
   * - Loading binary files (images, etc.)
   * 
   * @param uri - VS Code URI with workspace-vfs scheme
   * @returns Uint8Array with file content
   * @throws FileSystemError if URI invalid or backend error
   */
  async readFile(uri: Uri): Promise<Uint8Array> {
    // Validate URI scheme
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    try {
      // Parse URI to extract worktreeId and path
      const { worktreeId, path } = parseUri(uri, this.worktreeId);

      // Call backend read endpoint
      const content = await this.backendClient.readFile(worktreeId, path);

      return content;
    } catch (error) {
      // Backend errors already mapped to FileSystemError
      throw error;
    }
  }

  /**
   * List directory contents
   * 
   * FileSystemProvider interface method
   * Called by VS Code when:
   * - Expanding directory in Explorer
   * - Refreshing file tree
   * 
   * @param uri - VS Code URI with workspace-vfs scheme
   * @returns Array of [name, FileType] tuples
   * @throws FileSystemError if URI invalid or backend error
   */
  async readDirectory(uri: Uri): Promise<[string, FileType][]> {
    // Validate URI scheme
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    try {
      // Parse URI to extract worktreeId and path
      const { worktreeId, path } = parseUri(uri, this.worktreeId);

      // Call backend list endpoint
      const entries = await this.backendClient.readDirectory(worktreeId, path);

      return entries;
    } catch (error) {
      // Backend errors already mapped to FileSystemError
      throw error;
    }
  }

  /**
   * Write file content
   * 
   * FileSystemProvider interface method (optional, implemented for write support)
   * Called by VS Code when:
   * - Saving file in editor
   * - Creating new file
   * 
   * Option handling per VS Code FileSystemProvider contract:
   * - create=false, overwrite=false: Check file exists first
   *   - If exists: throw FileExists (can't overwrite)
   *   - If missing: throw FileNotFound (can't create)
   * - create=true, overwrite=false: Create new file, fail if exists
   *   - If exists: throw FileExists
   *   - If missing: proceed with write
   * - create=false, overwrite=true: Overwrite existing file, fail if missing
   *   - If missing: throw FileNotFound
   *   - If exists: proceed with write
   * - create=true, overwrite=true: Create or overwrite (always succeeds)
   * 
   * @param uri - VS Code URI with workspace-vfs scheme
   * @param content - File content as Uint8Array
   * @param options - Write options (create, overwrite)
   * @throws FileSystemError.FileExists if file exists and can't overwrite
   * @throws FileSystemError.FileNotFound if file missing and can't create
   * @throws FileSystemError.NoPermissions if URI invalid or backend 403
   */
  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    // Validate URI scheme
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    try {
      // Parse URI to extract worktreeId and path
      const { worktreeId, path } = parseUri(uri, this.worktreeId);

      // Handle create/overwrite options per VS Code FileSystemProvider contract
      // Check file existence when options require it
      if (!options.create || !options.overwrite) {
        try {
          // Check if file exists by calling stat()
          await this.backendClient.stat(worktreeId, path);
          // File exists
          
          // If create=true and overwrite=false: can't overwrite existing file
          if (options.create && !options.overwrite) {
            throw FileSystemError.FileExists(uri);
          }
          
          // If create=false and overwrite=false: can't overwrite existing file
          if (!options.create && !options.overwrite) {
            throw FileSystemError.FileExists(uri);
          }
          
          // create=false, overwrite=true: proceed (overwrite existing)
          // create=true, overwrite=true: proceed (overwrite existing)
        } catch (error) {
          // File doesn't exist (stat threw FileNotFound)
          // Check error code directly (more reliable than instanceof check)
          // FileSystemError.FileNotFound can have code 'FileNotFound' or 'EntryNotFound' depending on VS Code version
          if (error && typeof error === 'object' && 'code' in error && 
              ((error as any).code === 'EntryNotFound' || (error as any).code === 'FileNotFound')) {
            // If create=false: can't create new file
            if (!options.create) {
              throw FileSystemError.FileNotFound(uri);
            }
            // create=true: proceed (create new file)
          } else {
            // Other error (permission, unavailable) - throw it
            throw error;
          }
        }
      }

      // Call backend write endpoint
      await this.backendClient.writeFile(worktreeId, path, content);

      // Fire change event so VS Code knows file was updated
      // Use FileChangeType.Changed for file modifications
      this.emitChanges([
        {
          type: FileChangeType.Changed,
          uri
        }
      ]);
    } catch (error) {
      // Backend errors already mapped to FileSystemError
      throw error;
    }
  }

  /**
   * Watch file/directory for changes
   * 
   * FileSystemProvider interface method
   * 
   * Plan 02: WebSocket integration with FileChangeGateway
   * - WebSocket client subscribes to ws://localhost:3001/ws/file-changes/:worktreeId
   * - Receives real-time file change events from backend
   * - Fires onDidChangeFile event for VS Code to refetch
   * 
   * Note: watch() returns Disposable per API contract, but actual file watching
   * is handled by WebSocket client in constructor (wsClient.onDidChangeFile wired)
   * 
   * @param uri - VS Code URI to watch
   * @param options - Watch options (recursive, excludes)
   * @returns Disposable for cleanup
   */
  watch(
    uri: Uri,
    options: { recursive: boolean; excludes: string[] }
  ): Disposable {
    // WebSocket client handles actual watching
    // This just returns Disposable per VS Code FileSystemProvider contract
    return new Disposable(() => {
      // Cleanup if needed (WebSocket cleanup handled in dispose())
    });
  }

  /**
   * Create directory
   * 
   * FileSystemProvider interface method
   * 
   * Note: Backend does not currently support directory creation via API.
   * This is a stub implementation for API completeness.
   * 
   * @param uri - VS Code URI for directory to create
   * @throws FileSystemError.NoPermissions (directory creation not supported)
   */
  async createDirectory(uri: Uri): Promise<void> {
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    const { worktreeId, path } = parseUri(uri, this.worktreeId);
    await this.backendClient.createDirectory(worktreeId, path);
    this.emitChanges([{ type: FileChangeType.Created, uri }]);
  }

  /**
   * Delete file/directory
   * 
   * FileSystemProvider interface method
   * 
   * Note: Backend does not currently support file deletion via API.
   * This is a stub implementation for API completeness.
   * 
   * @param uri - VS Code URI for file/directory to delete
   * @param options - Delete options (recursive for directories)
   * @throws FileSystemError.NoPermissions (deletion not supported)
   */
  async delete(uri: Uri, options: { recursive: boolean }): Promise<void> {
    if (!isValidWorkspaceVfsUri(uri)) {
      throw FileSystemError.NoPermissions(uri);
    }

    const { worktreeId, path } = parseUri(uri, this.worktreeId);
    await this.backendClient.deleteEntry(worktreeId, path, options.recursive);
    this.emitChanges([{ type: FileChangeType.Deleted, uri }]);
  }

  /**
   * Rename file/directory
   * 
   * FileSystemProvider interface method
   * 
   * Note: Backend does not currently support file renaming via API.
   * This is a stub implementation for API completeness.
   * 
   * @param oldUri - Current VS Code URI
   * @param newUri - New VS Code URI
   * @param options - Rename options (overwrite existing file)
   * @throws FileSystemError.NoPermissions (renaming not supported)
   */
  async rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): Promise<void> {
    if (!isValidWorkspaceVfsUri(oldUri) || !isValidWorkspaceVfsUri(newUri)) {
      throw FileSystemError.NoPermissions(oldUri);
    }

    const { worktreeId: oldWorktreeId, path: oldPath } = parseUri(oldUri, this.worktreeId);
    const { worktreeId: newWorktreeId, path: newPath } = parseUri(newUri, this.worktreeId);

    if (oldWorktreeId !== newWorktreeId) {
      throw FileSystemError.NoPermissions(oldUri);
    }

    await this.backendClient.rename(oldWorktreeId, oldPath, newPath, options.overwrite);
    this.emitChanges([
      { type: FileChangeType.Deleted, uri: oldUri },
      { type: FileChangeType.Created, uri: newUri }
    ]);
  }

  /**
   * Fire file change event
   * 
   * Used by WebSocket client (Plan 02) to notify VS Code of backend changes
   * 
   * @param changes - Array of file change events
   */
  fireFileChange(changes: FileChangeEvent[]): void {
    this.emitChanges(changes);
  }

  /**
   * Dispose provider resources
   * 
   * Called by VS Code when extension deactivates
   */
  dispose(): void {
    // Dispose WebSocket client (disconnects and cleans up)
    if (this.wsClient) {
      this.wsClient.dispose();
    }
    // Dispose EventEmitter
    this._onDidChangeFile.dispose();
  }
}
