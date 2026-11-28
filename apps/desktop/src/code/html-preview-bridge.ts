import { PREVIEW_BRIDGE_CHANNEL, PREVIEW_HOST_CHANNEL } from './webview';

/** Served at a dot-prefixed path that the preview never reads from a checkout,
 * so a task file cannot replace it. The page CSP admits only this exact URL. */
export const PREVIEW_BRIDGE_PATH = '/.elevenex/preview-bridge.js';

/** Runs inside the previewed page, ahead of its markup. Page scripts, inline
 * handlers and `javascript:` URLs remain blocked by CSP; this bridge only
 * reports scroll position, the current document and blocked resources to the
 * owning webview, restores a position on request, and turns external link
 * clicks into a request the editor confirms instead of a frame navigation.
 *
 * It is serialized with `toString()`, so it must stay self-contained. Page
 * markup can shadow `document` and form properties by name, so the bridge uses
 * window members and prototype methods captured before the page is parsed. */
function previewBridge(bridgeChannel: string, hostChannel: string): void {
  const marker = Symbol.for('elevenex.htmlPreviewBridge');
  const global = window as unknown as Record<symbol, boolean>;
  const host = window.parent;
  const target = location.ancestorOrigins[0];
  if (global[marker] || host === window || !target) return;
  global[marker] = true;
  const listen = EventTarget.prototype.addEventListener;
  const closest = Element.prototype.closest;
  const path = location.pathname;
  const send = (message: Record<string, unknown>) => host.postMessage({ ...message, channel: bridgeChannel }, target);
  const on = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void) =>
    listen.call(window, type, handler as EventListener, { capture: true, passive: type === 'scroll' });
  const position = () => ({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) });
  const remoteUrl = (value: string): boolean => {
    try {
      const url = new URL(value, location.href);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== location.origin;
    } catch { return false; }
  };

  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  on('scroll', () => {
    scrollTimer ??= setTimeout(() => { scrollTimer = undefined; send({ type: 'scroll', path, ...position() }); }, 150);
  });

  let scripts = false;
  const remote = new Set<string>();
  let blockedTimer: ReturnType<typeof setTimeout> | undefined;
  const blocked = () => {
    blockedTimer ??= setTimeout(() => { blockedTimer = undefined; send({ type: 'blocked', path, scripts, remote: remote.size }); }, 100);
  };
  on('securitypolicyviolation', event => {
    if (event.effectiveDirective.startsWith('script-src')) scripts = true;
    else if (remoteUrl(event.blockedURI)) remote.add(event.blockedURI);
    else return;
    blocked();
  });
  // Remote stylesheets are refused by the request filter rather than CSP.
  on('error', event => {
    const element = event.target;
    if (!(element instanceof Element) || element instanceof HTMLScriptElement) return;
    const source = element instanceof HTMLLinkElement ? element.href : 'src' in element ? element.src : undefined;
    if (typeof source === 'string' && remoteUrl(source)) { remote.add(source); blocked(); }
  });

  const follow = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button > 1) return;
    const start = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const link = start && closest.call(start, 'a[href], area[href]');
    if (!(link instanceof HTMLAnchorElement || link instanceof HTMLAreaElement)) return;
    let url: URL;
    try { url = new URL(link.href); } catch { return; }
    if (url.origin === location.origin) {
      // The sandbox has no popups. Keep task pages in this preview instead.
      const elsewhere = event.button === 1 || event.ctrlKey || event.metaKey || event.shiftKey || !!link.target && link.target !== '_self';
      if (elsewhere) { event.preventDefault(); location.assign(url.href); }
      return;
    }
    event.preventDefault();
    if (url.protocol === 'https:' || url.protocol === 'http:') send({ type: 'open-external', path, url: url.href });
  };
  on('click', follow);
  on('auxclick', follow);

  on('message', event => {
    const data: unknown = event.data;
    if (event.source !== host || event.origin !== target || typeof data !== 'object' || data === null) return;
    const message = data as Record<string, unknown>;
    if (message['channel'] !== hostChannel || message['type'] !== 'restore') return;
    const x = Number(message['x']), y = Number(message['y']);
    if (Number.isFinite(x) && Number.isFinite(y)) window.scrollTo(Math.max(0, x), Math.max(0, y));
    setTimeout(() => send({ type: 'restored', path, ...position() }), 0);
  });
  on('load', () => send({ type: 'loaded', path, ...position() }));
}

export const PREVIEW_BRIDGE = `(${previewBridge.toString()})(${JSON.stringify(PREVIEW_BRIDGE_CHANNEL)}, ${JSON.stringify(PREVIEW_HOST_CHANNEL)});\n`;

const UTF16 = (bytes: Uint8Array) => bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0xff && bytes[1] === 0xfe;

/** Places the bridge first so it observes every violation and click. It goes
 * after any doctype so the page keeps its rendering mode. */
export function withPreviewBridge(bytes: Buffer<ArrayBuffer>, origin: string): Buffer<ArrayBuffer> {
  // An ASCII tag would corrupt UTF-16 text. Such pages render without the bridge.
  if (UTF16(bytes)) return bytes;
  const head = bytes.subarray(0, 4096).toString('latin1');
  const doctype = /^(?:\xEF\xBB\xBF)?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(head);
  const at = doctype ? doctype[0].length : head.startsWith('\xEF\xBB\xBF') ? 3 : 0;
  const tag = Buffer.from(`<script src="${origin}${PREVIEW_BRIDGE_PATH}"></script>`);
  return Buffer.concat([bytes.subarray(0, at), tag, bytes.subarray(at)]);
}

/** The injected tag shifts a `<meta charset>` declaration later in the file.
 * Declaring it in the response keeps the browser's 1024-byte prescan result. */
export function declaredCharset(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  const label = /<meta\s[^>]*charset\s*=\s*["']?\s*([\w.:-]{1,40})/i.exec(head)?.[1];
  return label?.toLowerCase();
}
