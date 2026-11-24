import * as vscode from 'vscode';
import { HTML_PREVIEW_VIEW, STATIC_PREVIEW_POLICY } from '../webview';
import type { CompactLayout } from './compact-layout';

type PreviewCall = (operation: string, input: object, signal?: AbortSignal) => Promise<unknown>;
interface PreviewTab {
  readonly panel: vscode.WebviewPanel;
  source: vscode.Uri;
  pending?: AbortController;
  origin?: string;
  needsRefresh: boolean;
}

const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function previewDocument(content: string, origin = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_POLICY}; img-src 'none'; font-src 'none'; media-src 'none'; base-uri 'none'; frame-src ${origin || "'none'"}">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: white; }
      .status { min-height: 100%; box-sizing: border-box; display: grid; place-content: center; padding: 1.5rem; text-align: center; }
      h1 { font-size: 1.15em; margin: 0 0 .5em; }
      p { margin: 0; color: var(--vscode-descriptionForeground); }
    </style></head><body>${content}</body></html>`;
}

export function registerHtmlPreview(context: vscode.ExtensionContext, root: vscode.Uri, layout: CompactLayout, call: PreviewCall): void {
  let preview: PreviewTab | undefined;
  const close = (origin: string) => { void call('html-preview-close', { origin }).catch(() => undefined); };

  const refresh = async (entry: PreviewTab, showLoading: boolean) => {
    entry.pending?.abort();
    const pending = new AbortController();
    entry.pending = pending;
    entry.needsRefresh = false;
    if (showLoading) entry.panel.webview.html = previewDocument('<main class="status" role="status"><p>Loading HTML preview…</p></main>');
    try {
      const reply = await call('html-preview', { path: entry.source.path }, pending.signal);
      if (!reply || typeof reply !== 'object' || !('url' in reply) || typeof reply.url !== 'string') throw new Error('Invalid preview URL');
      const url = new URL(reply.url);
      if (url.protocol !== 'https:' || !/^elevenex-preview-[a-f0-9]{32}\.invalid$/.test(url.host)) throw new Error('Invalid preview origin');
      if (pending.signal.aborted) { close(url.origin); return; }
      entry.origin = url.origin;
      entry.panel.webview.html = previewDocument(
        `<iframe src="${escapeHtml(url.href)}" title="${escapeHtml(entry.panel.title)}" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>`, url.origin,
      );
    } catch (error) {
      if (pending.signal.aborted) return;
      if (entry.origin) { close(entry.origin); entry.origin = undefined; }
      const detail = error instanceof vscode.FileSystemError && error.code === 'FileNotFound'
        ? 'The file could not be found in this task.'
        : 'Check that the file is available in this task, then refresh the preview.';
      entry.panel.webview.html = previewDocument(`<main class="status" role="status"><div><h1>Couldn’t open HTML preview</h1><p>${detail}</p></div></main>`);
    } finally {
      if (entry.pending === pending) entry.pending = undefined;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('elevenex.code.preview-html', async (resource?: unknown) => {
      const source = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
      if (!source || source.scheme !== root.scheme || source.authority !== root.authority || !/\.html?$/i.test(source.path)) return;
      if (preview?.source.toString() === source.toString()) {
        const entry = preview;
        entry.panel.reveal();
        await layout.revealEditor();
        if (!entry.pending) await refresh(entry, false);
        return;
      }
      const title = `Preview · ${source.path.split('/').at(-1)}`;
      if (!preview) {
        const panel = vscode.window.createWebviewPanel(HTML_PREVIEW_VIEW, title, vscode.ViewColumn.Active, { localResourceRoots: [] });
        const entry = { panel, source, needsRefresh: false };
        preview = entry;
        const lifetime = [
          panel.onDidChangeViewState(() => {
            if (preview?.panel === panel && panel.visible && preview.needsRefresh) void refresh(preview, false);
          }),
          panel.onDidDispose(() => {
            for (const subscription of lifetime) subscription.dispose();
            if (preview?.panel !== panel) return;
            const closed = preview;
            preview = undefined;
            closed.pending?.abort();
            if (closed.origin) close(closed.origin);
          }),
        ];
      } else {
        preview.source = source;
        preview.panel.title = title;
        preview.panel.reveal();
      }
      const entry = preview;
      // Start the read alongside restoring the compact editor group.
      await Promise.all([refresh(entry, true), layout.revealEditor()]);
    }),
    vscode.commands.registerCommand('elevenex.code.refresh-html-preview', () => preview && refresh(preview, false)),
    vscode.commands.registerCommand('elevenex.code.preview-html-source', () => preview && vscode.window.showTextDocument(preview.source)),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.toString() !== preview?.source.toString()) return;
      if (preview.panel.visible) void refresh(preview, false);
      else preview.needsRefresh = true;
    }),
    { dispose: () => preview?.panel.dispose() },
  );
}
