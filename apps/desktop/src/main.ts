import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, protocol, session, shell, type WebContents, type WebFrameMain } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { broadcast, handle, sendToWindow } from './ipc';
import { APP_ORIGIN, contentSecurityPolicy, isAppUrl, isExternalUrl, rendererPath } from './security';
import { WindowStateStore } from './window-state';
import { createApplicationBackend } from './backend/application';
import { registerBackendIpc } from './backend/ipc';
import { RemoteManager } from './remote/manager';
import { registerRemoteIpc } from './remote/ipc';
import { readBackendRelease } from './backend/release';
import { homedir } from 'node:os';
import { RemoteArchiveCache } from './remote/archives';
import { createBackendClient } from './backend-client/application';
import { registerBackendClientIpc } from './backend-client/ipc';
import type { EnvironmentSelection } from '@elevenex/shared';
import { MachineApplication } from './machines/application';
import { MachinePreferences } from './machines/preferences';
import { registerMachineIpc } from './machines/ipc';

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
const remoteArchives = new RemoteArchiveCache(remoteRoot);
const remote = new RemoteManager({
  root: remoteRoot,
  prepareArchive: (release, signal, progress) => remoteArchives.prepare(release, signal, progress),
  settingsPath: join(app.getPath('userData'), 'remote-settings.json'),
  helper: app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked/dist/remote/askpass-helper.js') : join(__dirname, 'remote/askpass-helper.js'),
  release: () => readBackendRelease(__dirname),
});
const backendClient = createBackendClient(backend, remote,
  (windowId, snapshot) => sendToWindow(windowId, 'backend-client:changed', snapshot));
const machinePreferences = new MachinePreferences(join(app.getPath('userData'), 'machine-preferences.json'));
const machines = new MachineApplication(backend, remote, machinePreferences,
  (windowId, snapshot) => sendToWindow(windowId, 'machines:changed', snapshot));

// Several windows share one backend and database. A second application process
// must hand control to the first instead of starting another database owner.
const ownsInstance = app.requestSingleInstanceLock();
let windowsReady = false;
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

function createWindow(launchSelection?: EnvironmentSelection | null): BrowserWindow {
  const window = new BrowserWindow({
    ...state.options(),
    title: 'Elevenex',
    show: false,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { height: 48 } }),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  state.attach(window);
  // Home is passive on launch. Restore domain context when a machine is chosen,
  // but do not open a saved SSH host merely because the app started.
  remote.attach(window.webContents.id, launchSelection ?? null);
  const windowId = window.webContents.id;
  machines.attach(windowId, launchSelection ?? null);
  if (launchSelection) void remote.select(windowId, launchSelection).catch(() => {
    // The renderer can retry from Home; never abandon a newly created window.
    console.error('Could not select the requested machine');
  });
  backendClient.client.attach(windowId);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) backendClient.client.reset(windowId);
  });
  window.webContents.on('render-process-gone', () => backendClient.client.reset(windowId));
  window.once('closed', () => {
    machines.detach(windowId);
    backendClient.client.detach(windowId);
    void remote.detach(windowId).catch(() => console.error('Remote window cleanup failed'));
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, devUrl)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  // A redirect must never turn a trusted app window into an external site.
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, devUrl)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  void window.loadURL(devUrl ?? `${APP_ORIGIN}/`).catch((error: unknown) => {
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
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (devUrl) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy(devUrl)],
        'X-Content-Type-Options': ['nosniff'],
      } });
    });
  } else {
    await registerRendererProtocol();
  }
  handle('app:version', trusted, () => app.getVersion());
  const unsubscribeBackend = registerBackendIpc(backend, trusted);
  app.once('will-quit', unsubscribeBackend);
  const unregisterClient = registerBackendClientIpc(backendClient.client, trusted);
  app.once('will-quit', unregisterClient);
  const unregisterRemote = registerRemoteIpc(remote, backend, trusted);
  const unregisterMachines = registerMachineIpc(machines, trusted, selection => { if (windowsReady) createWindow(selection); });
  app.once('will-quit', unregisterMachines);
  const unsubscribeRemote = remote.subscribe((windowId, snapshot) => sendToWindow(windowId, 'environment:changed', snapshot));
  const resumed = () => remote.networkChanged();
  powerMonitor.on('resume', resumed);
  powerMonitor.on('unlock-screen', resumed);
  app.once('will-quit', () => { unregisterRemote(); unsubscribeRemote(); powerMonitor.removeListener('resume', resumed); powerMonitor.removeListener('unlock-screen', resumed); });
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
  createWindow();
  // Window creation is independent of downloading: a future frontend can read
  // the current snapshot and subscribe immediately, including after a reload.
  void backend.start();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error(error);
  backendClient.dispose();
  machines.dispose();
  void Promise.allSettled([backend.dispose(), remote.dispose(), remoteArchives.dispose(), machinePreferences.flush()]).then(() => app.exit(1));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  backendClient.dispose();
  machines.dispose();
  void Promise.allSettled([state.save(), backend.dispose(), remote.dispose(), remoteArchives.dispose(), machinePreferences.flush()]).then(() => app.quit());
});
