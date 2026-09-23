import { Uri } from 'vscode';

const WORKSPACE_VFS_AUTHORITY = 'elevenex';
const WORKTREE_QUERY_PARAM = 'worktreePath';

function normalizeWorktreePath(worktreePath: string): string {
  const normalized = worktreePath.replace(/\\/g, '/');
  return normalized.replace(/\/+$/, '') || normalized;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Build a stable workspace URI without putting the filesystem path in the URI
 * authority. Authorities are hostname-like and VS Code lowercases them while
 * canonicalizing URIs, which corrupts case-sensitive paths such as DataDog on
 * Linux. Query values retain their case across URI serialization.
 */
export function toWorkspaceVfsUri(worktreePath: string, relativePath = ''): Uri {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedWorktree = normalizeWorktreePath(worktreePath);

  return Uri.from({
    scheme: 'workspace-vfs',
    authority: WORKSPACE_VFS_AUTHORITY,
    path: normalizedPath ? `/${normalizedPath}` : '/',
    query: `${WORKTREE_QUERY_PARAM}=${encodeURIComponent(normalizedWorktree)}`,
  });
}

export function worktreePathFromUri(uri: Uri): string | undefined {
  const worktreePath = new URLSearchParams(uri.query).get(WORKTREE_QUERY_PARAM);
  return worktreePath || undefined;
}
