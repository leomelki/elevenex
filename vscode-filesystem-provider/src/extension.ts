import {
  commands,
  ExtensionContext,
  QuickPickItem,
  Range,
  Uri,
  window as vscodeWindow,
  workspace
} from 'vscode';
import { BackendClient } from './backendClient';
import { WorkspaceVfsProvider } from './fileSystemProvider';
import { createWorkspaceTextSearchProvider } from './textSearchProvider';
import { WebSocketClient } from './wsClient';

type BrowserLocationLike = {
  origin?: string;
  protocol?: string;
  host?: string;
};

function getBrowserLocation(): BrowserLocationLike | undefined {
  return (globalThis as typeof globalThis & { location?: BrowserLocationLike }).location;
}

interface ElevenExOpenFileMessage {
  type: 'elevenex-open-file';
  path: string;
  preserveFocus?: boolean;
  line?: number;
  column?: number;
}

interface FileSearchQuickPickItem extends QuickPickItem {
  path: string;
}

/**
 * The backend caches its candidate file list, so responses are fast enough to
 * poll aggressively; this only coalesces bursts within a single keystroke.
 */
const FILE_SEARCH_DEBOUNCE_MS = 60;

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function fileBridgeChannelName(worktreePath: string): string {
  return `elevenex-vscode:${worktreePath}`;
}

function toWorkspaceVfsUri(worktreePath: string, relativePath: string): Uri {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  return Uri.from({
    scheme: 'workspace-vfs',
    authority: encodeURIComponent(worktreePath),
    path: normalizedRelativePath ? `/${normalizedRelativePath}` : '/',
  });
}

async function openOrRevealFile(worktreePath: string, message: ElevenExOpenFileMessage): Promise<void> {
  const normalizedRelativePath = normalizeRelativePath(message.path);
  if (!normalizedRelativePath) {
    return;
  }

  const uri = toWorkspaceVfsUri(worktreePath, normalizedRelativePath);

  const preserveFocus = message.preserveFocus ?? true;
  const existingEditor = vscodeWindow.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());

  if (existingEditor) {
    const selection = targetRange(existingEditor.document, message);
    await vscodeWindow.showTextDocument(existingEditor.document, {
      preserveFocus,
      preview: false,
      viewColumn: existingEditor.viewColumn,
      ...(selection ? { selection } : {}),
    });
    return;
  }

  const doc = await workspace.openTextDocument(uri);
  const selection = targetRange(doc, message);
  await vscodeWindow.showTextDocument(doc, {
    preserveFocus,
    preview: false,
    ...(selection ? { selection } : {}),
  });
}

function targetRange(
  document: { lineCount: number; lineAt(line: number): { text: string } },
  message: ElevenExOpenFileMessage,
): Range | undefined {
  if (!Number.isInteger(message.line) || (message.line ?? 0) < 1 || document.lineCount < 1) {
    return undefined;
  }
  const line = Math.min(message.line! - 1, document.lineCount - 1);
  const requestedColumn = Number.isInteger(message.column) ? message.column! - 1 : 0;
  const column = Math.min(Math.max(0, requestedColumn), document.lineAt(line).text.length);
  return new Range(line, column, line, column);
}

function toFileSearchItem(result: { path: string; name: string }): FileSearchQuickPickItem {
  const normalizedPath = normalizeRelativePath(result.path);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');
  const description = lastSlashIndex === -1
    ? ''
    : normalizedPath.slice(0, lastSlashIndex);

  return {
    label: result.name || normalizedPath,
    description,
    detail: normalizedPath,
    path: normalizedPath,
  };
}

async function openFileSearch(worktreePath: string, backendClient: BackendClient): Promise<void> {
  const quickPick = vscodeWindow.createQuickPick<FileSearchQuickPickItem>();
  quickPick.placeholder = 'Search files by name';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.ignoreFocusOut = false;
  quickPick.busy = true;

  let disposed = false;
  let requestVersion = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let accepting = false;

  const updateItems = async (query: string): Promise<void> => {
    const version = ++requestVersion;
    // Drop the superseded request so the backend stops working on it.
    inFlight?.abort();
    const abortController = new AbortController();
    inFlight = abortController;
    quickPick.busy = true;

    try {
      const results = await backendClient.searchFiles(
        worktreePath,
        query,
        100,
        abortController.signal,
      );
      if (disposed || version !== requestVersion) {
        return;
      }

      quickPick.items = results.map(toFileSearchItem);
    } catch (error) {
      if (disposed || version !== requestVersion) {
        return;
      }

      quickPick.items = [];
      quickPick.placeholder = 'File search is unavailable';
      console.error('Failed to search workspace files', error);
    } finally {
      if (!disposed && version === requestVersion) {
        quickPick.busy = false;
      }
    }
  };

  const scheduleUpdate = (query: string): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      void updateItems(query);
    }, FILE_SEARCH_DEBOUNCE_MS);
  };

  quickPick.onDidChangeValue(scheduleUpdate);
  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
    if (!selected || accepting) {
      return;
    }

    accepting = true;
    quickPick.busy = true;
    void (async () => {
      try {
        await openOrRevealFile(worktreePath, {
          type: 'elevenex-open-file',
          path: selected.path,
          preserveFocus: false,
        });
        quickPick.hide();
      } catch (error) {
        console.error('Failed to open file search selection', error);
        accepting = false;
        quickPick.busy = false;
        void vscodeWindow.showErrorMessage(`Unable to open ${selected.path}`);
      }
    })();
  });
  quickPick.onDidHide(() => {
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    inFlight?.abort();
    quickPick.dispose();
  });

  quickPick.show();
  await updateItems('');
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
  const registerTextSearchProvider = (workspace as any).registerTextSearchProvider as
    | undefined
    | ((scheme: string, provider: any) => { dispose(): void });
  if (registerTextSearchProvider) {
    // registerTextSearchProvider is a proposed VS Code API. If the proposal is
    // not granted to this extension the call throws synchronously; isolate it so
    // a failure here never aborts activation (which would also drop the
    // elevenex.searchFiles command registered below) and only disables text search.
    try {
      context.subscriptions.push(
        registerTextSearchProvider(
          'workspace-vfs',
          createWorkspaceTextSearchProvider(worktreePath, backendClient),
        ),
      );
    } catch (error) {
      console.warn('Failed to register workspace-vfs TextSearchProvider', error);
    }
  } else {
    console.warn('VS Code TextSearchProvider API is unavailable for workspace-vfs');
  }
  context.subscriptions.push(commands.registerCommand('elevenex.searchFiles', () => {
    void openFileSearch(worktreePath, backendClient).catch(error => {
      console.error('Failed to open ElevenEX file search', error);
    });
  }));

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

  if (typeof BroadcastChannel !== 'undefined') {
    const fileBridge = new BroadcastChannel(fileBridgeChannelName(worktreePath));
    const handleParentMessage = (event: MessageEvent) => {
      const data = event.data as Partial<ElevenExOpenFileMessage> | undefined;
      if (data?.type !== 'elevenex-open-file' || typeof data.path !== 'string') {
        return;
      }

      void openOrRevealFile(worktreePath, {
        type: 'elevenex-open-file',
        path: data.path,
        preserveFocus: data.preserveFocus,
        line: data.line,
        column: data.column,
      }).catch(error => {
        console.error('Failed to open or reveal file from parent bridge', error);
      });
    };

    fileBridge.addEventListener('message', handleParentMessage);
    fileBridge.postMessage({ type: 'elevenex-file-bridge-ready' });
    context.subscriptions.push({
      dispose: () => {
        fileBridge.removeEventListener('message', handleParentMessage);
        fileBridge.close();
      }
    });
  } else {
    console.error('BroadcastChannel is unavailable; parent file-open requests are disabled');
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
