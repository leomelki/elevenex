/**
 * FileStatus interface matching backend git.service.ts
 *
 * Represents git file status from backend GET /api/git/status endpoint
 */
export interface FileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  staged: boolean;
  oldPath?: string; // For renames
}

/**
 * BackendGitStatusResponse - Response from GET /api/git/status
 */
export interface BackendGitStatusResponse {
  length: number;
}

/**
 * BackendGitContentResponse - Response from GET /api/git/original
 */
export interface BackendGitContentResponse {
  content: string;
}

/**
 * ExtendedDecorations - Full decorations for SCM resource states
 *
 * VS Code SourceControlResourceDecorations type may be incomplete,
 * this interface captures all decoration properties we use:
 * - letter: Status letter (M/A/D/R/U/C)
 * - color: ThemeColor for status
 * - tooltip: Hover text
 * - strikeThrough: For deleted files
 * - faded: For untracked files
 */
export interface ExtendedDecorations {
  letter?: string;
  color?: any; // ThemeColor type causes issues in tests
  tooltip?: string;
  strikeThrough?: boolean;
  faded?: boolean;
}
