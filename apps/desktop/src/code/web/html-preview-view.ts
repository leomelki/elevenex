import { PREVIEW_BRIDGE_CHANNEL, PREVIEW_HOST_CHANNEL } from '../webview';

export interface PreviewPosition { readonly path: string; readonly x: number; readonly y: number }

/** Extension → view. */
export type PreviewViewCommand =
  | { readonly type: 'show'; readonly url: string; readonly title: string; readonly restore?: PreviewPosition }
  | { readonly type: 'loading' }
  | { readonly type: 'error'; readonly title: string; readonly detail: string; readonly retry: boolean; readonly source: boolean };

/** View → extension. Paths are URL paths reported by the page bridge. */
export type PreviewViewEvent =
  | { readonly type: 'ready' | 'retry' | 'open-source' }
  | { readonly type: 'loaded' | 'scroll'; readonly path: string; readonly x: number; readonly y: number }
  | { readonly type: 'open-external'; readonly url: string };

const coordinate = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000 ? Math.round(value) : undefined;

/** Webview messages are untrusted input to the extension. */
export function readPreviewViewEvent(value: unknown): PreviewViewEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  const type = message['type'];
  if (type === 'ready' || type === 'retry' || type === 'open-source') return { type };
  if (type === 'loaded' || type === 'scroll') {
    const path = message['path'], x = coordinate(message['x']), y = coordinate(message['y']);
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || x === undefined || y === undefined) return undefined;
    return { type, path, x, y };
  }
  if (type === 'open-external' && typeof message['url'] === 'string' && message['url'].length <= 2048) return { type, url: message['url'] };
  return undefined;
}

interface ViewApi { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void }

/** The webview's own document. It loads each page version hidden, restores
 * its scroll position through the page bridge, then swaps it in, so refreshes
 * neither flash nor jump. It is serialized with `toString()`, so it must stay
 * self-contained. */
function previewView(vscode: ViewApi, bridgeChannel: string, hostChannel: string): void {
  interface Position { path: string; x: number; y: number }
  interface Blocked { path: string; scripts: boolean; remote: number }
  interface Page {
    readonly frame: HTMLIFrameElement;
    readonly origin: string;
    readonly restore?: Position;
    path?: string;
    x: number;
    y: number;
    bridged: boolean;
    blocked?: Blocked;
    timer?: ReturnType<typeof setTimeout>;
  }
  const byId = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing preview element ${id}`);
    return element as T;
  };
  const stage = byId('stage'), progress = byId('progress');
  const status = byId('status'), heading = byId('status-title'), detail = byId('status-detail');
  const actions = byId('status-actions'), retry = byId<HTMLButtonElement>('retry'), source = byId<HTMLButtonElement>('open-source');
  const notice = byId('notice'), noticeText = byId('notice-text'), dismiss = byId<HTMLButtonElement>('notice-dismiss');
  const saved: unknown = vscode.getState();
  const savedDismissed = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>)['dismissed'] : undefined;
  const dismissed = new Set(Array.isArray(savedDismissed) ? savedDismissed.filter((path): path is string => typeof path === 'string').slice(-20) : []);
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  let current: Page | undefined;
  let incoming: Page | undefined;
  let loading: ReturnType<typeof setTimeout> | undefined;

  const showStatus = (title: string, text: string, options: { busy?: boolean; retry?: boolean; source?: boolean } = {}) => {
    heading.textContent = title;
    detail.textContent = text;
    detail.hidden = !text;
    retry.hidden = !options.retry;
    source.hidden = !options.source;
    actions.hidden = !options.retry && !options.source;
    status.classList.toggle('busy', !!options.busy);
    status.hidden = false;
  };
  const stopLoading = () => { clearTimeout(loading); loading = undefined; progress.hidden = true; };
  const renderNotice = () => {
    const blocked = current?.blocked;
    if (!current || !blocked || blocked.path !== current.path || !blocked.scripts && !blocked.remote || dismissed.has(blocked.path)) {
      notice.hidden = true;
      return;
    }
    const remote = blocked.remote === 1 ? '1 remote resource' : `${blocked.remote} remote resources`;
    noticeText.textContent = blocked.scripts && blocked.remote
      ? `Scripts and ${remote} are blocked in this static preview.`
      : blocked.scripts
        ? 'Scripts don’t run in this static preview. Use the Task Browser for interactive pages.'
        : `${remote} ${blocked.remote === 1 ? 'was' : 'were'} blocked. Previews load files from this task only.`;
    notice.hidden = false;
  };
  const discard = (page: Page | undefined) => {
    if (!page) return;
    clearTimeout(page.timer);
    page.frame.remove();
  };
  const promote = (page: Page) => {
    if (page !== incoming) return;
    clearTimeout(page.timer);
    const focused = !!current && document.activeElement === current.frame;
    discard(current);
    current = page;
    incoming = undefined;
    page.frame.classList.remove('incoming');
    page.frame.removeAttribute('tabindex');
    page.frame.removeAttribute('aria-hidden');
    stopLoading();
    status.hidden = true;
    if (focused) page.frame.focus();
    if (page.path) vscode.postMessage({ type: 'loaded', path: page.path, x: page.x, y: page.y });
    renderNotice();
  };
  const show = (url: string, title: string, restore: Position | undefined) => {
    discard(incoming);
    const frame = document.createElement('iframe');
    // Prefer the position of the page being replaced; the extension supplies
    // one only after this webview was recreated.
    const page: Page = {
      frame, origin: new URL(url).origin, x: 0, y: 0, bridged: false,
      restore: current?.path ? { path: current.path, x: current.x, y: current.y } : restore,
    };
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.title = title;
    frame.className = 'incoming';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    // A page without the bridge, such as UTF-16 text, still appears after load.
    frame.addEventListener('load', () => { setTimeout(() => { if (!page.bridged) promote(page); }, 300); });
    page.timer = setTimeout(() => promote(page), 3000);
    incoming = page;
    frame.src = url;
    stage.append(frame);
  };
  const fromPage = (page: Page, message: Record<string, unknown>) => {
    const path = message['path'];
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096) return;
    const x = number(message['x']), y = number(message['y']);
    page.bridged = true;
    switch (message['type']) {
      case 'loaded': {
        page.path = path; page.x = x; page.y = y;
        const restore = page.restore;
        if (page === incoming) {
          if (restore && restore.path === path && (restore.x || restore.y)) {
            page.frame.contentWindow?.postMessage({ channel: hostChannel, type: 'restore', x: restore.x, y: restore.y }, page.origin);
          } else promote(page);
        } else if (page === current) {
          vscode.postMessage({ type: 'loaded', path, x, y });
          renderNotice();
        }
        break;
      }
      case 'restored':
        page.x = x; page.y = y;
        promote(page);
        break;
      case 'scroll':
        if (path !== page.path) break;
        page.x = x; page.y = y;
        if (page === current) vscode.postMessage({ type: 'scroll', path, x, y });
        break;
      case 'blocked':
        page.blocked = { path, scripts: message['scripts'] === true, remote: Math.min(999, number(message['remote'])) };
        if (page === current) renderNotice();
        break;
      case 'open-external':
        if (page === current && typeof message['url'] === 'string') vscode.postMessage({ type: 'open-external', url: message['url'] });
        break;
    }
  };
  const fromExtension = (message: Record<string, unknown>) => {
    switch (message['type']) {
      case 'show': {
        const url = message['url'], title = message['title'], restore = message['restore'];
        if (typeof url !== 'string' || typeof title !== 'string') return;
        let position: Position | undefined;
        if (typeof restore === 'object' && restore !== null) {
          const value = restore as Record<string, unknown>;
          if (typeof value['path'] === 'string') position = { path: value['path'], x: number(value['x']), y: number(value['y']) };
        }
        show(url, title, position);
        break;
      }
      case 'loading':
        stopLoading();
        // Brief reloads stay quiet. A visible page keeps showing meanwhile.
        loading = setTimeout(() => {
          if (current) progress.hidden = false;
          else showStatus('Loading preview…', '', { busy: true });
        }, current ? 250 : 150);
        break;
      case 'error':
        stopLoading();
        discard(incoming); discard(current);
        current = incoming = undefined;
        notice.hidden = true;
        showStatus(String(message['title'] ?? ''), String(message['detail'] ?? ''), { retry: message['retry'] === true, source: message['source'] === true });
        // Keyboard users who were in the preview land on its recovery action.
        if (document.hasFocus()) (message['retry'] === true ? retry : source).focus({ preventScroll: true });
        break;
    }
  };

  window.addEventListener('message', event => {
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const message = data as Record<string, unknown>;
    const page = [current, incoming].find(candidate => !!candidate && event.source === candidate.frame.contentWindow && event.origin === candidate.origin);
    if (page) {
      if (message['channel'] === bridgeChannel) fromPage(page, message);
    } else if (event.origin === location.origin) fromExtension(message);
  });
  retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
  source.addEventListener('click', () => vscode.postMessage({ type: 'open-source' }));
  dismiss.addEventListener('click', () => {
    if (!current?.path) return;
    dismissed.add(current.path);
    vscode.setState({ dismissed: [...dismissed].slice(-20) });
    renderNotice();
    current.frame.focus();
  });
  vscode.postMessage({ type: 'ready' });
}

const STYLES = `
:root { color-scheme: light dark; }
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
[hidden] { display: none !important; }
button { font: inherit; cursor: pointer; }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
svg { flex: none; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
.notice { display: flex; flex: none; align-items: center; gap: 8px; box-sizing: border-box; min-height: 30px; padding: 4px 4px 4px 10px;
  border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
  background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 16px; }
.notice > svg { color: var(--vscode-editorInfo-foreground, currentColor); }
.notice p { flex: 1; min-width: 0; margin: 0; }
.icon-button { display: grid; flex: none; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; color: var(--vscode-icon-foreground, currentColor); }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.stage { position: relative; flex: 1; min-height: 0; }
.stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.stage iframe.incoming { opacity: 0; pointer-events: none; }
.progress { position: absolute; z-index: 2; inset: 0 0 auto; height: 2px; overflow: hidden; pointer-events: none; }
.progress::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 30%; background: var(--vscode-progressBar-background);
  animation: progress 1.2s ease-in-out infinite; }
@keyframes progress { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.status { position: absolute; z-index: 1; inset: 0; display: grid; place-items: center; box-sizing: border-box; padding: 24px;
  background: var(--vscode-editor-background); text-align: center; }
.status > div { max-width: 360px; }
.status h1 { margin: 0 0 6px; color: var(--vscode-foreground); font-size: 13px; font-weight: 600; }
.status.busy h1 { margin: 0; color: var(--vscode-descriptionForeground); font-weight: 400; }
.status p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 14px; }
.actions button { min-height: 26px; padding: 4px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; }
.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.primary:hover { background: var(--vscode-button-hoverBackground); }
.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
@media (prefers-reduced-motion: reduce) { .progress::before { width: 100%; opacity: .6; animation: none; } }
`;

export function previewViewDocument(nonce: string): string {
  // Page frames come from fresh `elevenex-preview-<id>.invalid` origins, which
  // the frame router admits only for this webview's owning workbench.
  const policy = [
    "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`,
    'frame-src https://*.invalid', "img-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const script = `(${previewView.toString()})(acquireVsCodeApi(), ${JSON.stringify(PREVIEW_BRIDGE_CHANNEL)}, ${JSON.stringify(PREVIEW_HOST_CHANNEL)});`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style nonce="${nonce}">${STYLES}</style></head><body>
<div id="notice" class="notice" role="status" hidden>
  <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v4M8 4.8v.1"/></svg>
  <p id="notice-text"></p>
  <button id="notice-dismiss" class="icon-button" type="button" aria-label="Dismiss notice" title="Dismiss"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
</div>
<main id="stage" class="stage">
  <div id="progress" class="progress" hidden></div>
  <section id="status" class="status" role="status" aria-live="polite" hidden><div>
    <h1 id="status-title"></h1><p id="status-detail"></p>
    <div id="status-actions" class="actions"><button id="retry" class="primary" type="button">Try Again</button><button id="open-source" class="secondary" type="button">Show Source</button></div>
  </div></section>
</main>
<script nonce="${nonce}">${script}</script>
</body></html>`;
}
