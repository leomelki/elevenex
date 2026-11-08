import { BrowserWindow, dialog, session, type Session } from 'electron';
import type { BrowserWebAuthnOptions, BrowserWebAuthnResult } from '@elevenex/shared';

const brokerPath = '/.elevenex-webauthn';
const document = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Device authentication</title><main><p>Complete authentication using your device or security key. Close this window to cancel.</p></main></html>';

/** Application-owned authenticator profile, independent of website/renderer
 * profiles. It executes only fixed trusted code, never downloads an RP page.
 * As the remote-desktop client, main vouches for the engine-validated origin
 * after explicit human consent. Protocol interception is confined to this session
 * and to the single active ceremony document; it grants no network access. */
export class WebAuthnBroker {
  private active?: { url: string; window?: BrowserWindow; abort: () => void };
  constructor(private readonly profile: Session = session.fromPartition('persist:elevenex-device-authenticator', { cache: false })) {
    this.profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.setDevicePermissionHandler(() => false);
    const serve = (request: Request) => {
      if (request.method !== 'GET' || request.url !== this.active?.url) return new Response(null, { status: 403 });
      return new Response(document, { headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    };
    this.profile.protocol.handle('https', serve);
    this.profile.protocol.handle('http', serve);
    this.profile.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== this.active?.url || details.resourceType !== 'mainFrame' }));
    this.profile.on('select-webauthn-account', (_event, details, callback) => {
      const window = this.active?.window;
      if (!window || details.frame !== window.webContents.mainFrame || details.accounts.length > 32) { callback(); return; }
      void dialog.showMessageBox(window, {
        type: 'question', title: 'Choose a passkey', message: 'Sign in to ' + details.relyingPartyId,
        buttons: [...details.accounts.map(account => account.displayName || account.name || 'Account'), 'Cancel'],
        cancelId: details.accounts.length, defaultId: details.accounts.length, noLink: true,
      }).then(result => callback(this.active?.window === window ? details.accounts[result.response]?.credentialId : undefined), () => callback());
    });
  }
  async platformAvailable(parent: BrowserWindow): Promise<boolean> {
    return await parent.webContents.executeJavaScript('typeof PublicKeyCredential !== "undefined" && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()').then(value => value === true, () => false);
  }
  async run(parent: BrowserWindow, request: BrowserWebAuthnOptions, signal: AbortSignal): Promise<BrowserWebAuthnResult> {
    const denied: BrowserWebAuthnResult = { error: { name: 'NotAllowedError', message: 'Authentication was canceled or is unavailable.' } };
    if (this.active || signal.aborted || parent.isDestroyed()) return denied;
    const controller = new AbortController();
    const active: NonNullable<WebAuthnBroker['active']> = { url: request.origin + brokerPath, abort: () => controller.abort() };
    this.active = active;
    signal.addEventListener('abort', active.abort, { once: true });
    const timer = setTimeout(active.abort, 120000);
    const abortWindow = () => { if (active.window && !active.window.isDestroyed()) active.window.destroy(); };
    controller.signal.addEventListener('abort', abortWindow, { once: true });
    parent.once('closed', active.abort);
    try {
      const permission = await dialog.showMessageBox(parent, {
        type: 'question', title: 'Use your device to authenticate',
        message: request.operation === 'create' ? 'Create a credential for ' + request.origin + '?' : 'Sign in to ' + request.origin + '?',
        detail: 'This request comes from the streamed browser. Your device handles authentication; private keys stay on your device.',
        buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true, signal: controller.signal,
      });
      if (permission.response !== 1 || controller.signal.aborted) return denied;
      const window = new BrowserWindow({
        parent, modal: true, show: false, width: 520, height: 220, title: 'Authenticate · ' + request.origin,
        webPreferences: { session: this.profile, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, navigateOnDragDrop: false },
      });
      active.window = window;
      window.setMenu(null);
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-redirect', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      await window.loadURL(active.url);
      if (controller.signal.aborted) return denied;
      window.show(); window.focus();
      const result: unknown = await window.webContents.executeJavaScript(authenticationScript(request), true);
      if (controller.signal.aborted || typeof result !== 'string' || result.length > 65536) return denied;
      return { responseJson: result };
    } catch { return denied; }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', active.abort);
      parent.removeListener('closed', active.abort);
      abortWindow();
      if (this.active === active) this.active = undefined;
    }
  }
  dispose(): void {
    this.active?.abort();
    this.profile.protocol.unhandle('https');
    this.profile.protocol.unhandle('http');
    this.profile.webRequest.onBeforeRequest(null);
    this.profile.removeAllListeners('select-webauthn-account');
  }
}

/** Fixed program; the request is data, including when it contains JS metacharacters. */
export function authenticationScript(request: BrowserWebAuthnOptions): string {
  return `(async () => {
    const options = JSON.parse(${JSON.stringify(request.optionsJson)});
    const publicKey = PublicKeyCredential.${request.operation === 'create' ? 'parseCreationOptionsFromJSON' : 'parseRequestOptionsFromJSON'}(options);
    const credential = await navigator.credentials.${request.operation}({publicKey});
    if (!(credential instanceof PublicKeyCredential)) throw new Error('Authentication unavailable');
    return JSON.stringify(credential.toJSON());
  })()`;
}
