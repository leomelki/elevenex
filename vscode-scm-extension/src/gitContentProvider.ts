import {
  TextDocumentContentProvider,
  Uri,
  CancellationToken,
  ProviderResult,
  EventEmitter,
} from "vscode";
import { BackendGitClient } from "./backendGitClient";
import { parseGitUri } from "./uriParser";

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
  private observed = new Map<string, Uri>();
  invalidate(): void {
    for (const uri of this.observed.values()) this._onDidChange.fire(uri);
  }
  dispose(): void {
    this.observed.clear();
    this._onDidChange.dispose();
  }

  /**
   * Create GitContentProvider instance
   *
   * @param backendClient - BackendGitClient for REST API calls
   * @param worktreeId - Worktree identifier for URI validation
   */
  constructor(
    private backendClient: BackendGitClient,
    private worktreeId: string,
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
  async provideTextDocumentContent(
    uri: Uri,
    token: CancellationToken,
  ): Promise<string> {
    try {
      // Parse git-vfs:// URI to extract ref and path
      const { worktreeId, ref, path } = parseGitUri(uri);

      // Validate worktreeId matches provider instance
      // (Security check to prevent cross-worktree access)
      if (worktreeId !== this.worktreeId) {
        console.warn(
          `Worktree ID mismatch: expected ${this.worktreeId}, got ${worktreeId}`,
        );
        return "";
      }

      // Check if request was cancelled
      if (token.isCancellationRequested) {
        return "";
      }

      this.observed.set(uri.toString(), uri);
      while (this.observed.size > 256)
        this.observed.delete(this.observed.keys().next().value!);
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() =>
        controller.abort(),
      );
      let content: string;
      try {
        content = await this.backendClient.getOriginalContent(
          ref,
          path,
          controller.signal,
        );
      } finally {
        cancellation.dispose();
      }

      return content;
    } catch (error: any) {
      // File not found in git history or network error
      // Return empty string (VS Code will show empty document)
      console.error(`Failed to get content for ${uri.path}:`, error.message);
      return "";
    }
  }
}
