import {
  ExtensionContext,
  scm,
  workspace,
  Uri,
  commands
} from 'vscode';
import { BackendGitClient } from './backendGitClient';
import { GitScmProvider } from './scmProvider';
import { GitQuickDiffProvider } from './quickDiffProvider';
import { GitContentProvider } from './gitContentProvider';

/**
 * Extension activation
 *
 * Called by VS Code when workspace-vfs scheme is accessed (activation event)
 *
 * Tasks:
 * 1. Create BackendGitClient for git REST API calls
 * 2. Register SourceControl with VS Code SCM API
 * 3. Create GitScmProvider instance
 * 4. Call provider.refresh() to populate changed files
 * 5. Register placeholder openDiff command (Plan 03 will implement)
 *
 * Worktree ID acquisition:
 * - Current: Hardcoded 'test-worktree' for development
 * - Future (Phase 11): Passed via iframe URL query param
 *
 * Backend URL:
 * - Current: Hardcoded http://localhost:3000/api
 * - Future: Configurable via extension settings
 */
export async function activate(context: ExtensionContext): Promise<void> {
  console.log('ElevenEX SCM extension activating...');

  const rootFolder = workspace.workspaceFolders?.find(item => item.uri.scheme === 'workspace-vfs');
  if (!rootFolder) {
    throw new Error('No workspace-vfs folder found');
  }

  const worktreePath = decodeURIComponent(rootFolder.uri.authority || rootFolder.uri.path);
  const baseUrl = `${globalThis.location?.origin ?? 'http://localhost:3000'}/api`;

  // Create BackendGitClient for git REST API calls
  const backendClient = new BackendGitClient(baseUrl, worktreePath);

  // Create root URI for SourceControl
  const rootUri = Uri.from({ scheme: 'workspace-vfs', path: worktreePath });

  // Register source control
  const sourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', rootUri);

  // Attach QuickDiffProvider for gutter markers (must be set before refresh)
  sourceControl.quickDiffProvider = new GitQuickDiffProvider(worktreePath);

  // Register git-vfs:// URI scheme for serving git history content
  const gitContentProvider = new GitContentProvider(backendClient, worktreePath);
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('git-vfs', gitContentProvider)
  );

  // Create GitScmProvider instance
  const provider = new GitScmProvider(backendClient, worktreePath, sourceControl);

  // Register openDiff command
  const openDiffCommand = commands.registerCommand('elevenex-git.openDiff', async (filePath: string) => {
    await provider.openDiff(filePath);
  });

  // Register compareAgainst command
  const compareAgainstCommand = commands.registerCommand('elevenex-git.compareAgainst', async (filePath: string, targetRef: string) => {
    await provider.compareAgainst(filePath, targetRef);
  });

  // Add to context subscriptions (auto-cleanup on deactivate)
  context.subscriptions.push(sourceControl);
  context.subscriptions.push(openDiffCommand);
  context.subscriptions.push(compareAgainstCommand);

  // Refresh status on activation
  await provider.refresh();
  console.log('Git status refreshed on activation');

  console.log('ElevenEX SCM extension activated successfully');
}

/**
 * Extension deactivation
 *
 * Called by VS Code when extension is disabled or VS Code closes
 *
 * Cleanup:
 * - Disposable subscriptions auto-cleaned by VS Code
 */
export function deactivate(): void {
  console.log('ElevenEX SCM extension deactivating...');

  // All disposables in context.subscriptions are auto-cleaned by VS Code
}
