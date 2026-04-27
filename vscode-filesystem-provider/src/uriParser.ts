import { Uri } from 'vscode';

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Parse a workspace-vfs:// URI to extract worktreeId and path
 * 
 * URI format: workspace-vfs://worktreeId/relative/path/to/file.ts
 * - scheme: 'workspace-vfs'
 * - authority: worktreeId
 * - path: '/relative/path/to/file.ts' (encoded)
 * 
 * @param uri - VS Code URI with workspace-vfs scheme
 * @returns Object with worktreeId and decoded path
 * 
 * Example:
 * parseUri(Uri.parse('workspace-vfs://abc123/my%20file.ts'))
 * → { worktreeId: 'abc123', path: 'my file.ts' }
 */
export function parseUri(uri: Uri, expectedWorktreePath?: string): { worktreeId: string; path: string } {
  const decodedAuthority = decodeURIComponent(uri.authority);
  const decodedPath = decodeURIComponent(uri.path);

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
