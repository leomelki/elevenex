import { FileSystemError, Uri } from 'vscode';

/**
 * FileStatus interface matching backend git.service.ts
 */
export interface FileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  oldPath?: string;
}

/**
 * MockGitBackend - Mock backend git endpoints for isolated testing
 *
 * Simulates NestJS backend git operations without requiring real server:
 * - Provides getStatus() returning FileStatus[] array
 * - Provides getOriginalContent() returning file content from git history
 * - Returns hardcoded status data for testing
 *
 * Usage in tests:
 * const mockBackend = new MockGitBackend();
 * mockBackend.seedSampleStatus();
 * const client = new BackendGitClient(mockBackend);
 */
export class MockGitBackend {
  /**
   * In-memory file status storage
   * Key format: `${worktreeId}/status`
   */
  private statuses = new Map<string, FileStatus[]>();

  /**
   * In-memory original content storage
   * Key format: `${worktreeId}/${ref}/${path}`
   */
  private contents = new Map<string, string>();

  /**
   * Constructor - seed with sample status
   */
  constructor() {
    this.seedSampleStatus();
    this.seedSampleContent();
  }

  /**
   * Seed sample git status for testing
   *
   * Creates basic status structure:
   * - Modified file (src/app.ts)
   * - Added file (src/new-feature.ts)
   * - Deleted file (old-file.ts)
   * - Untracked file (temp.txt)
   */
  seedSampleStatus(): void {
    const worktreeId = 'test-worktree';

    this.statuses.set(`${worktreeId}/status`, [
      {
        path: 'src/app.ts',
        status: 'modified',
        staged: false
      },
      {
        path: 'src/new-feature.ts',
        status: 'added',
        staged: true
      },
      {
        path: 'old-file.ts',
        status: 'deleted',
        staged: false
      },
      {
        path: 'temp.txt',
        status: 'untracked',
        staged: false
      }
    ]);
  }

  /**
   * Seed sample original content for testing
   *
   * Creates basic content for HEAD ref:
   * - src/app.ts (original content before modification)
   */
  seedSampleContent(): void {
    const worktreeId = 'test-worktree';

    this.contents.set(`${worktreeId}/HEAD/src/app.ts`, 'Original app content\n');
    this.contents.set(`${worktreeId}/HEAD/src/new-feature.ts`, '');
  }

  /**
   * Get git status for worktree
   *
   * Simulates backend GET /api/git/status?worktreePath=...
   *
   * @param worktreeId - Worktree identifier
   * @returns FileStatus[] array
   * @throws FileSystemError.Unavailable if worktree not found
   */
  async getStatus(worktreeId: string): Promise<FileStatus[]> {
    const key = `${worktreeId}/status`;

    if (this.statuses.has(key)) {
      return this.statuses.get(key)!;
    }

    // Simulate HTTP 500 error for missing worktree
    const uri = Uri.parse(`workspace-vfs://${worktreeId}/`);
    throw FileSystemError.Unavailable(uri);
  }

  /**
   * Get file content from git history
   *
   * Simulates backend GET /api/git/original?worktreePath=...&ref=...&path=...
   *
   * @param worktreeId - Worktree identifier
   * @param ref - Git ref (HEAD, branch name, commit hash)
   * @param path - File path
   * @returns File content as string
   * @throws FileSystemError.FileNotFound if file doesn't exist in git history
   */
  async getOriginalContent(worktreeId: string, ref: string, path: string): Promise<string> {
    const key = `${worktreeId}/${ref}/${path}`;

    if (this.contents.has(key)) {
      return this.contents.get(key)!;
    }

    // Simulate HTTP 404 error for missing file in history
    const uri = Uri.parse(`git-vfs://${worktreeId}/${ref}/${path}`);
    throw FileSystemError.FileNotFound(uri);
  }

  /**
   * Clear all status and content data
   *
   * Useful for test cleanup or resetting state
   */
  clear(): void {
    this.statuses.clear();
    this.contents.clear();
  }

  /**
   * Add custom status for testing
   *
   * @param worktreeId - Worktree identifier
   * @param status - Array of FileStatus objects
   */
  addStatus(worktreeId: string, status: FileStatus[]): void {
    this.statuses.set(`${worktreeId}/status`, status);
  }

  /**
   * Add custom content for testing
   *
   * @param worktreeId - Worktree identifier
   * @param ref - Git ref
   * @param path - File path
   * @param content - File content as string
   */
  addContent(worktreeId: string, ref: string, path: string, content: string): void {
    this.contents.set(`${worktreeId}/${ref}/${path}`, content);
  }
}