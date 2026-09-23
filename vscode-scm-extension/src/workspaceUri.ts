import { Uri } from 'vscode';

const VFS_AUTHORITY = 'elevenex';
const WORKTREE_QUERY_PARAM = 'worktreePath';

function normalizeWorktreePath(worktreePath: string): string {
  const normalized = worktreePath.replace(/\\/g, '/');
  return normalized.replace(/\/+$/, '') || normalized;
}

function worktreeQuery(worktreePath: string): string {
  return `${WORKTREE_QUERY_PARAM}=${encodeURIComponent(normalizeWorktreePath(worktreePath))}`;
}

export function toWorkspaceVfsUri(worktreePath: string, relativePath = ''): Uri {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: VFS_AUTHORITY,
    path: normalizedPath ? `/${normalizedPath}` : '/',
    query: worktreeQuery(worktreePath),
  });
}

export function toGitVfsUri(worktreePath: string, ref: string, relativePath: string): Uri {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return Uri.from({
    scheme: 'git-vfs',
    authority: VFS_AUTHORITY,
    path: `/${ref}/${normalizedPath}`,
    query: worktreeQuery(worktreePath),
  });
}

export function worktreePathFromUri(uri: Uri): string | undefined {
  return new URLSearchParams(uri.query).get(WORKTREE_QUERY_PARAM) || undefined;
}
