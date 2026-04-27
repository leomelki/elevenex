import { FileType, FileSystemError, Uri } from 'vscode';

/**
 * MockBackend - Mock backend client for isolated testing
 *
 * Simulates NestJS backend file operations without requiring real server:
 * - Stores files in memory Map
 * - Provides stat, readFile, readDirectory, writeFile methods
 * - Returns 404 for missing files (simulated HTTP error)
 *
 * Usage in tests:
 * const mockBackend = new MockBackend();
 * mockBackend.seedSampleFiles();
 * const provider = new WorkspaceVfsProvider(mockBackend);
 *
 * Tests run without backend dependencies - fully isolated
 */
export class MockBackend {
  /**
   * In-memory file storage
   * Key format: `${worktreeId}/${path}`
   */
  private files = new Map<string, { content: Uint8Array; stat: { type: FileType; ctime: number; mtime: number; size: number } }>();

  /**
   * In-memory directory storage
   * Key format: `${worktreeId}/${path}`
   * Value: Array of [name, FileType] tuples
   */
  private directories = new Map<string, [string, FileType][]>();

  /**
   * Constructor - seed with sample files
   */
  constructor() {
    this.seedSampleFiles();
  }

  /**
   * Seed sample files for testing
   *
   * Creates basic file structure:
   * - test.txt (file with content)
   * - subdir/ (directory)
   * - subdir/nested.txt (nested file)
   */
  seedSampleFiles(): void {
    const worktreeId = 'test-worktree';

    // Root directory
    this.directories.set(`${worktreeId}/`, [
      ['test.txt', FileType.File],
      ['subdir', FileType.Directory]
    ]);

    // test.txt file
    this.files.set(`${worktreeId}/test.txt`, {
      content: new TextEncoder().encode('test content'),
      stat: {
        type: FileType.File,
        ctime: Date.now() - 1000,
        mtime: Date.now(),
        size: 12
      }
    });

    // subdir directory
    this.directories.set(`${worktreeId}/subdir`, [
      ['nested.txt', FileType.File]
    ]);

    // nested.txt file
    this.files.set(`${worktreeId}/subdir/nested.txt`, {
      content: new TextEncoder().encode('nested content'),
      stat: {
        type: FileType.File,
        ctime: Date.now() - 2000,
        mtime: Date.now(),
        size: 14
      }
    });
  }

  /**
   * Get file/directory metadata
   *
   * Simulates backend GET /api/files/:worktreeId/stat?path=...
   *
   * @param worktreeId - Worktree identifier
   * @param path - File/directory path
   * @returns FileStat with type, ctime, mtime, size
   * @throws FileSystemError.FileNotFound if file doesn't exist
   */
  async stat(worktreeId: string, path: string): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
    const key = `${worktreeId}/${path}`;

    // Check if file exists
    if (this.files.has(key)) {
      return this.files.get(key)!.stat;
    }

    // Check if directory exists
    if (this.directories.has(key) || this.directories.has(`${worktreeId}/${path}/`)) {
      return {
        type: FileType.Directory,
        ctime: Date.now() - 5000,
        mtime: Date.now(),
        size: 0
      };
    }

    // File/directory not found → simulate HTTP 404
    const uri = Uri.parse(`workspace-vfs://${worktreeId}/${path}`);
    throw FileSystemError.FileNotFound(uri);
  }

  /**
   * Read file content as Uint8Array
   *
   * Simulates backend GET /api/files/:worktreeId/read?path=...
   *
   * @param worktreeId - Worktree identifier
   * @param path - File path
   * @returns Uint8Array with file content
   * @throws FileSystemError.FileNotFound if file doesn't exist
   */
  async readFile(worktreeId: string, path: string): Promise<Uint8Array> {
    const key = `${worktreeId}/${path}`;

    // Check if file exists
    if (this.files.has(key)) {
      return this.files.get(key)!.content;
    }

    // File not found → simulate HTTP 404
    const uri = Uri.parse(`workspace-vfs://${worktreeId}/${path}`);
    throw FileSystemError.FileNotFound(uri);
  }

  /**
   * List directory contents
   *
   * Simulates backend GET /api/files/:worktreeId/list?path=...
   *
   * @param worktreeId - Worktree identifier
   * @param path - Directory path
   * @returns Array of [name, FileType] tuples
   * @throws FileSystemError.FileNotFound if directory doesn't exist
   */
  async readDirectory(worktreeId: string, path: string): Promise<[string, FileType][]> {
    // Normalize path (remove leading slash, ensure trailing slash)
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const key = `${worktreeId}/${normalizedPath}`;
    const keyWithSlash = `${worktreeId}/${normalizedPath}/`;

    // Check if directory exists
    if (this.directories.has(key) || this.directories.has(keyWithSlash)) {
      return this.directories.get(key) || this.directories.get(keyWithSlash) || [];
    }

    // Directory not found → simulate HTTP 404
    const uri = Uri.parse(`workspace-vfs://${worktreeId}/${path}`);
    throw FileSystemError.FileNotFound(uri);
  }

  /**
   * Write file content to backend
   *
   * Simulates backend POST /api/files/:worktreeId/write
   *
   * @param worktreeId - Worktree identifier
   * @param path - File path
   * @param content - File content as Uint8Array
   * @throws FileSystemError.NoPermissions if path contains '..' (path traversal)
   */
  async writeFile(worktreeId: string, path: string, content: Uint8Array): Promise<void> {
    const uri = Uri.parse(`workspace-vfs://${worktreeId}/${path}`);

    // Security: Check for path traversal (prevents '..' in path)
    // Backend validates this too (FILESYSTEM-07)
    if (path.includes('..')) {
      throw FileSystemError.NoPermissions(uri);
    }

    const key = `${worktreeId}/${path}`;

    // Create or update file
    this.files.set(key, {
      content,
      stat: {
        type: FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: content.length
      }
    });

    // Ensure file appears in parent directory listing
    const pathParts = path.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const parentPath = pathParts.slice(0, -1).join('/');
    const parentKey = parentPath ? `${worktreeId}/${parentPath}` : `${worktreeId}/`;

    // Add file to parent directory if not already listed
    if (this.directories.has(parentKey) || this.directories.has(`${parentKey}/`)) {
      const existingEntries = this.directories.get(parentKey) || this.directories.get(`${parentKey}/`) || [];
      const fileExists = existingEntries.some(([name]) => name === fileName);

      if (!fileExists) {
        existingEntries.push([fileName, FileType.File]);
        this.directories.set(parentKey, existingEntries);
      }
    }
  }

  /**
   * Clear all files and directories
   *
   * Useful for test cleanup or resetting state
   */
  clear(): void {
    this.files.clear();
    this.directories.clear();
  }

  /**
   * Add custom file for testing
   *
   * @param worktreeId - Worktree identifier
   * @param path - File path
   * @param content - File content as string
   */
  addFile(worktreeId: string, path: string, content: string): void {
    const key = `${worktreeId}/${path}`;
    const encodedContent = new TextEncoder().encode(content);

    this.files.set(key, {
      content: encodedContent,
      stat: {
        type: FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: encodedContent.length
      }
    });
  }

  /**
   * Add custom directory for testing
   *
   * @param worktreeId - Worktree identifier
   * @param path - Directory path
   * @param entries - Directory entries [name, FileType]
   */
  addDirectory(worktreeId: string, path: string, entries: [string, FileType][]): void {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const key = `${worktreeId}/${normalizedPath}`;

    this.directories.set(key, entries);
  }
}