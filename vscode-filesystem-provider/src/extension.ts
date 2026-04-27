import {
  ExtensionContext,
  Uri,
  window as vscodeWindow,
  workspace
} from 'vscode';
import { BackendClient } from './backendClient';
import { WorkspaceVfsProvider } from './fileSystemProvider';
import { WebSocketClient } from './wsClient';

type BrowserLocationLike = {
  origin?: string;
  protocol?: string;
  host?: string;
};

function getBrowserLocation(): BrowserLocationLike | undefined {
  return (globalThis as typeof globalThis & { location?: BrowserLocationLike }).location;
}

type BrowserMessageTarget = typeof globalThis & {
  addEventListener?: (type: 'message', listener: (event: MessageEvent) => void) => void;
  removeEventListener?: (type: 'message', listener: (event: MessageEvent) => void) => void;
};

interface ElevenExOpenFileMessage {
  type: 'elevenex-open-file';
  path: string;
  preserveFocus?: boolean;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function openOrRevealFile(worktreePath: string, message: ElevenExOpenFileMessage): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(message.path);
  if (!normalizedRelativePath) {
    return;
  }

  const uri = Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(worktreePath),
    path: `/${normalizedRelativePath}`,
  });

  const preserveFocus = message.preserveFocus ?? true;
  const existingEditor = vscodeWindow.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());

  if (existingEditor) {
    await vscodeWindow.showTextDocument(existingEditor.document, {
      preserveFocus,
      preview: false,
      viewColumn: existingEditor.viewColumn,
    });
    return;
  }

  const doc = await workspace.openTextDocument(uri);
  await vscodeWindow.showTextDocument(doc, {
    preserveFocus,
    preview: false,
  });
}

/**
 * Extension activation
 * 
 * Called by VS Code when workspace-vfs scheme is accessed (activation event)
 * 
 * Tasks:
 * 1. Create BackendClient for REST API calls
 * 2. Create WebSocketClient for real-time file sync
 * 3. Create WorkspaceVfsProvider FileSystemProvider implementation
 * 4. Register workspace-vfs scheme with VS Code
 * 5. Create workspace folder in VS Code Explorer
 * 
 * Worktree ID acquisition:
 * - Current: Hardcoded 'test-worktree' for development
 * - Future (Phase 11): Passed via iframe URL query param
 * 
 * Backend URL:
 * - Current: Hardcoded http://localhost:3001/api/files
 * - Future: Configurable via extension settings
 * 
 * WebSocket URL:
 * - Current: Hardcoded ws://localhost:3001/ws/file-changes/:worktreeId
 * - Future: Configurable via extension settings
 */
export async function activate(context: ExtensionContext): Promise<WorkspaceVfsProvider> {
  console.log('ElevenEX FileSystemProvider extension activating...');

  const folder = workspace.workspaceFolders?.find(item => item.uri.scheme === 'workspace-vfs');
  if (!folder) {
    throw new Error('No workspace-vfs folder found');
  }

  const worktreePath = decodeURIComponent(folder.uri.authority || folder.uri.path);
  const browserLocation = getBrowserLocation();
  const origin = browserLocation?.origin ?? 'http://localhost:3000';
  const wsProtocol = browserLocation?.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBaseUrl = `${wsProtocol}//${browserLocation?.host ?? 'localhost:3000'}`;

  // Create BackendClient for REST API calls
  const backendClient = new BackendClient(`${origin}/api/worktrees`);

  // Create WebSocketClient for real-time file sync (Plan 02)
  const wsClient = new WebSocketClient(worktreePath, wsBaseUrl);

  // Create FileSystemProvider instance with WebSocket client
  const provider = new WorkspaceVfsProvider(backendClient, worktreePath, wsClient);

  // Register workspace-vfs scheme with VS Code
  // Options:
  // - isCaseSensitive: true (Linux-style paths)
  // - isReadonly: false (enable write support)
  const registration = workspace.registerFileSystemProvider(
    'workspace-vfs',
    provider,
    {
      isCaseSensitive: true,
      isReadonly: false
    }
  );

  // Add registration to extension subscriptions (auto-cleanup on deactivate)
  context.subscriptions.push(registration);
  context.subscriptions.push(provider);

  // Connect WebSocket after registration
  // Backend file changes → WebSocket → provider._onDidChangeFile → VS Code cache invalidation
  wsClient.connect();
  console.log('WebSocket client connecting to FileChangeGateway...');

  // Add WebSocket cleanup to subscriptions
  context.subscriptions.push({
    dispose: () => {
      wsClient.disconnect();
    }
  });

  const browserMessageTarget = globalThis as BrowserMessageTarget;
  if (browserMessageTarget.addEventListener) {
    const handleParentMessage = (event: MessageEvent) => {
      const data = event.data as Partial<ElevenExOpenFileMessage> | undefined;
      if (data?.type !== 'elevenex-open-file' || typeof data.path !== 'string') {
        return;
      }

      void openOrRevealFile(worktreePath, {
        type: 'elevenex-open-file',
        path: data.path,
        preserveFocus: data.preserveFocus,
      }).catch(error => {
        console.error('Failed to open or reveal file from parent bridge', error);
      });
    };

    // Equivalent to window.addEventListener('message', handleParentMessage) in browser builds.
    browserMessageTarget.addEventListener('message', handleParentMessage);
    context.subscriptions.push({
      dispose: () => {
        browserMessageTarget.removeEventListener?.('message', handleParentMessage);
      }
    });
  }

  console.log('ElevenEX FileSystemProvider extension activated successfully');

  // Return provider for testing/integration
  return provider;
}

/**
 * Extension deactivation
 * 
 * Called by VS Code when extension is disabled or VS Code closes
 * 
 * Cleanup:
 * - Disposable subscriptions auto-cleaned by VS Code
 * - WebSocketClient.disconnect() called via subscription cleanup
 * - BackendClient has no persistent resources
 * - WorkspaceVfsProvider.dispose() called automatically
 */
export function deactivate(): void {
  console.log('ElevenEX FileSystemProvider extension deactivating...');
  
  // All disposables in context.subscriptions are auto-cleaned by VS Code
  // WebSocket disconnect handled by Disposable.from subscription
}
