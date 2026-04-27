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
 * Reuse Phase 9 URI parsing pattern
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
 * Parse a git-vfs:// URI to extract worktreeId, ref, and path
 *
 * URI format: git-vfs://worktreeId/REF/relative/path/to/file.ts
 * - scheme: 'git-vfs'
 * - authority: worktreeId
 * - path: '/REF/relative/path/to/file.ts' (encoded)
 *
 * The first segment of the path is the git ref (HEAD, branch name, commit hash)
 * The remaining path is the file path within the repo
 *
 * Branch name with slashes handling:
 * - Branch names can contain slashes (e.g., feature/my-feature)
 * - We identify common root directories to distinguish ref from file path
 * - Known roots: src, test, tests, lib, apps, packages, dist, build, public, private
 *
 * Examples:
 * - git-vfs://worktreeId/HEAD/src/app.ts → ref=HEAD, path=src/app.ts
 * - git-vfs://worktreeId/main/src/app.ts → ref=main, path=src/app.ts
 * - git-vfs://worktreeId/abc1234/src/app.ts → ref=abc1234, path=src/app.ts
 * - git-vfs://worktreeId/feature/my-feature/src/app.ts → ref=feature/my-feature, path=src/app.ts
 *
 * @param uri - VS Code URI with git-vfs scheme
 * @returns Object with worktreeId, ref, and decoded path
 */
export function parseGitUri(uri: Uri): { worktreeId: string; ref: string; path: string } {
  // Extract worktreeId from authority component
  const worktreeId = decodeURIComponent(uri.authority);

  // Decode the path (URIs use percent-encoding)
  const decodedPath = decodeURIComponent(uri.path);

  // Strip leading '/' if present
  const pathWithoutSlash = decodedPath.startsWith('/') ? decodedPath.slice(1) : decodedPath;

  // Split on '/' to get segments
  const segments = pathWithoutSlash.split('/');

  // Common root directories that indicate start of file path
  // If we see one of these, everything before is the ref, everything after is the file path
  const knownRoots = ['src', 'test', 'tests', 'lib', 'libs', 'apps', 'packages', 'dist', 'build', 'public', 'private', 'docs', 'config'];

  // Find the index of the first known root directory
  let rootIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (knownRoots.includes(segments[i])) {
      rootIndex = i;
      break;
    }
  }

  let ref: string;
  let path: string;

  if (rootIndex >= 0) {
    // Found a known root directory
    // Everything before it is the ref, everything from it onward is the file path
    ref = segments.slice(0, rootIndex).join('/');
    path = segments.slice(rootIndex).join('/');
  } else {
    // No known root directory found
    // Assume first segment is ref, rest is file path
    // This works for simple cases like HEAD/file.ts or main/file.ts
    ref = segments[0];
    path = segments.slice(1).join('/');
  }

  return { worktreeId, ref, path };
}
