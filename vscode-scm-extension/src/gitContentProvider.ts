import { TextDocumentContentProvider, Uri, CancellationToken, ProviderResult, EventEmitter } from 'vscode';
import { BackendGitClient } from './backendGitClient';
import { parseGitUri } from './uriParser';

/**
 * GitContentProvider - Serves file content from git history
 *
 * VS Code TextDocumentContentProvider implementation for git-vfs:// URI scheme:
 * - Serves file content from any git ref (HEAD, branch name, commit hash)
 * - Enables diff viewing and comparison against any point in git history
 * - Used by QuickDiffProvider for gutter markers (git-vfs://worktreeId/HEAD/path)
 * - Used by openDiff command for side-by-side diff (git-vfs://worktreeId/REF/path)
 *
 * URI format: git-vfs://worktreeId/REF/path/to/file.ts
 * Examples:
 * - git-vfs://worktreeId/HEAD/src/app.ts — File at HEAD
 * - git-vfs://worktreeId/main/src/app.ts — File at main branch tip
 * - git-vfs://worktreeId/abc1234/src/app.ts — File at commit abc1234
 *
 * @implements TextDocumentContentProvider
 */
export class GitContentProvider implements TextDocumentContentProvider {
  /**
   * Event emitter for content change notifications
   *
   * VS Code uses this to refresh documents when content might have changed
   */
  private _onDidChange = new EventEmitter<Uri>();

  /**
   * Create GitContentProvider instance
   *
   * @param backendClient - BackendGitClient for REST API calls
   * @param worktreeId - Worktree identifier for URI validation
   */
  constructor(
    private backendClient: BackendGitClient,
    private worktreeId: string
  ) {}

  /**
   * Event fired when file content might have changed
   *
   * VS Code listens to this event and re-fetches content when fired
   */
  readonly onDidChange = this._onDidChange.event;

  /**
   * Provide file content from git history
   *
   * VS Code calls this method when opening a git-vfs:// URI.
   * Extracts ref and path from URI, fetches content from backend.
   *
   * @param uri - git-vfs:// URI (git-vfs://worktreeId/REF/path/to/file.ts)
   * @param token - Cancellation token for aborting requests
   * @returns File content as string, or empty string if not found
   */
  async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string> {
    try {
      // Parse git-vfs:// URI to extract ref and path
      const { worktreeId, ref, path } = parseGitUri(uri);

      // Validate worktreeId matches provider instance
      // (Security check to prevent cross-worktree access)
      if (worktreeId !== this.worktreeId) {
        console.warn(`Worktree ID mismatch: expected ${this.worktreeId}, got ${worktreeId}`);
        return '';
      }

      // Check if request was cancelled
      if (token.isCancellationRequested) {
        return '';
      }

      // Fetch original content from backend
      const content = await this.backendClient.getOriginalContent(ref, path);

      return content;
    } catch (error: any) {
      // File not found in git history or network error
      // Return empty string (VS Code will show empty document)
      console.error(`Failed to get content for ${uri.path}:`, error.message);
      return '';
    }
  }
}
