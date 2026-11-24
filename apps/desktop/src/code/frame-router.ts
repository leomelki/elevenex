import { type Session, type WebContents, type OnBeforeRequestListenerDetails } from 'electron';
import { isAppUrl } from '../security';
import type { CodeProtocol } from './protocol';
import { isCodeWebviewOrigin, isMarkdownPreviewResource, codeWebviewAsset, HTML_PREVIEW_EXTENSION } from './webview';
import { isHtmlPreviewOrigin } from './html-preview';

/** One handler per shell session. Origins, not Electron partitions, isolate tasks.
 * Every request also checks its owning window and initiator; knowing another
 * task's origin never grants that task's transport capability. */
export class CodeFrameRouter {
  private readonly hosts = new Set<CodeProtocol>();
  constructor(private readonly session: Session, private readonly devUrl?: string) {
    session.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (isHtmlPreviewOrigin(url)) {
        const host = this.findHtmlPreview(url);
        return host ? host.htmlPreview.handle(request, url) : new Response(null, { status: 403 });
      }
      const host = this.find(request.url);
      return host ? host.handle(request) : new Response(null, { status: 403 });
    });
    session.webRequest.onBeforeRequest({ urls: ['https://*/*', 'http://*/*'] }, (details, callback) => callback({ cancel: !this.allowsRequest(details) }));
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = details.requestingUrl;
      const host = this.find(origin);
      callback(!!host && new URL(origin).origin === `https://${host.authority}` && host.windowId === contents?.id && (permission === 'persistent-storage' || permission === 'clipboard-sanitized-write' && host.active && contents.isFocused()));
    });
    session.setPermissionCheckHandler((contents, permission, origin) => {
      const host = this.find(origin);
      return !!host && contents?.id === host.windowId && permission === 'persistent-storage';
    });
    session.setDevicePermissionHandler(() => false);
  }
  add(host: CodeProtocol): void { this.hosts.add(host); }
  remove(host: CodeProtocol): void { this.hosts.delete(host); }
  attach(contents: WebContents): () => void {
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      if (event.isMainFrame) return;
      const frame = event.frame;
      const destination = new URL(event.url);
      if (isHtmlPreviewOrigin(destination)) {
        const previewHost = this.findHtmlPreview(destination);
        if (!previewHost || previewHost.windowId !== contents.id ||
            !previewHost.htmlPreview.allowsDocument(destination) ||
            !this.isHtmlPreviewParent(frame?.parent, previewHost.authority)) event.preventDefault();
        return;
      }
      const previous = URL.parse(frame?.url ?? '');
      if (previous && isHtmlPreviewOrigin(previous)) { event.preventDefault(); return; }
      const host = this.find(event.url);
      if (host && frame?.parent && host.windowId === contents.id) {
        const url = new URL(event.url);
        const preview = codeWebviewAsset(url, host.authority);
        const parent = frame.parent;
        if (preview) {
          const allowed = preview === 'index.html'
            ? parent.url === `https://${host.authority}/`
            : preview === 'fake.html' && this.isPreviewParent(parent.url, url, host.authority);
          if (!allowed) event.preventDefault();
          return;
        }
      }
      // Root editor is a direct child of the trusted shell. Nested extension
      // worker frames must stay inside that editor's origin family.
      if (!host || host.windowId !== contents.id || !frame || (frame.parent === contents.mainFrame
        ? !isAppUrl(contents.getURL(), this.devUrl) || event.url !== `https://${host.authority}/`
        : !host.allows(frame.parent?.url ?? ''))) event.preventDefault();
    };
    contents.on('will-frame-navigate', navigate);
    return () => contents.removeListener('will-frame-navigate', navigate);
  }
  allowsRequest(details: OnBeforeRequestListenerDetails): boolean {
    const url = new URL(details.url);
    const initiator = details.initiatorOrigin;
    const source = URL.parse(initiator ?? details.frame?.url ?? '');
    if (isHtmlPreviewOrigin(url)) {
      const host = this.findHtmlPreview(url);
      if (!host || host.windowId !== details.webContentsId || details.method !== 'GET' ||
          !host.htmlPreview.current(url) || details.resourceType === 'mainFrame') return false;
      if (details.resourceType !== 'subFrame') return source?.origin === url.origin;
      return host.htmlPreview.allowsDocument(url) && !!source &&
        (source.origin === url.origin || isCodeWebviewOrigin(source, host.authority));
    }
    if (source && isHtmlPreviewOrigin(source)) return false;
    // The upstream preview setting can allow insecure resources. Keep HTTP
    // blocked for previews too, including localhost, without affecting the shell.
    if (url.protocol === 'http:') return !source || ![...this.hosts].some(host => isCodeWebviewOrigin(source, host.authority));
    const host = this.find(details.url);
    if (!host || details.resourceType === 'mainFrame') return false;
    const preview = codeWebviewAsset(url, host.authority);
    // Chromium omits the window for service worker registration and updates.
    // Only the pinned script on the initiating preview origin can use this path.
    if (preview === 'service-worker.js') return details.method === 'GET' && details.resourceType === 'script'
      && initiator === url.origin && (details.webContentsId === undefined || details.webContentsId === host.windowId);
    if (host.windowId !== details.webContentsId) return false;
    switch (preview) {
      case 'index.html': return details.resourceType === 'subFrame' && initiator === `https://${host.authority}`;
      case 'fake.html': return details.resourceType === 'subFrame' && initiator === url.origin;
    }
    if (source && isCodeWebviewOrigin(source, host.authority)) return details.method === 'GET'
      && details.resourceType !== 'subFrame' && isMarkdownPreviewResource(url, host.authority);
    if (initiator && host.allows(initiator)) return true;
    // Browser-created extension worker requests may omit initiator. Never infer
    // ownership from the destination alone when a frame is unavailable.
    if (!initiator && host.allows(details.frame?.url ?? '')) return true;
    return details.resourceType === 'subFrame' && details.url === `https://${host.authority}/`
      && isAppUrl(initiator ?? details.referrer, this.devUrl) && details.frame?.parent === details.webContents?.mainFrame;
  }
  dispose(): void {
    this.hosts.clear(); this.session.protocol.unhandle('https');
    this.session.webRequest.onBeforeRequest(null);
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
  }
  private isPreviewParent(value: string, child: URL, authority: string): boolean {
    const parent = URL.parse(value);
    return !!parent && parent.origin === child.origin && codeWebviewAsset(parent, authority) === 'index.html';
  }
  private isHtmlPreviewParent(frame: Electron.WebFrameMain | null | undefined, authority: string): boolean {
    const url = URL.parse(frame?.url ?? '');
    const outer = URL.parse(frame?.parent?.url ?? '');
    return !!url && !!outer && this.isPreviewParent(outer.href, url, authority) &&
      codeWebviewAsset(url, authority) === 'fake.html' && outer.searchParams.get('extensionId') === HTML_PREVIEW_EXTENSION;
  }
  private findHtmlPreview(url: URL): CodeProtocol | undefined {
    for (const host of this.hosts) if (host.htmlPreview.owns(url)) return host;
    return undefined;
  }
  private find(value: string): CodeProtocol | undefined {
    const url = URL.parse(value);
    return url ? [...this.hosts].find(host => host.allows(value) || codeWebviewAsset(url, host.authority)) : undefined;
  }
}
