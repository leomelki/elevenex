import { BrowserWindow, nativeTheme, session, type Session } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWebAuthnOptions, BrowserWebAuthnResult } from '@elevenex/shared';
import { PROMPT_WIDTH, promptBackground, promptDocument, type PromptAssets } from './webauthn-prompt-document';
import { WebAuthnPrompt } from './webauthn-prompt';
import { accountsView, confirmView, failedView, promptPlatform, waitingView, type PromptPlatform } from './webauthn-prompt-view';

const brokerPath = '/.elevenex-webauthn';
const CEREMONY_TIMEOUT_MS = 120000;

/** Staged by the desktop build (`dist/browser/tokens.css`) and the renderer's
 * bundled font. Either may be missing in a partial development build. */
export async function loadPromptAssets(): Promise<PromptAssets> {
  const [tokens, font] = await Promise.all([
    readFile(join(__dirname, 'tokens.css'), 'utf8').catch(() => ''),
    readFile(join(__dirname, '../../renderer/fonts/instrument-sans.woff2')).then(bytes => bytes.toString('base64'), () => undefined),
  ]);
  return font === undefined ? { tokens } : { tokens, font };
}

type Outcome = { readonly ok: true; readonly json: string } | { readonly ok: false; readonly name: string };
interface Ceremony { readonly url: string; readonly request: BrowserWebAuthnOptions; readonly abort: () => void; window?: BrowserWindow; prompt?: WebAuthnPrompt; document?: { html: string; policy: string } }

/** Application-owned authenticator profile, independent of website/renderer
 * profiles. It executes only fixed trusted code, never downloads an RP page.
 * As the remote-desktop client, main vouches for the engine-validated origin
 * after explicit human consent in its own authentication sheet. Protocol
 * interception is confined to this session and to the single active ceremony
 * document; it grants no network access. */
export class WebAuthnBroker {
  private active?: Ceremony;
  private assets?: Promise<PromptAssets>;
  constructor(
    private readonly profile: Session = session.fromPartition('persist:elevenex-device-authenticator', { cache: false }),
    private readonly loadAssets: () => Promise<PromptAssets> = loadPromptAssets,
    private readonly platform: PromptPlatform = promptPlatform(process.platform),
  ) {
    this.profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.setDevicePermissionHandler(() => false);
    const serve = (request: Request) => {
      const document = this.active?.document;
      if (request.method !== 'GET' || request.url !== this.active?.url || !document) return new Response(null, { status: 403 });
      return new Response(document.html, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': document.policy,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    };
    this.profile.protocol.handle('https', serve);
    this.profile.protocol.handle('http', serve);
    this.profile.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== this.active?.url || details.resourceType !== 'mainFrame' }));
    this.profile.on('select-webauthn-account', (_event, details, callback) => {
      const active = this.active;
      if (!active?.prompt || !active.window || details.frame !== active.window.webContents.mainFrame || details.accounts.length > 32) { callback(); return; }
      void this.chooseAccount(active, details.accounts).then(callback, () => callback());
    });
  }
  async platformAvailable(parent: BrowserWindow): Promise<boolean> {
    return await parent.webContents.executeJavaScript('typeof PublicKeyCredential !== "undefined" && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()').then(value => value === true, () => false);
  }
  async run(parent: BrowserWindow, request: BrowserWebAuthnOptions, signal: AbortSignal): Promise<BrowserWebAuthnResult> {
    const denied: BrowserWebAuthnResult = { error: { name: 'NotAllowedError', message: 'Authentication was canceled or is unavailable.' } };
    if (this.active || signal.aborted || parent.isDestroyed()) return denied;
    const controller = new AbortController();
    const active: Ceremony = { url: request.origin + brokerPath, request, abort: () => controller.abort() };
    this.active = active;
    signal.addEventListener('abort', active.abort, { once: true });
    const timer = setTimeout(active.abort, CEREMONY_TIMEOUT_MS);
    const abortWindow = () => { if (active.window && !active.window.isDestroyed()) active.window.destroy(); };
    controller.signal.addEventListener('abort', abortWindow, { once: true });
    parent.once('closed', active.abort);
    try {
      this.assets ??= this.loadAssets();
      const assets = await this.assets;
      if (controller.signal.aborted) return denied;
      active.document = promptDocument(assets, randomBytes(18).toString('base64'));
      const window = new BrowserWindow({
        parent, modal: true, show: false, useContentSize: true, width: PROMPT_WIDTH, height: 240,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        title: 'Sign in · ' + request.origin, backgroundColor: promptBackground(assets.tokens, nativeTheme.shouldUseDarkColors),
        webPreferences: { session: this.profile, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, navigateOnDragDrop: false, spellcheck: false },
      });
      active.window = window;
      window.setMenu(null);
      window.once('closed', active.abort);
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-redirect', event => event.preventDefault());
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      await window.loadURL(active.url);
      if (controller.signal.aborted) return denied;
      const prompt = new WebAuthnPrompt(window);
      await prompt.install();
      // Consent comes first and nothing touches the authenticator before it.
      await prompt.render(confirmView(request));
      if (await prompt.choice() !== 'continue' || controller.signal.aborted) return denied;
      active.prompt = prompt;
      for (;;) {
        const outcome = await this.attempt(active, prompt, window);
        if (controller.signal.aborted) return denied;
        if (outcome.ok) return outcome.json.length > 65536 ? denied : { responseJson: outcome.json };
        // The site keeps waiting while the person reads why and may retry the
        // same consented request; the ceremony timeout still bounds it.
        await prompt.render(failedView(request, outcome.name));
        if (await prompt.choice() !== 'retry' || controller.signal.aborted) return denied;
      }
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

  /** One authenticator call. Cancel in the sheet (or Esc) aborts the ceremony,
   * which destroys the window and rejects the pending call. */
  private async attempt(active: Ceremony, prompt: WebAuthnPrompt, window: BrowserWindow): Promise<Outcome> {
    await prompt.render(waitingView(active.request, this.platform));
    let watching = true;
    void (async () => {
      while (watching) if (await prompt.choice() === 'cancel' && watching) active.abort();
    })();
    try {
      return outcome(await window.webContents.executeJavaScript(authenticationScript(active.request), true));
    } finally { watching = false; }
  }

  private async chooseAccount(active: Ceremony, accounts: readonly Electron.WebAuthnAccount[]): Promise<string | undefined> {
    const prompt = active.prompt;
    if (!prompt) return undefined;
    await prompt.render(accountsView(active.request, accounts));
    const choice = await prompt.choice();
    if (this.active !== active || !choice.startsWith('account:')) return undefined;
    const credential = accounts[Number(choice.slice('account:'.length))]?.credentialId;
    await prompt.render(waitingView(active.request, this.platform));
    return credential;
  }
}

function outcome(value: unknown): Outcome {
  if (typeof value === 'object' && value !== null) {
    if ('json' in value && typeof value.json === 'string') return { ok: true, json: value.json };
    if ('name' in value && typeof value.name === 'string') return { ok: false, name: value.name.slice(0, 64) };
  }
  return { ok: false, name: 'UnknownError' };
}

/** Fixed program; the request is data, including when it contains JS metacharacters.
 * It reports the DOMException name so the sheet can say what went wrong. */
export function authenticationScript(request: BrowserWebAuthnOptions): string {
  return `(async () => {
    try {
      const options = JSON.parse(${JSON.stringify(request.optionsJson)});
      const publicKey = PublicKeyCredential.${request.operation === 'create' ? 'parseCreationOptionsFromJSON' : 'parseRequestOptionsFromJSON'}(options);
      const credential = await navigator.credentials.${request.operation}({publicKey});
      if (!(credential instanceof PublicKeyCredential)) return { name: 'NotSupportedError' };
      return { json: JSON.stringify(credential.toJSON()) };
    } catch (error) {
      return { name: error && typeof error.name === 'string' ? error.name : 'UnknownError' };
    }
  })()`;
}
