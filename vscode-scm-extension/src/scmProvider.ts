import { scm, SourceControl, SourceControlResourceGroup, SourceControlResourceState, Uri, ThemeColor, Command, commands } from 'vscode';
import { BackendGitClient } from './backendGitClient';
import { FileStatus } from './types';

function toWorkspaceUri(worktreePath: string, path: string): Uri {
  const normalizedRoot = worktreePath.replace(/\/$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(normalizedRoot),
    path: normalizedPath ? `/${normalizedPath}` : '/',
  });
}

/**
 * GitScmProvider - VS Code SCM integration for git status
 *
 * Implements SourceControl provider with:
 * - Status fetching from backend GitService
 * - ResourceState decorations (letter, color, strikeThrough, faded)
 * - Diff view command for changed files
 *
 * Pattern: Similar to VS Code built-in Git extension SCM integration
 */
export class GitScmProvider {
  private sourceControl: SourceControl;
  private changesGroup: SourceControlResourceGroup;
  private stagingGroup: SourceControlResourceGroup;

  /**
   * Create GitScmProvider instance
   *
   * @param backendClient - BackendGitClient for REST API calls
   * @param worktreeId - Worktree identifier
   * @param sourceControl - VS Code SourceControl instance
   */
  constructor(
    private backendClient: BackendGitClient,
    private worktreeId: string,
    sourceControl: SourceControl
  ) {
    this.sourceControl = sourceControl;

    // Create resource groups
    this.changesGroup = sourceControl.createResourceGroup('changes', 'Changes');
    this.stagingGroup = sourceControl.createResourceGroup('staging', 'Staged Changes');

    // Initialize with empty arrays
    this.changesGroup.resourceStates = [];
    this.stagingGroup.resourceStates = [];
  }

  /**
   * Get changes resource group (for testing)
   *
   * @returns SourceControlResourceGroup containing unstaged changes
   */
  getChangesGroup(): SourceControlResourceGroup {
    return this.changesGroup;
  }

  /**
   * Get staging resource group (for testing)
   *
   * @returns SourceControlResourceGroup containing staged changes
   */
  getStagingGroup(): SourceControlResourceGroup {
    return this.stagingGroup;
  }

  /**
   * Refresh git status from backend
   *
   * - Calls BackendGitClient.getStatus()
   * - Maps FileStatus[] to SourceControlResourceState[]
   * - Updates sourceControl.changes.resourceStates
   */
  async refresh(): Promise<void> {
    try {
      // Fetch status from backend
      const files = await this.backendClient.getStatus();

      // Map FileStatus to SourceControlResourceState
      const resourceStates: SourceControlResourceState[] = files.map(file => {
        return this.mapFileStatusToResourceState(file);
      });

      // Update resource groups
      // Split into unstaged and staged
      const unstagedStates = resourceStates.filter(s => {
        const state = s as any;
        return !state._staged;
      });
      const stagedStates = resourceStates.filter(s => {
        const state = s as any;
        return state._staged;
      });

      this.changesGroup.resourceStates = unstagedStates;
      this.stagingGroup.resourceStates = stagedStates;
    } catch (error: any) {
      console.error('Failed to refresh git status:', error.message);
    }
  }

  /**
   * Map FileStatus status enum to letter
   *
   * @param status - FileStatus status string
   * @returns Letter: M (modified), A (added), D (deleted), R (renamed), U (untracked), C (conflicted)
   */
  private getStatusLetter(status: FileStatus['status']): string {
    switch (status) {
      case 'modified':
        return 'M';
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'untracked':
        return 'U';
      case 'conflicted':
        return 'C';
      default:
        return '?';
    }
  }

  /**
   * Map FileStatus status enum to ThemeColor
   *
   * Uses VS Code gitDecoration theme colors:
   * - modifiedResourceForeground (modified)
   * - addedResourceForeground (added)
   * - deletedResourceForeground (deleted)
   * - untrackedResourceForeground (untracked)
   *
   * @param status - FileStatus status string
   * @returns ThemeColor instance
   */
  private getStatusColor(status: FileStatus['status']): ThemeColor {
    switch (status) {
      case 'modified':
        return new ThemeColor('gitDecoration.modifiedResourceForeground');
      case 'added':
        return new ThemeColor('gitDecoration.addedResourceForeground');
      case 'deleted':
        return new ThemeColor('gitDecoration.deletedResourceForeground');
      case 'untracked':
        return new ThemeColor('gitDecoration.untrackedResourceForeground');
      case 'renamed':
        return new ThemeColor('gitDecoration.modifiedResourceForeground');
      case 'conflicted':
        return new ThemeColor('gitDecoration.modifiedResourceForeground');
      default:
        return new ThemeColor('gitDecoration.modifiedResourceForeground');
    }
  }

  /**
   * Map FileStatus to SourceControlResourceState
   *
   * Creates ResourceState with:
   * - resourceUri: workspace-vfs://worktreeId/path
   * - decorations: letter, color, tooltip, strikeThrough, faded
   * - command: elevenex-git.openDiff (placeholder for Plan 03)
   *
   * @param file - FileStatus from backend
   * @returns SourceControlResourceState for VS Code SCM panel
   */
  private mapFileStatusToResourceState(file: FileStatus): SourceControlResourceState {
    const resourceUri = toWorkspaceUri(this.worktreeId, file.path);

    const letter = this.getStatusLetter(file.status);
    const color = this.getStatusColor(file.status);

    const decorations = {
      letter,
      color,
      tooltip: `${file.status} - ${file.path}`,
      strikeThrough: file.status === 'deleted',
      faded: file.status === 'untracked'
    };

    // Placeholder command for Plan 03 (will implement diff viewing)
    const command: Command = {
      command: 'elevenex-git.openDiff',
      title: 'Open Diff',
      arguments: [file.path]
    };

    // Create ResourceState with internal staged flag for grouping
    const state: SourceControlResourceState & { _staged: boolean } = {
      resourceUri,
      decorations,
      command,
      _staged: file.staged
    };

    return state;
  }

  /**
   * Open side-by-side diff view for file (HEAD vs working tree)
   *
   * Constructs git-vfs:// URI for original content (at HEAD) and
   * workspace-vfs:// URI for current content (working tree).
   * Calls VS Code's built-in diff editor command.
   *
   * @param filePath - File path relative to worktree root
   */
  async openDiff(filePath: string): Promise<void> {
    // Construct URI for original content at HEAD
    const originalUri = Uri.parse(`git-vfs://${encodeURIComponent(this.worktreeId)}/HEAD/${filePath}`);

    // Construct URI for current content in working tree
    const currentUri = toWorkspaceUri(this.worktreeId, filePath);

    // Open diff editor: left panel (original) vs right panel (current)
    await commands.executeCommand(
      'vscode.diff',
      originalUri,
      currentUri,
      `${filePath} (HEAD vs Working Tree)`
    );
  }

  /**
   * Compare working tree against specific branch or commit
   *
   * Constructs git-vfs:// URI for target ref (branch/commit) and
   * workspace-vfs:// URI for current content (working tree).
   * Calls VS Code's built-in diff editor command.
   *
   * @param filePath - File path relative to worktree root
   * @param targetRef - Git ref (branch name or commit hash)
   */
  async compareAgainst(filePath: string, targetRef: string): Promise<void> {
    // Construct URI for content at target ref
    const targetUri = Uri.parse(`git-vfs://${encodeURIComponent(this.worktreeId)}/${targetRef}/${filePath}`);

    // Construct URI for current content in working tree
    const currentUri = toWorkspaceUri(this.worktreeId, filePath);

    // Open diff editor: left panel (target) vs right panel (current)
    await commands.executeCommand(
      'vscode.diff',
      targetUri,
      currentUri,
      `${filePath} (${targetRef} vs Working Tree)`
    );
  }
}
