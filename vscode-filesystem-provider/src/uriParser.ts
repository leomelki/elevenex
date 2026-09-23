import { Uri } from 'vscode';
import { worktreePathFromUri } from './workspaceUri';

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Parse a workspace-vfs:// URI to extract worktreeId and path
 * 
 * URI format: workspace-vfs://elevenex/relative/path/to/file.ts?worktreePath=...
 * - scheme: 'workspace-vfs'
 * - authority: stable, hostname-safe identifier
 * - path: '/relative/path/to/file.ts' (encoded)
 * - query: case-preserving absolute worktree path
 * 
 * @param uri - VS Code URI with workspace-vfs scheme
 * @returns Object with worktreeId and decoded path
 * 
 * Example:
 * Legacy authority-based URIs remain supported for already-open editor state.
 */
export function parseUri(uri: Uri, expectedWorktreePath?: string): { worktreeId: string; path: string } {
  const decodedAuthority = decodeURIComponent(uri.authority);
  const decodedPath = decodeURIComponent(uri.path);
  const queryWorktreePath = worktreePathFromUri(uri);

  if (queryWorktreePath) {
    const path = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;
    return { worktreeId: queryWorktreePath, path };
  }

  if (decodedAuthority) {
    const path = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;
    return { worktreeId: decodedAuthority, path };
  }

  if (expectedWorktreePath) {
    const normalizedRoot = trimTrailingSlash(expectedWorktreePath);
    const normalizedRootLower = normalizedRoot.toLowerCase();
    const decodedPathLower = decodedPath.toLowerCase();

    if (decodedPathLower === normalizedRootLower) {
      return { worktreeId: normalizedRoot, path: '' };
    }

    if (decodedPathLower.startsWith(`${normalizedRootLower}/`)) {
      return {
        worktreeId: normalizedRoot,
        path: decodedPath.slice(normalizedRoot.length + 1),
      };
    }
  }

  const path = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;
  return { worktreeId: decodedAuthority || expectedWorktreePath || '', path };
}

/**
 * Validate that a URI uses the workspace-vfs scheme
 * 
 * @param uri - VS Code URI to validate
 * @returns true if scheme is workspace-vfs
 */
export function isValidWorkspaceVfsUri(uri: Uri): boolean {
  return uri.scheme === 'workspace-vfs';
}
