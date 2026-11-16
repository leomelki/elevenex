import { CodeSurfaces } from './code/surfaces';
import { registerCodeIpc } from './code/ipc';
import { app, BrowserWindow, Menu, clipboard, dialog, net, nativeTheme, powerMonitor, protocol, session, shell, type WebContents, type WebFrameMain } from 'electron';
import { registerTerminalPorts } from './backend-client/terminal-ports';
import { TerminalLifetime } from './backend-client/terminal-lifetime';
import { TerminalPreferences } from './backend-client/terminal-preferences';
import { registerTaskBrowser } from './browser/application';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { broadcast, handle, sendToWindow } from './ipc';
import { APP_ORIGIN, contentSecurityPolicy, isAppUrl, isExternalUrl, rendererPath } from './security';
import { WindowStateStore } from './window-state';
import { createApplicationBackend } from './backend/application';
import { registerBackendIpc } from './backend/ipc';
import { notifyRecovery } from './remote/recovery-notifications';
import { monitorNetwork } from './remote/network-monitor';
import { RemoteManager } from './remote/manager';
import { registerRemoteIpc } from './remote/ipc';
import { readBackendRelease } from './backend/release';
import { developmentRemote } from './remote/development';
import { homedir } from 'node:os';
import { RemoteArchiveCache } from './remote/archives';
import { createBackendClient } from './backend-client/application';
import { registerBackendClientIpc } from './backend-client/ipc';
import type { CodeWindowContext, EnvironmentSelection } from '@elevenex/shared';
import { MachineApplication } from './machines/application';
import { MachinePreferences } from './machines/preferences';
import { registerMachineIpc } from './machines/ipc';
import { applicationIcon, installApplicationIdentity } from './application-identity';
import { registerClipboardIpc } from './clipboard';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

// Never let an environment variable choose remote content in a packaged app.
const devUrl = app.isPackaged ? undefined : process.env['ELEVENEX_RENDERER_URL'];
if (devUrl) {
  const url = new URL(devUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('The development renderer must use loopback HTTP');
  }
}

// Keep the new skeleton's state separate from the existing Elevenex app.
app.setName('Elevenex Desktop');
app.setPath('userData', join(app.getPath('appData'), 'Elevenex Desktop'));
const state = new WindowStateStore(join(app.getPath('userData'), 'window-state.json'));
const rendererRoot = join(__dirname, '../renderer');
// Plain Node cannot read Electron's ASAR format. Only the tiny supervisor and
// its process-tree helper are unpacked, never the renderer or privileged bridge.
const backend = createApplicationBackend(app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked/dist/backend/host.js')
  : join(__dirname, 'backend/host.js'), app.isPackaged);
const remoteRoot = join(homedir(), '.elevenex', 'desktop');
const remoteDevelopment = developmentRemote(app.isPackaged);
const remoteArchives = new RemoteArchiveCache(remoteRoot, remoteDevelopment?.archive);
const remote = new RemoteManager({
  root: remoteRoot,
  prepareArchive: (release, signal, progress) => remoteArchives.prepare(release, signal, progress),
  settingsPath: join(app.getPath('userData'), 'remote-settings.json'),
  helper: app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked/dist/remote/askpass-helper.js') : join(__dirname, 'remote/askpass-helper.js'),
  release: remoteDevelopment?.release ?? (() => readBackendRelease(__dirname)),
  developmentNamespace: remoteDevelopment?.namespace,
});
const backendClient = createBackendClient(backend, remote,
  (windowId, snapshot) => sendToWindow(windowId, 'backend-client:changed', snapshot));
const code = new CodeSurfaces(backendClient.client, join(app.getPath('userData'), 'code-runtimes'), join(rendererRoot, 'fonts'), (windowId, target, snapshot) => sendToWindow(windowId, 'code:changed', { target, state: snapshot }), (windowId, target) => sendToWindow(windowId, 'code:exit-requested', target), (context, configurationIdentity) => createWindow(context.selection, context, configurationIdentity), devUrl ? new URL(devUrl).origin : APP_ORIGIN);
const machinePreferences = new MachinePreferences(join(app.getPath('userData'), 'machine-preferences.json'));
let taskBrowser: ReturnType<typeof registerTaskBrowser> | undefined;
const terminalPreferences = new TerminalPreferences(join(app.getPath('userData'), 'terminal-preferences.json'));
let terminals = new TerminalLifetime();
const machines = new MachineApplication(backend, remote, machinePreferences,
  (windowId, snapshot) => sendToWindow(windowId, 'machines:changed', snapshot));

// Several windows share one backend and database. A second application process
// must hand control to the first instead of starting another database owner.
const ownsInstance = app.requestSingleInstanceLock();
let windowsReady = false;
let disposeIdentity: (() => void) | undefined;
if (!ownsInstance) app.exit(0);
app.on('second-instance', () => {
  if (!windowsReady) return;
  const window = BrowserWindow.getAllWindows()[0] ?? createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function trusted(frame: WebFrameMain | null, contents: WebContents): boolean {
  return !!frame && frame === contents.mainFrame && isAppUrl(frame.url, devUrl)
    && BrowserWindow.getAllWindows().some((window) => window.webContents === contents);
}

function openExternal(url: string): void {
  if (isExternalUrl(url)) void shell.openExternal(url).catch(console.error);
}

function createWindow(launchSelection?: EnvironmentSelection | null, editorContext?: CodeWindowContext, editorConfiguration?: string, browserOnly = false): BrowserWindow {
  const window = new BrowserWindow({
    ...(browserOnly ? { width: 1120, height: 800, minWidth: 400, minHeight: 320 } : state.options()),
    title: editorContext ? 'Code · ' + (editorContext.state.taskName ?? 'Task') : 'Elevenex',
    icon: applicationIcon,
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { height: 48 } }),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      devTools: !app.isPackaged,
    },
  });
  const contents = window.webContents;
  if (!browserOnly) state.attach(window);
  const stopCodeFrames = code.attachWindow(window.webContents, devUrl);
  window.once('closed', stopCodeFrames);
  // Home is passive on launch. Restore domain context when a machine is chosen,
  // but do not open a saved SSH host merely because the app started.
  if (!browserOnly) remote.attach(window.webContents.id, launchSelection ?? null);
  const windowId = window.webContents.id;
  if (!browserOnly) machines.attach(windowId, launchSelection ?? null);
  if (editorContext && editorConfiguration) code.registerWindow(windowId, editorContext, editorConfiguration);
  if (launchSelection && (!editorConfiguration || remote.backendCacheIdentity(windowId) === editorConfiguration)) void remote.select(windowId, launchSelection).catch(() => {
    // The renderer can retry from Home; never abandon a newly created window.
    console.error('Could not select the requested machine');
  });
  if (!browserOnly) backendClient.client.attach(windowId);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) { code.detachWindow(windowId); backendClient.client.reset(windowId); }
  });
  window.webContents.on('render-process-gone', () => { code.detachWindow(windowId); backendClient.client.reset(windowId); });
  let editorCloseAccepted = false, editorClosePending = false;
  window.on('close', event => {
    if (editorCloseAccepted || quitting) { code.detachWindow(windowId); return; }
    event.preventDefault();
    if (editorClosePending) return;
    editorClosePending = true;
    void code.prepareWindowClose(windowId).then(async accepted => {
      if (!accepted || window.isDestroyed()) return;
      // macOS keeps the app alive after its last window closes. Finish editor
      // backups before terminal cleanup, and keep this close pending for both.
      if (BrowserWindow.getAllWindows().length === 1) {
        await terminals.close();
        terminals = new TerminalLifetime();
      }
      if (!window.isDestroyed()) { editorCloseAccepted = true; window.close(); }
    }).catch(() => undefined).finally(() => { editorClosePending = false; });
  });
  window.once('closed', () => code.releaseWindow(windowId, () => {
    machines.detach(windowId);
    backendClient.client.detach(windowId);
    void remote.detach(windowId).catch(() => console.error('Remote window cleanup failed'));
  }));
  window.once('ready-to-show', () => window.show());
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, devUrl)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  // A redirect must never turn a trusted app window into an external site.
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, devUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event, _preferences, params) => { if (contents.isDestroyed() || !taskBrowser?.permitsGuest(windowId, params)) event.preventDefault(); });
  const rendererUrl = new URL(devUrl ?? `${APP_ORIGIN}/`);
  if (editorContext) rendererUrl.pathname = '/code-window';
  if (browserOnly) rendererUrl.pathname = '/browser-window';
  void window.loadURL(rendererUrl.href).catch((error: unknown) => {
    console.error('Could not load the renderer:', error);
    window.destroy();
  });
  return window;
}

async function registerRendererProtocol(): Promise<void> {
  const root = await realpath(rendererRoot);
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  };
  protocol.handle('app', async (request) => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const path = rendererPath(root, request.url);
    if (!path) return new Response(null, { status: 403 });
    try {
      const actual = await realpath(path);
      const child = relative(root, actual);
      if (child.startsWith('..') || isAbsolute(child)) return new Response(null, { status: 403 });
      const nonce = randomBytes(18).toString('base64');
      const bytes = await readFile(actual);
      const html = extname(actual) === '.html';
      const body = html ? bytes.toString('utf8').replaceAll('__ELEVENEX_NONCE__', nonce) : bytes;
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'Content-Type': mime[extname(actual)] ?? 'application/octet-stream',
          'Content-Security-Policy': contentSecurityPolicy().replaceAll('__ELEVENEX_NONCE__', nonce),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

void app.whenReady().then(async () => {
  // Pointer lock is needed only by the trusted streamed-page canvas. Website
  // guests and editor subframes keep their separate deny-by-default sessions.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    permission === 'pointerLock' && details.isMainFrame && isAppUrl(details.requestingUrl, devUrl) && trusted(contents.mainFrame, contents) && taskBrowser?.permitsPointerLock(contents.id) === true,
  ));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'pointerLock' && details.isMainFrame && !!details.requestingUrl && isAppUrl(details.requestingUrl, devUrl) && !!contents && trusted(contents.mainFrame, contents) && taskBrowser?.permitsPointerLock(contents.id) === true,
  );
  if (devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: {
        ...details.responseHeaders,
        ...(isAppUrl(details.url, devUrl) ? { 'Content-Security-Policy': [contentSecurityPolicy(devUrl)] } : {}),
        'X-Content-Type-Options': ['nosniff'],
      } });
    });
  } else {
    await registerRendererProtocol();
  }
  handle('app:version', trusted, () => app.getVersion());
  const unregisterClipboard = registerClipboardIpc(trusted);
  app.once('will-quit', unregisterClipboard);
  const unsubscribeBackend = registerBackendIpc(backend, trusted);
  app.once('will-quit', unsubscribeBackend);
  const unregisterCode = registerCodeIpc(code, trusted);
  app.once('will-quit', unregisterCode);
  taskBrowser = registerTaskBrowser(backendClient.client, remote, join(app.getPath('userData'), 'task-browsers'), trusted, () => createWindow(null, undefined, undefined, true));
  const unregisterClient = registerBackendClientIpc(backendClient.client, trusted, {
    get owner() { return terminals.owner; },
    track: (endpoint, engine) => terminals.track(endpoint, engine),
  }, terminalPreferences, app.isPackaged ? undefined : diagnostic => console.warn('Terminal stream interrupted:', diagnostic));
  const unregisterTerminalPorts = registerTerminalPorts(backendClient.client, remote, trusted, url => shell.openExternal(url), url => clipboard.writeText(url));
  app.once('will-quit', () => { unregisterClient(); unregisterTerminalPorts(); });
  const unregisterRemote = registerRemoteIpc(remote, backend, trusted);
  const unregisterMachines = registerMachineIpc(machines, trusted, selection => { if (windowsReady) createWindow(selection); });
  app.once('will-quit', unregisterMachines);
  const unsubscribeRemote = remote.subscribe((windowId, snapshot) => sendToWindow(windowId, 'environment:changed', snapshot));
  const resumed = () => remote.networkChanged();
  const stopRecoveryNotifications = notifyRecovery(remote);
  const stopNetwork = monitorNetwork(() => net.isOnline(), resumed);
  powerMonitor.on('resume', resumed);
  powerMonitor.on('unlock-screen', resumed);
  app.once('will-quit', () => { stopRecoveryNotifications(); stopNetwork(); unregisterRemote(); unsubscribeRemote(); powerMonitor.removeListener('resume', resumed); powerMonitor.removeListener('unlock-screen', resumed); });
  handle('git:status', trusted, (path) => {
    if (typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0')) {
      throw new Error('A nonempty workspace path is required');
    }
    return { path, branch: 'main', staged: [], modified: ['README.md'], untracked: [], mock: true };
  });
  nativeTheme.themeSource = 'system';
  nativeTheme.on('updated', () => broadcast('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => { if (windowsReady) createWindow(); } },
      { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
  ]));
  await Promise.all([state.load(), remote.load(), machinePreferences.load()]);
  windowsReady = true;
  disposeIdentity = installApplicationIdentity(() => {
    const window = BrowserWindow.getAllWindows()[0] ?? createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }, () => { createWindow(); });
  createWindow();
  // Window creation is independent of downloading: a future frontend can read
  // the current snapshot and subscribe immediately, including after a reload.
  void backend.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error(error);
  disposeIdentity?.();
  disposeIdentity = undefined;
  backendClient.dispose();
  machines.dispose();
  void terminals.close().then(() => Promise.allSettled([code.dispose(), backend.dispose(), remote.dispose(), remoteArchives.dispose(), machinePreferences.flush(), terminalPreferences.flush()])).then(() => app.exit(1));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void code.dispose().then(async () => { disposeIdentity?.(); disposeIdentity = undefined; backendClient.dispose(); machines.dispose(); taskBrowser?.dispose(); await terminals.close(); await Promise.allSettled([taskBrowser?.flush(), state.save(), backend.dispose(), remote.dispose(), remoteArchives.dispose(), machinePreferences.flush(), terminalPreferences.flush()]); app.quit(); }, async error => { quitting = false; await dialog.showMessageBox({ type: 'warning', message: 'Editor changes are still retained in the open window', detail: error instanceof Error ? error.message : 'Finish backing up your editor changes before quitting.', buttons: ['Keep open'] }); });
});
