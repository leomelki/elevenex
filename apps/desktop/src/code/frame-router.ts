import { type Session, type WebContents, type OnBeforeRequestListenerDetails } from 'electron';
import { isAppUrl } from '../security';
import type { CodeProtocol } from './protocol';

/** One handler per shell session. Origins, not Electron partitions, isolate tasks.
 * Every request also checks its owning window and initiator; knowing another
 * task's origin never grants that task's transport capability. */
export class CodeFrameRouter {
  private readonly hosts = new Set<CodeProtocol>();
  constructor(private readonly session: Session, private readonly devUrl?: string) {
    session.protocol.handle('https', request => {
      const host = this.find(request.url);
      return host ? host.handle(request) : new Response(null, { status: 403 });
    });
    session.webRequest.onBeforeRequest({ urls: ['https://*/*'] }, (details, callback) => callback({ cancel: !this.allowsRequest(details) }));
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
      const host = this.find(event.url);
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
    const host = this.find(details.url);
    if (!host || host.windowId !== details.webContentsId || details.resourceType === 'mainFrame') return false;
    const initiator = details.initiatorOrigin;
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
  private find(url: string): CodeProtocol | undefined { return [...this.hosts].find(host => host.allows(url)); }
}
