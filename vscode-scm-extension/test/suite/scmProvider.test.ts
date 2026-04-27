import * as assert from 'assert';
import { GitScmProvider } from '../../src/scmProvider';
import { BackendGitClient } from '../../src/backendGitClient';
import { FileStatus, ExtendedDecorations } from '../../src/types';
import { MockGitBackend } from '../mockBackend';
import { scm, Uri, ThemeColor } from 'vscode';

suite('GitScmProvider Tests', () => {

  test('GitScmProvider.refresh() should update SourceControl.changes with file list', async () => {
    // Setup: Create mock backend and client
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    
    // Mock fetch for BackendGitClient
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    const backendClient = new BackendGitClient('http://localhost:3000/api', worktreeId);
    
    // Create mock SourceControl (provider will create its own resource groups)
    const mockSourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', Uri.parse(`workspace-vfs://${worktreeId}/`));

    // Create provider
    const provider = new GitScmProvider(backendClient, worktreeId, mockSourceControl);

    // Execute: Refresh status
    await provider.refresh();

    // Verify: Provider's changesGroup has unstaged files (modified, deleted, untracked = 3 files)
    const changesGroup = provider.getChangesGroup();
    assert.strictEqual(changesGroup.resourceStates.length, 3);

    // Verify: Provider's stagingGroup has staged files (added = 1 file)
    const stagingGroup = provider.getStagingGroup();
    assert.strictEqual(stagingGroup.resourceStates.length, 1);
  });

  test('File status should show correct letter (M/A/D/R/U/C)', async () => {
    // Setup: Create provider with mock backend
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    const backendClient = new BackendGitClient('http://localhost:3000/api', worktreeId);
    const mockSourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', Uri.parse(`workspace-vfs://${worktreeId}/`));

    const provider = new GitScmProvider(backendClient, worktreeId, mockSourceControl);
    await provider.refresh();

    // Get resource states from provider's groups
    const changesStates = provider.getChangesGroup().resourceStates;
    const stagingStates = provider.getStagingGroup().resourceStates;
    
    // Modified → 'M' (unstaged, in changesGroup)
    const modifiedState = changesStates.find(s => s.resourceUri.path.includes('app.ts'));
    const modifiedDecorations = modifiedState?.decorations as ExtendedDecorations;
    assert.strictEqual(modifiedDecorations?.letter, 'M');

    // Added → 'A' (staged, in stagingGroup)
    const addedState = stagingStates.find(s => s.resourceUri.path.includes('new-feature.ts'));
    const addedDecorations = addedState?.decorations as ExtendedDecorations;
    assert.strictEqual(addedDecorations?.letter, 'A');

    // Deleted → 'D' (unstaged, in changesGroup)
    const deletedState = changesStates.find(s => s.resourceUri.path.includes('old-file.ts'));
    const deletedDecorations = deletedState?.decorations as ExtendedDecorations;
    assert.strictEqual(deletedDecorations?.letter, 'D');

    // Untracked → 'U' (unstaged, in changesGroup)
    const untrackedState = changesStates.find(s => s.resourceUri.path.includes('temp.txt'));
    const untrackedDecorations = untrackedState?.decorations as ExtendedDecorations;
    assert.strictEqual(untrackedDecorations?.letter, 'U');
  });

  test('File status should show correct color theme', async () => {
    // Setup
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    const backendClient = new BackendGitClient('http://localhost:3000/api', worktreeId);
    const mockSourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', Uri.parse(`workspace-vfs://${worktreeId}/`));

    const provider = new GitScmProvider(backendClient, worktreeId, mockSourceControl);
    await provider.refresh();

    // Verify: ThemeColor for modified (in changesGroup)
    const changesStates = provider.getChangesGroup().resourceStates;
    const modifiedState = changesStates.find(s => s.resourceUri.path.includes('app.ts'));
    const modifiedDecorations = modifiedState?.decorations as ExtendedDecorations;
    assert.ok(modifiedDecorations?.color instanceof ThemeColor);
  });

  test('Deleted files should show strikeThrough decoration', async () => {
    // Setup
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    const backendClient = new BackendGitClient('http://localhost:3000/api', worktreeId);
    const mockSourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', Uri.parse(`workspace-vfs://${worktreeId}/`));

    const provider = new GitScmProvider(backendClient, worktreeId, mockSourceControl);
    await provider.refresh();

    // Verify: StrikeThrough for deleted (in changesGroup)
    const changesStates = provider.getChangesGroup().resourceStates;
    const deletedState = changesStates.find(s => s.resourceUri.path.includes('old-file.ts'));
    const deletedDecorations = deletedState?.decorations as ExtendedDecorations;
    assert.strictEqual(deletedDecorations?.strikeThrough, true);
  });

  test('Untracked files should show faded decoration', async () => {
    // Setup
    const mockBackend = new MockGitBackend();
    const worktreeId = 'test-worktree';
    
    global.fetch = async () => {
      const status = await mockBackend.getStatus(worktreeId);
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: status })
      } as Response;
    };

    const backendClient = new BackendGitClient('http://localhost:3000/api', worktreeId);
    const mockSourceControl = scm.createSourceControl('elevenex-git', 'ElevenEX Git', Uri.parse(`workspace-vfs://${worktreeId}/`));

    const provider = new GitScmProvider(backendClient, worktreeId, mockSourceControl);
    await provider.refresh();

    // Verify: Faded for untracked (in changesGroup)
    const changesStates = provider.getChangesGroup().resourceStates;
    const untrackedState = changesStates.find(s => s.resourceUri.path.includes('temp.txt'));
    const untrackedDecorations = untrackedState?.decorations as ExtendedDecorations;
    assert.strictEqual(untrackedDecorations?.faded, true);
  });
});