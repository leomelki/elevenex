import * as vscode from 'vscode';
import { HTML_PREVIEW_VIEW } from '../webview';
import type { CompactLayout } from './compact-layout';
import { previewViewDocument, readPreviewViewEvent, type PreviewPosition, type PreviewViewCommand } from './html-preview-view';

type PreviewCall = (operation: string, input: object, signal?: AbortSignal) => Promise<unknown>;
type Placement = 'auto' | 'beside';
interface PreviewTab {
  readonly panel: vscode.WebviewPanel;
  source: vscode.Uri;
  /** The view's last state, replayed when VS Code recreates a hidden webview. */
  shown?: Extract<PreviewViewCommand, { type: 'show' | 'error' }>;
  /** Last reported position, keyed by the page's URL path as the bridge reports it. */
  scroll?: PreviewPosition;
  pending?: AbortController;
  origin?: string;
  ready: boolean;
  /** Changed while hidden; reload when the tab is shown again. */
  stale: boolean;
  refreshTimer?: ReturnType<typeof setTimeout>;
}

const HTML_FILE = /\.html?$/i;
// Saving one of these can change how the previewed page renders.
const PAGE_ASSET = /\.(?:html?|css|svg)$/i;
const fileName = (uri: vscode.Uri) => uri.path.slice(uri.path.lastIndexOf('/') + 1);
const directory = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const contains = (parent: string, path: string) => path === parent || path.startsWith(parent === '/' ? '/' : parent + '/');
const decodePath = (urlPath: string) => { try { return decodeURIComponent(urlPath); } catch { return undefined; } };

function nonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function failure(error: unknown, path: string): Extract<PreviewViewCommand, { type: 'error' }> {
  if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
    return { type: 'error', title: 'Couldn’t find this file', detail: `${path.slice(1)} is no longer in this task. It may have been moved or deleted.`, retry: true, source: false };
  }
  return { type: 'error', title: 'Couldn’t load the preview', detail: 'Check that the task is connected, then try again.', retry: true, source: true };
}

/** One reusable preview tab. Its page reloads after edits to the page or its
 * nearby assets, keeps its scroll position, and follows in-page navigation. */
export function registerHtmlPreview(
  context: vscode.ExtensionContext, root: vscode.Uri, layout: CompactLayout, call: PreviewCall,
  fileChanges: vscode.Event<readonly vscode.FileChangeEvent[]>,
): void {
  let preview: PreviewTab | undefined;
  const inTask = (uri: vscode.Uri) => uri.scheme === root.scheme && uri.authority === root.authority;
  const isTaskHtml = (uri: vscode.Uri) => inTask(uri) && HTML_FILE.test(uri.path);
  const close = (origin: string) => { void call('html-preview-close', { origin }).catch(() => undefined); };
  const post = (entry: PreviewTab, command: PreviewViewCommand) => {
    if (entry.ready) void entry.panel.webview.postMessage(command);
  };
  const withPosition = (entry: PreviewTab, shown: Extract<PreviewViewCommand, { type: 'show' }>): PreviewViewCommand =>
    entry.scroll && decodePath(entry.scroll.path) === entry.source.path ? { ...shown, restore: entry.scroll } : shown;
  const retitle = (entry: PreviewTab) => { entry.panel.title = `Preview · ${fileName(entry.source)}`; };

  const refresh = async (entry: PreviewTab) => {
    clearTimeout(entry.refreshTimer);
    entry.stale = false;
    entry.pending?.abort();
    const pending = new AbortController();
    entry.pending = pending;
    post(entry, { type: 'loading' });
    try {
      const reply = await call('html-preview', { path: entry.source.path }, pending.signal);
      if (!reply || typeof reply !== 'object' || !('url' in reply) || typeof reply.url !== 'string') throw new Error('Invalid preview URL');
      const url = new URL(reply.url);
      if (url.protocol !== 'https:' || !/^elevenex-preview-[a-f0-9]{32}\.invalid$/.test(url.host)) throw new Error('Invalid preview origin');
      if (pending.signal.aborted) { close(url.origin); return; }
      entry.origin = url.origin;
      entry.shown = { type: 'show', url: url.href, title: `Preview of ${fileName(entry.source)}` };
      post(entry, withPosition(entry, entry.shown));
    } catch (error) {
      if (pending.signal.aborted) return;
      if (entry.origin) { close(entry.origin); entry.origin = undefined; }
      entry.shown = failure(error, entry.source.path);
      post(entry, entry.shown);
    } finally {
      if (entry.pending === pending) entry.pending = undefined;
    }
  };
  // Coalesces a save with the change event it produces, and agent writes.
  const scheduleRefresh = (entry: PreviewTab) => {
    if (!entry.panel.visible) { entry.stale = true; return; }
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => void refresh(entry), 300);
  };

  const followNavigation = (entry: PreviewTab, urlPath: string) => {
    const path = decodePath(urlPath);
    if (!path) return;
    const uri = root.with({ path });
    if (!isTaskHtml(uri) || uri.path === entry.source.path) return;
    entry.source = uri;
    retitle(entry);
    if (entry.shown?.type === 'show' && entry.origin) entry.shown = { ...entry.shown, url: new URL(urlPath, entry.origin).href, title: `Preview of ${fileName(uri)}` };
  };

  const openExternal = async (value: string) => {
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    // Page content chose this destination, so the person confirms it. A quick
    // pick fits the narrow side panel, where a modal dialog would be clipped.
    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { readonly action: 'open' | 'copy' }>([
      { label: '$(link-external) Open in Browser', detail: url.href, action: 'open' },
      { label: '$(copy) Copy Link', action: 'copy' },
    ], { title: 'Open link from preview?', placeHolder: url.host });
    if (choice?.action === 'copy') await vscode.env.clipboard.writeText(url.href);
    if (choice?.action !== 'open') return;
    const reply = await call('html-preview-open-external', { url: url.href }).catch(() => undefined);
    if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true) {
      void vscode.window.showWarningMessage('Couldn’t open the link in your browser.');
    }
  };

  const showSource = async (entry: PreviewTab) => {
    const source = entry.source.toString();
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(candidate => candidate.input instanceof vscode.TabInputText && candidate.input.uri.toString() === source);
    await vscode.window.showTextDocument(entry.source, { viewColumn: tab?.group.viewColumn ?? entry.panel.viewColumn });
  };

  const create = (source: vscode.Uri, beside: boolean): PreviewTab => {
    const panel = vscode.window.createWebviewPanel(HTML_PREVIEW_VIEW, '', { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: beside }, { enableScripts: true, localResourceRoots: [] });
    const entry: PreviewTab = { panel, source, ready: false, stale: false };
    retitle(entry);
    const lifetime = [
      panel.webview.onDidReceiveMessage((value: unknown) => {
        const message = readPreviewViewEvent(value);
        if (!message || preview !== entry) return;
        switch (message.type) {
          // VS Code discards a hidden webview's document, drops messages sent
          // meanwhile, and reports ready again when it recreates the view.
          case 'ready':
            entry.ready = true;
            if (entry.pending) post(entry, { type: 'loading' });
            else if (entry.stale) void refresh(entry);
            else if (entry.shown) post(entry, entry.shown.type === 'show' ? withPosition(entry, entry.shown) : entry.shown);
            else void refresh(entry);
            break;
          case 'loaded':
            followNavigation(entry, message.path);
            entry.scroll = { path: message.path, x: message.x, y: message.y };
            break;
          case 'scroll':
            if (decodePath(message.path) === entry.source.path) entry.scroll = { path: message.path, x: message.x, y: message.y };
            break;
          case 'open-external': void openExternal(message.url); break;
          case 'retry': void refresh(entry); break;
          case 'open-source': void showSource(entry); break;
        }
      }),
      panel.onDidChangeViewState(() => { if (panel.visible && entry.stale && !entry.pending) void refresh(entry); }),
      panel.onDidDispose(() => {
        for (const subscription of lifetime) subscription.dispose();
        clearTimeout(entry.refreshTimer);
        entry.pending?.abort();
        if (entry.origin) close(entry.origin);
        if (preview === entry) preview = undefined;
      }),
    ];
    panel.webview.html = previewViewDocument(nonce());
    return entry;
  };

  const open = async (resource: unknown, placement: Placement) => {
    const source = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    if (!source || !isTaskHtml(source)) return;
    // Side by side keeps the source editable when there is room for both.
    const beside = placement === 'beside' || !layout.isCompact;
    const existing = preview;
    if (!existing) {
      const entry = create(source, beside);
      preview = entry;
      // Start the read alongside restoring the compact editor group.
      await Promise.all([refresh(entry), layout.revealEditor()]);
      return;
    }
    const changed = existing.source.toString() !== source.toString();
    if (changed) { existing.source = source; existing.scroll = undefined; retitle(existing); }
    existing.panel.reveal(placement === 'beside' && existing.panel.viewColumn === vscode.window.activeTextEditor?.viewColumn ? vscode.ViewColumn.Beside : undefined, beside);
    await layout.revealEditor();
    if (changed || existing.shown?.type === 'error') await refresh(existing);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('elevenex.code.preview-html', (resource?: unknown) => open(resource, 'auto')),
    vscode.commands.registerCommand('elevenex.code.preview-html-side', (resource?: unknown) => open(resource, 'beside')),
    vscode.commands.registerCommand('elevenex.code.refresh-html-preview', () => preview && refresh(preview)),
    vscode.commands.registerCommand('elevenex.code.preview-html-source', () => preview && showSource(preview)),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (preview && inTask(document.uri) && PAGE_ASSET.test(document.uri.path)) scheduleRefresh(preview);
    }),
    // Disk changes arrive per watched directory, so agent edits to the page or
    // to assets beside or below it refresh a visible preview. File-level events
    // for page files are skipped: polling reports every open document on any
    // change, and editor saves are handled above.
    fileChanges(events => {
      const entry = preview;
      if (!entry) return;
      const folder = directory(entry.source.path);
      if (events.some(event => inTask(event.uri) && (
        event.type === vscode.FileChangeType.Deleted && event.uri.path === entry.source.path ||
        !PAGE_ASSET.test(event.uri.path) && (contains(event.uri.path, folder) || contains(folder, event.uri.path))))) scheduleRefresh(entry);
    }),
    { dispose: () => preview?.panel.dispose() },
  );
}
