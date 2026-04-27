import { QuickDiffProvider, Uri, CancellationToken, ProviderResult } from 'vscode';
import { parseUri } from './uriParser';

/**
 * GitQuickDiffProvider - Provides original resource URI from git HEAD
 *
 * VS Code QuickDiffProvider implementation for gutter markers:
 * - VS Code calls provideOriginalResource() when file is opened in editor
 * - Provider returns git-vfs:// URI pointing to file at HEAD
 * - VS Code uses TextDocumentContentProvider to fetch content from that URI
 * - VS Code computes inline diff and displays gutter markers (green/red/blue)
 *
 * Pattern: Returns URI to original resource (not content directly)
 * Content is fetched via GitContentProvider (git-vfs:// URI scheme)
 *
 * @implements QuickDiffProvider
 */
export class GitQuickDiffProvider implements QuickDiffProvider {
  /**
   * Create GitQuickDiffProvider instance
   *
   * @param worktreeId - Worktree identifier for URI construction
   */
  constructor(
    private worktreeId: string
  ) {}

  /**
   * Provide original resource URI from git HEAD
   *
   * VS Code calls this method automatically when a file is opened in the editor.
   * Returns a git-vfs:// URI pointing to the original version at HEAD.
   *
   * VS Code then:
   * 1. Uses TextDocumentContentProvider to fetch content from git-vfs:// URI
   * 2. Computes inline diff between current file and original
   * 3. Displays gutter markers:
   *    - Green markers for added lines
   *    - Blue markers for modified lines
   *    - Red markers for deleted lines
   *
   * @param uri - Current file URI (workspace-vfs://worktreeId/path)
   * @param token - Cancellation token
   * @returns git-vfs:// URI pointing to file at HEAD, or undefined if not found
   */
  provideOriginalResource?(uri: Uri, token?: CancellationToken): ProviderResult<Uri> {
    try {
      // Parse workspace-vfs:// URI to extract path
      const { worktreeId, path } = parseUri(uri, this.worktreeId);

      // Construct git-vfs:// URI pointing to file at HEAD
      // GitContentProvider will serve content from this URI
      const originalUri = Uri.parse(`git-vfs://${encodeURIComponent(worktreeId)}/HEAD/${path}`);

      return originalUri;
    } catch (error: any) {
      // Error parsing URI - return undefined (no gutter markers)
      console.error(`Failed to create original resource URI for ${uri.path}:`, error.message);
      return undefined;
    }
  }
}
