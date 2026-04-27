import { Uri, FileType, FileSystemError } from 'vscode';
import { BackendFileStat, BackendDirectoryEntry, BackendWriteRequest } from './types';

type BrowserLocationLike = {
  origin?: string;
};

function getBrowserLocation(): BrowserLocationLike | undefined {
  return (globalThis as typeof globalThis & { location?: BrowserLocationLike }).location;
}

function toWorkspaceUri(worktreePath: string, path: string): Uri {
  const normalizedRoot = worktreePath.replace(/\/$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(normalizedRoot),
    path: normalizedPath ? `/${normalizedPath}` : '/',
  });
}

/**
 * BackendClient - REST API client for NestJS file operations
 * 
 * Connects to Phase 08 backend endpoints:
 * - GET /api/files/:worktreeId/stat?path=... → BackendFileStat
 * - GET /api/files/:worktreeId/read?path=... → ArrayBuffer
 * - GET /api/files/:worktreeId/list?path=... → BackendDirectoryEntry[]
 * - POST /api/files/:worktreeId/write → { path, content }
 * 
 * Uses native fetch() API (browser-compatible, no Node.js http module)
 * 
 * Error mapping:
 * - 404 → FileSystemError.FileNotFound
 * - 403 → FileSystemError.NoPermissions
 * - 500 → FileSystemError.Unavailable
 */
export class BackendClient {
  private baseUrl: string;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  /**
   * Create BackendClient instance
   * 
   * @param baseUrl - Backend API base URL (default: http://localhost:3001/api/files)
   *                   Production: configurable via extension settings
   */
  constructor(baseUrl: string = `${getBrowserLocation()?.origin ?? 'http://localhost:3000'}/api/worktrees`) {
    this.baseUrl = baseUrl;
  }

  /**
   * Build URL for backend endpoint with query parameters
   * 
   * @param worktreeId - Worktree identifier
   * @param path - File/directory path relative to worktree root
   * @param endpoint - Endpoint name (stat, read, list, write)
   * @returns Full URL with encoded query params
   */
  private buildUrl(worktreePath: string, path: string, endpoint: 'stat' | 'files'): string {
    const encodedWorktreePath = encodeURIComponent(worktreePath);
    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/');

    const suffix = encodedPath ? `/${encodedPath}` : '';
    return `${this.baseUrl}/${encodedWorktreePath}/${endpoint}${suffix}`;
  }

  private buildQueryUrl(worktreePath: string, endpoint: 'stat' | 'file', path: string): string {
    const encodedWorktreePath = encodeURIComponent(worktreePath);
    const params = new URLSearchParams();
    if (path) {
      params.set('path', path);
    }
    const query = params.toString();
    return `${this.baseUrl}/${encodedWorktreePath}/${endpoint}${query ? `?${query}` : ''}`;
  }

  private buildMutationUrl(
    worktreePath: string,
    endpoint: 'directories' | 'files',
    path: string,
    params?: Record<string, string>,
  ): string {
    const encodedWorktreePath = encodeURIComponent(worktreePath);
    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/');
    const query = params ? new URLSearchParams(params).toString() : '';

    return `${this.baseUrl}/${encodedWorktreePath}/${endpoint}/${encodedPath}${query ? `?${query}` : ''}`;
  }

  private assertSafePath(worktreePath: string, path: string): Uri {
    const uri = toWorkspaceUri(worktreePath, path);

    if (path.includes('..')) {
      throw FileSystemError.NoPermissions(uri);
    }

    return uri;
  }

  /**
   * Map HTTP status codes to VS Code FileSystemError
   * 
   * VS Code UI displays FileSystemError appropriately:
   * - FileNotFound: Shows "File not found" dialog
   * - NoPermissions: Shows permission denied message
   * - Unavailable: Shows connection error
   * 
   * @param status - HTTP response status code
   * @param uri - VS Code URI for error context
   * @returns FileSystemError instance
   */
  private mapHttpError(status: number, uri: Uri): FileSystemError {
    if (status === 404) {
      return FileSystemError.FileNotFound(uri);
    }
    if (status === 403) {
      return FileSystemError.NoPermissions(uri);
    }
    // All other errors (500, network failures) → Unavailable
    return FileSystemError.Unavailable(uri);
  }

  /**
   * Get file/directory metadata
   * 
   * Backend endpoint: GET /api/files/:worktreeId/stat?path=...
   * 
   * @param worktreeId - Worktree identifier
   * @param path - File/directory path
   * @returns FileStat with type, ctime, mtime, size
   * @throws FileSystemError if backend returns error
   */
  async stat(worktreePath: string, path: string): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
    const url = this.buildQueryUrl(worktreePath, 'stat', path);
    const uri = toWorkspaceUri(worktreePath, path);

    const response = await fetch(url);

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }

    const data = await response.json() as BackendFileStat;

    // Map backend type string to VS Code FileType enum
    const type = data.type === 'file' ? FileType.File : FileType.Directory;

    return {
      type,
      ctime: data.ctime,
      mtime: data.mtime,
      size: data.size
    };
  }

  /**
   * Read file content as Uint8Array
   * 
   * Backend endpoint: GET /api/files/:worktreeId/read?path=...
   * Response: ArrayBuffer (binary file content)
   * 
   * @param worktreeId - Worktree identifier
   * @param path - File path
   * @returns Uint8Array with file content
   * @throws FileSystemError if backend returns error
   */
  async readFile(worktreePath: string, path: string): Promise<Uint8Array> {
    const url = this.buildQueryUrl(worktreePath, 'file', path);
    const uri = toWorkspaceUri(worktreePath, path);

    const response = await fetch(url);

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }

    const data = await response.json() as { content: string };
    return this.encoder.encode(data.content);
  }

  /**
   * List directory contents
   * 
   * Backend endpoint: GET /api/files/:worktreeId/list?path=...
   * Response: BackendDirectoryEntry[] (array of {name, type})
   * 
   * @param worktreeId - Worktree identifier
   * @param path - Directory path
   * @returns Array of [name, FileType] tuples
   * @throws FileSystemError if backend returns error
   */
  async readDirectory(worktreePath: string, path: string): Promise<[string, FileType][]> {
    const encodedWorktreePath = encodeURIComponent(worktreePath);
    const url = `${this.baseUrl}/${encodedWorktreePath}/files${path ? `?dir=${encodeURIComponent(path)}` : ''}`;
    const uri = toWorkspaceUri(worktreePath, path);

    const response = await fetch(url);

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }

    const data = await response.json() as Array<{
      label: string;
      data: { type: 'file' | 'directory' };
    }>;

    // Map backend entries to [name, FileType] tuples
    return data.map(entry => [
      entry.label,
      entry.data.type === 'file' ? FileType.File : FileType.Directory
    ]);
  }

  /**
   * Write file content to backend
   * 
   * Backend endpoint: POST /api/files/:worktreeId/write
   * Request body: { path, content: number[] }
   * 
   * Security:
   * - Extension-side path traversal check (prevents '..')
   * - Backend also validates (Phase 08 FILESYSTEM-07)
   * - Extension-side check prevents unnecessary network call
   * 
   * Note: Uint8Array serialized to number array for JSON transport
   * 
   * @param worktreeId - Worktree identifier
   * @param path - File path
   * @param content - File content as Uint8Array
   * @throws FileSystemError.NoPermissions if path contains '..' (path traversal)
   * @throws FileSystemError if backend returns error
   */
  async writeFile(worktreePath: string, path: string, content: Uint8Array): Promise<void> {
    const url = this.buildQueryUrl(worktreePath, 'file', path);
    const uri = this.assertSafePath(worktreePath, path);

    const payload: BackendWriteRequest = {
      content: this.decoder.decode(content)
    };

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }
  }

  async createDirectory(worktreePath: string, path: string): Promise<void> {
    const uri = this.assertSafePath(worktreePath, path);
    const url = this.buildMutationUrl(worktreePath, 'directories', path);
    const response = await fetch(url, { method: 'POST' });

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }
  }

  async rename(
    worktreePath: string,
    oldPath: string,
    newPath: string,
    overwrite: boolean,
  ): Promise<void> {
    const uri = this.assertSafePath(worktreePath, oldPath);
    this.assertSafePath(worktreePath, newPath);
    const url = this.buildMutationUrl(worktreePath, 'files', oldPath);
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ newPath, overwrite })
    });

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }
  }

  async deleteEntry(worktreePath: string, path: string, recursive: boolean): Promise<void> {
    const uri = this.assertSafePath(worktreePath, path);
    const url = this.buildMutationUrl(worktreePath, 'files', path, {
      recursive: recursive ? 'true' : 'false'
    });
    const response = await fetch(url, { method: 'DELETE' });

    if (!response.ok) {
      throw this.mapHttpError(response.status, uri);
    }
  }
}
