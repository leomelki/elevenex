import { FileStatus, BackendGitStatusResponse, BackendGitContentResponse } from './types';

/**
 * BackendGitClient - REST API client for git operations
 *
 * Connects to Phase 10 backend git endpoints:
 * - GET /api/git/status?worktreePath=... → BackendGitStatusResponse
 * - GET /api/git/original?worktreePath=...&ref=...&path=... → BackendGitContentResponse
 *
 * Uses native fetch() API (browser-compatible, no Node.js dependencies)
 * Pattern: Reuse Phase 9 BackendClient architecture for git endpoints
 */
export class BackendGitClient {
  /**
   * Create BackendGitClient instance
   *
   * @param baseUrl - Backend API base URL (default: http://localhost:3000/api)
   * @param worktreeId - Worktree identifier for all git operations
   */
  constructor(
    private baseUrl: string = `${globalThis.location?.origin ?? 'http://localhost:3000'}/api`,
    private worktreePath: string
  ) {}

  /**
   * Get git status (list of changed files)
   *
   * Backend endpoint: GET /api/git/status?worktreePath=...
   *
   * @returns FileStatus[] array with path, status, staged, oldPath
   * @throws Error if network failure or HTTP error (400, 500)
   */
  async getStatus(): Promise<FileStatus[]> {
    const url = `${this.baseUrl}/git/status?worktreePath=${encodeURIComponent(this.worktreePath)}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json() as FileStatus[];
    } catch (error: any) {
      // Handle network errors
      throw new Error(`Failed to fetch git status: ${error.message}`);
    }
  }

  /**
   * Get file content from git history
   *
   * Backend endpoint: GET /api/git/original?worktreePath=...&ref=...&path=...
   *
   * @param ref - Git ref (HEAD, branch name, commit hash)
   * @param path - File path relative to worktree root
   * @returns File content as string
   * @throws Error if network failure, HTTP error (400, 404, 500)
   */
  async getOriginalContent(ref: string, path: string): Promise<string> {
    const url = `${this.baseUrl}/git/original?worktreePath=${encodeURIComponent(this.worktreePath)}&ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`;

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data: BackendGitContentResponse = await response.json() as BackendGitContentResponse;
      return data.content;
    } catch (error: any) {
      // Handle network errors
      throw new Error(`Failed to fetch original content: ${error.message}`);
    }
  }
}
