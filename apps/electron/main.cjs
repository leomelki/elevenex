const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const {
  buildRemoteInstallCommand,
  buildRemotePreflightScript,
  buildRemoteStartCommand,
  buildRemoteWaitForReadyCommand,
  getSuggestedInstallCommands,
  parseRemotePreflight,
  resolveRemoteRuntimeTarget,
  shellPathQuote,
  shellSingleQuote,
} = require('./remote-server-utils.cjs');

// Common install directories for user-facing binaries (tmux, claude, plannotator,
// cursor). macOS Electron apps launched from Finder/DMG get a stripped PATH
// because no shell rc files run — we extend it here once so every spawn
// (backend, ssh, cursor) inherits the richer PATH.
const COMMON_BINARY_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

function queryLoginShellEnv(variable) {
  const loginShell = process.env.SHELL || '/bin/zsh';
  try {
    const result = spawnSync(loginShell, ['-l', '-c', `printf %s "$${variable}"`], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through to empty string
  }
  return '';
}

function augmentedProcessPath() {
  const seen = new Set();
  const parts = [];
  const addPart = (part) => {
    if (part && !seen.has(part)) {
      seen.add(part);
      parts.push(part);
    }
  };

  const loginShellPath = queryLoginShellEnv('PATH');
  for (const part of loginShellPath.split(':')) addPart(part);
  for (const part of (process.env.PATH || '').split(':')) addPart(part);
  for (const part of COMMON_BINARY_PATHS) addPart(part);

  return parts.join(':');
}

// Augment PATH once at startup so every child process spawned by Electron
// (embedded backend, ssh forwards, cursor) sees user-installed binaries.
process.env.PATH = augmentedProcessPath();

// macOS Electron apps launched from Finder/DMG also lose LANG / LC_* because
// no shell rc files run. Without a UTF-8 locale, child processes (claude code,
// shells inside tmux) fall back to POSIX/ASCII and render multibyte glyphs as
// `_` or `?`. Pull the login shell's locale if set; otherwise default to a
// UTF-8 locale so terminals always render Unicode correctly.
function ensureUtf8Locale() {
  const hasUtf8 = (value) => typeof value === 'string' && /utf-?8/i.test(value);

  if (!hasUtf8(process.env.LC_ALL) && !hasUtf8(process.env.LANG) && !hasUtf8(process.env.LC_CTYPE)) {
    const shellLang = queryLoginShellEnv('LANG');
    const shellLcAll = queryLoginShellEnv('LC_ALL');
    const shellLcCtype = queryLoginShellEnv('LC_CTYPE');
    const inherited = [shellLcAll, shellLang, shellLcCtype].find(hasUtf8);
    const fallback = inherited || 'en_US.UTF-8';
    if (!process.env.LANG) process.env.LANG = fallback;
    if (!process.env.LC_CTYPE) process.env.LC_CTYPE = fallback;
  }
}

ensureUtf8Locale();

const proxyPort = process.env.ELEVENEX_PROXY_PORT || process.env.FRONTEND_PORT || '11111';
const defaultBackendUrl = process.env.ELECTRON_BACKEND_URL || `http://127.0.0.1:${proxyPort}`;
const defaultFrontendUrl = process.env.ELECTRON_FRONTEND_URL || '';
let currentBackendUrl = defaultBackendUrl;
const debugFrontend = process.env.ELECTRON_DEBUG_FRONTEND === '1';
const EMBEDDED_BACKEND_READY_TIMEOUT_MS = 20000;
const EMBEDDED_BACKEND_READY_POLL_INTERVAL_MS = 250;
const APP_DISPLAY_NAME = 'Elevenex';
const SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 4000;
const RUNTIME_RELEASE_BASE = process.env.ELEVENEX_RUNTIME_RELEASE_BASE
  || 'https://github.com/leomelki/elevenex/releases/download';
const CHILD_PROCESS_KILL_TIMEOUT_MS = 1500;

let mainWindow = null;
let settingsWindow = null;
let installWindow = null;
const browserViews = new Map();
let attachedBrowserKey = null;
const sshForwardRuntimes = new Map();
const remoteInstallerSessions = new Map();
let nextRemoteInstallerSessionId = 1;
let embeddedBackendRuntime = null;
let isAppQuitting = false;
let isReloadingMainWindow = false;
let hasRunShutdownCleanup = false;
let shutdownForceExitTimer = null;

app.setName(APP_DISPLAY_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_DISPLAY_NAME));

function findExistingPath(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function getAppIconPath() {
  return findExistingPath([
    path.join(__dirname, '..', '..', '11x.png'),
    path.join(__dirname, '11x.png'),
    path.join(process.resourcesPath, '11x.png'),
  ]);
}

function getMacAppIconPath() {
  return findExistingPath([
    path.join(__dirname, 'assets', 'macos-runtime-icon.png'),
    path.join(process.resourcesPath, 'assets', 'macos-runtime-icon.png'),
  ]);
}

function emitMainWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('elevenex-window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  });
}

function getMacAppIcon() {
  const macAppIconPath = getMacAppIconPath();
  if (!existsSync(macAppIconPath)) {
    return null;
  }

  const icon = nativeImage.createFromPath(macAppIconPath);
  if (icon.isEmpty()) {
    return null;
  }

  return icon;
}

// --- Browser isolation ---
const SHARED_PARTITION = 'persist:elevenex-browser';
const SSH_FORWARD_CONFIG_EXCLUDED_OPTIONS = new Set([
  'clearallforwardings',
  'dynamicforward',
  'exitonforwardfailure',
  'forkafterauthentication',
  'localcommand',
  'localforward',
  'permitlocalcommand',
  'remotecommand',
  'requesttty',
  'sessiontype',
  'stdinnull',
  'streamlocalbindmask',
  'streamlocalbindunlink',
  'tunnel',
  'tunneldevice',
]);
const SSH_FORWARD_PROBE_TIMEOUT_MS = 1800;

function getLocalFrontendEntry() {
  return findExistingPath([
    path.join(__dirname, '..', 'frontend', 'dist', 'frontend', 'browser', 'index.html'),
    path.join(__dirname, 'frontend', 'dist', 'frontend', 'browser', 'index.html'),
  ]);
}

function getPackagedRuntimeRoot() {
  return path.join(os.homedir(), '.elevenex', 'runtime');
}

function getRemoteRuntimeVersion() {
  return getBundledVersion();
}

function getPackagedRuntimeMarkerPath() {
  return path.join(getPackagedRuntimeRoot(), '.install-complete');
}

function getBundledVersionPath() {
  if (!app.isPackaged) {
    return path.join(__dirname, '.stage', 'version');
  }
  return path.join(process.resourcesPath, 'version');
}

function getRuntimeVersionPath() {
  return path.join(getPackagedRuntimeRoot(), 'version');
}

function getBundledVersion() {
  try {
    return readFileSync(getBundledVersionPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

function getRuntimeVersion() {
  try {
    return readFileSync(getRuntimeVersionPath(), 'utf8').trim();
  } catch {
    return null;
  }
}

function runtimeVersionNeedsUpdate() {
  const bundledVersion = getBundledVersion();
  if (!bundledVersion) {
    return false;
  }
  const runtimeVersion = getRuntimeVersion();
  return runtimeVersion !== bundledVersion;
}

const PLATFORM_TARGET_NAMES = { darwin: 'macos', linux: 'linux', win32: 'windows' };

function getLocalRuntimeTarget() {
  const platformName = PLATFORM_TARGET_NAMES[process.platform] || process.platform;
  return `${platformName}-${process.arch}`;
}

function buildLocalRuntimeDownloadUrl(version) {
  if (!version) {
    return null;
  }
  if (!/^[a-f0-9]{7,64}$/i.test(version) && !/^v?\d+\.\d+\.\d+/.test(version)) {
    return null;
  }
  const targetKey = getLocalRuntimeTarget();
  return `${RUNTIME_RELEASE_BASE}/runtime-${version}/elevenex-runtime-${targetKey}.tar.gz`;
}

function getEmbeddedBackendRoot() {
  if (!app.isPackaged) {
    return path.join(process.resourcesPath, 'backend');
  }

  return path.join(getPackagedRuntimeRoot(), 'backend');
}

function getEmbeddedBackendEntry() {
  return path.join(getEmbeddedBackendRoot(), 'main.cjs');
}

function getPackagedDatabasePath() {
  return path.join(os.homedir(), '.elevenex', 'elevenex.db');
}

function closeInstallWindow() {
  if (!installWindow || installWindow.isDestroyed()) {
    installWindow = null;
    return;
  }

  const currentInstallWindow = installWindow;
  installWindow = null;

  try {
    currentInstallWindow.removeAllListeners('closed');
    currentInstallWindow.hide();
  } catch {
    // Ignore best-effort teardown errors.
  }

  try {
    currentInstallWindow.destroy();
  } catch {
    // Ignore best-effort teardown errors.
  }
}

function closeAuxiliaryWindows() {
  const auxiliaryWindows = [settingsWindow, installWindow];

  settingsWindow = null;
  installWindow = null;

  for (const currentWindow of auxiliaryWindows) {
    if (!currentWindow || currentWindow.isDestroyed()) {
      continue;
    }

    currentWindow.destroy();
  }
}

function clearShutdownForceExitTimer() {
  if (shutdownForceExitTimer) {
    clearTimeout(shutdownForceExitTimer);
    shutdownForceExitTimer = null;
  }
}

function scheduleShutdownForceExit() {
  if (shutdownForceExitTimer) {
    return;
  }

  shutdownForceExitTimer = setTimeout(() => {
    try {
      closeAuxiliaryWindows();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    } catch {
      // Ignore best-effort window teardown errors.
    }

    app.exit(0);
  }, SHUTDOWN_FORCE_EXIT_TIMEOUT_MS);

  if (typeof shutdownForceExitTimer.unref === 'function') {
    shutdownForceExitTimer.unref();
  }
}

function terminateChildProcess(childProcess, graceMs = CHILD_PROCESS_KILL_TIMEOUT_MS) {
  if (!childProcess || childProcess.exitCode !== null || childProcess.killed) {
    return;
  }

  try {
    childProcess.kill('SIGTERM');
  } catch {
    return;
  }

  const killTimer = setTimeout(() => {
    if (childProcess.exitCode === null && !childProcess.killed) {
      try {
        childProcess.kill('SIGKILL');
      } catch {
        // Ignore best-effort kill errors.
      }
    }
  }, graceMs);

  if (typeof killTimer.unref === 'function') {
    killTimer.unref();
  }
}

function runShutdownCleanup() {
  if (hasRunShutdownCleanup) {
    return;
  }

  hasRunShutdownCleanup = true;
  scheduleShutdownForceExit();
  closeAuxiliaryWindows();

  for (const browserKey of Array.from(browserViews.keys())) {
    destroyBrowserView(browserKey);
  }

  for (const id of sshForwardRuntimes.keys()) {
    void stopSshForwardRuntime(id);
  }

  for (const sessionId of Array.from(remoteInstallerSessions.keys())) {
    destroyRemoteInstallerSession(sessionId);
  }

  stopEmbeddedBackend();
}

function requestAppQuit() {
  if (isAppQuitting) {
    return;
  }

  isAppQuitting = true;
  scheduleShutdownForceExit();
  app.quit();
}

function openInstallWindow({
  title = 'Installing Elevenex Runtime',
  eyebrow = 'Preparing Runtime',
  heading = 'Installing Elevenex components',
  description = 'Elevenex is downloading and installing its local runtime. This happens once per version and may take a moment.',
  status = '',
} = {}) {
  if (installWindow && !installWindow.isDestroyed()) {
    updateInstallProgress({ status });
    return installWindow;
  }

  installWindow = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: false,
    show: false,
    center: true,
    backgroundColor: '#0d1117',
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  installWindow.once('ready-to-show', () => installWindow?.show());
  installWindow.on('closed', () => {
    installWindow = null;
  });
  installWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 46%),
          linear-gradient(180deg, #10151d 0%, #0b0f14 100%);
        color: #f3f4f6;
      }
      .card {
        width: min(320px, calc(100vw - 48px));
        padding: 28px 26px;
        border-radius: 20px;
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.18);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      }
      .eyebrow {
        margin-bottom: 10px;
        font-size: 11px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: #7dd3fc;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 20px;
        line-height: 1.2;
      }
      p {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: #cbd5e1;
      }
      .status {
        margin-top: 6px;
        font-size: 12px;
        color: #94a3b8;
        min-height: 1.4em;
      }
      .progress {
        position: relative;
        overflow: hidden;
        margin-top: 12px;
        height: 6px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.18);
      }
      .progress-fill {
        position: absolute;
        inset: 0;
        width: 0%;
        border-radius: inherit;
        background: linear-gradient(90deg, #38bdf8 0%, #22c55e 100%);
        transition: width 0.3s ease;
      }
      .progress.indeterminate .progress-fill {
        width: 38%;
        animation: loading 1.1s ease-in-out infinite;
      }
      @keyframes loading {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(320%); }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">${escapeHtml(eyebrow)}</div>
      <h1>${escapeHtml(heading)}</h1>
      <p>${escapeHtml(description)}</p>
      <div class="status" id="status">${escapeHtml(status)}</div>
      <div class="progress indeterminate" id="progress" role="progressbar" aria-label="${escapeHtml(heading)}"><div class="progress-fill" id="fill"></div></div>
    </main>
  </body>
</html>`)}`);

  return installWindow;
}

function escapeHtml(value) {
  return `${value ?? ''}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateInstallProgress({ status, percent }) {
  if (!installWindow || installWindow.isDestroyed()) {
    return;
  }
  const js = percent != null
    ? `document.getElementById('progress').classList.remove('indeterminate');document.getElementById('progress').setAttribute('aria-valuenow','${percent}');document.getElementById('progress').setAttribute('aria-valuemin','0');document.getElementById('progress').setAttribute('aria-valuemax','100');document.getElementById('fill').style.width='${percent}%';document.getElementById('status').textContent=${JSON.stringify(status || '')};`
    : `document.getElementById('progress').classList.add('indeterminate');document.getElementById('progress').removeAttribute('aria-valuenow');document.getElementById('progress').removeAttribute('aria-valuemin');document.getElementById('progress').removeAttribute('aria-valuemax');document.getElementById('fill').style.width='';document.getElementById('status').textContent=${JSON.stringify(status || '')};`;
  installWindow.webContents.executeJavaScript(js).catch(() => {});
}

const MAX_DOWNLOAD_REDIRECTS = 5;
const PROGRESS_THROTTLE_MS = 150;

function downloadToFile(url, destinationPath, onProgress, _redirectCount = 0) {
  if (_redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    const file = createWriteStream(destinationPath);
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        rmSync(destinationPath, { force: true });
        reject(error);
      });
    };

    const get = url.startsWith('https') ? https.get : http.get;

    get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        file.close();
        rmSync(destinationPath, { force: true });
        downloadToFile(response.headers.location, destinationPath, onProgress, _redirectCount + 1)
          .then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Download failed (HTTP ${response.statusCode}): ${url}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
      let receivedBytes = 0;
      let lastProgressAt = 0;

      if (onProgress && totalBytes > 0) {
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS || receivedBytes >= totalBytes) {
            lastProgressAt = now;
            onProgress(receivedBytes, totalBytes);
          }
        });
      }

      response.on('error', fail);
      response.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(resolve);
      });
      file.on('error', fail);
    }).on('error', fail);
  });
}

const NATIVE_BINARY_EXTENSIONS = ['.node', '.dylib'];
const NATIVE_EXECUTABLE_NAMES = ['spawn-helper'];

function resignNativeBinaries(dir) {
  if (!existsSync(dir)) {
    return;
  }

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      resignNativeBinaries(fullPath);
      continue;
    }

    const isNative = NATIVE_BINARY_EXTENSIONS.includes(path.extname(entry))
      || NATIVE_EXECUTABLE_NAMES.includes(entry);

    if (isNative) {
      spawnSync('codesign', ['--sign', '-', '--force', '--timestamp=none', fullPath], {
        stdio: 'ignore',
      });
    }
  }
}

async function ensureEmbeddedBackendExtracted() {
  const embeddedBackendEntry = getEmbeddedBackendEntry();
  const runtimeRoot = getPackagedRuntimeRoot();
  const runtimeMarkerPath = getPackagedRuntimeMarkerPath();
  const hasRuntimeMarker = existsSync(runtimeMarkerPath);
  const needsVersionUpdate = runtimeVersionNeedsUpdate();

  if (!needsVersionUpdate && hasRuntimeMarker && existsSync(embeddedBackendEntry)) {
    return;
  }

  const bundledVersion = getBundledVersion();
  const downloadUrl = buildLocalRuntimeDownloadUrl(bundledVersion);
  if (!downloadUrl) {
    throw new Error('Cannot resolve runtime download URL — bundled version is missing.');
  }

  if (existsSync(runtimeRoot) && (needsVersionUpdate || !hasRuntimeMarker || !existsSync(embeddedBackendEntry))) {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }

  mkdirSync(runtimeRoot, { recursive: true });
  openInstallWindow();

  const archivePath = path.join(runtimeRoot, 'runtime.tar.gz');

  try {
    updateInstallProgress({ status: 'Downloading runtime…', percent: 0 });

    await downloadToFile(downloadUrl, archivePath, (received, total) => {
      const percent = Math.min(Math.round((received / total) * 100), 100);
      updateInstallProgress({ status: `Downloading… ${formatBytes(received)} / ${formatBytes(total)}`, percent });
    });

    updateInstallProgress({ status: 'Extracting runtime…' });

    const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', runtimeRoot], {
      stdio: 'pipe',
    });

    if (extracted.error) {
      throw extracted.error;
    }

    if (extracted.status !== 0) {
      throw new Error(
        (extracted.stderr || extracted.stdout || `tar exited with code ${extracted.status ?? 'unknown'}`)
          .toString()
          .trim(),
      );
    }

    if (process.platform === 'darwin') {
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', runtimeRoot], { stdio: 'ignore' });
      resignNativeBinaries(path.join(runtimeRoot, 'backend', 'node_modules'));
    }

    if (bundledVersion) {
      writeFileSync(getRuntimeVersionPath(), `${bundledVersion}\n`, 'utf8');
    }

    writeFileSync(runtimeMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archivePath, { force: true });
    closeInstallWindow();
  }
}

function hasExplicitBackendOverride(settings = readSettings()) {
  return Boolean(process.env.ELECTRON_BACKEND_URL || settings.backendUrl.trim());
}

function hasExplicitFrontendOverride(settings = readSettings()) {
  return Boolean(process.env.ELECTRON_FRONTEND_URL || settings.frontendUrl.trim());
}

function shouldUseEmbeddedBackend(settings = readSettings()) {
  if (!app.isPackaged) {
    return false;
  }

  if (debugFrontend || hasExplicitBackendOverride(settings) || hasExplicitFrontendOverride(settings)) {
    return false;
  }

  if (!existsSync(getLocalFrontendEntry())) {
    return false;
  }

  return getBundledVersion() !== null || existsSync(getEmbeddedBackendEntry());
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackendReady(backendUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const isReady = await new Promise((resolve) => {
      const request = http.get(`${backendUrl}/api`, (response) => {
        response.resume();
        resolve(true);
      });

      request.on('error', () => resolve(false));
      request.setTimeout(1000, () => {
        request.destroy();
        resolve(false);
      });
    });

    if (isReady) {
      return;
    }

    await wait(EMBEDDED_BACKEND_READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Embedded backend did not become ready within ${timeoutMs}ms`);
}

async function startEmbeddedBackend(backendUrl) {
  if (embeddedBackendRuntime) {
    return embeddedBackendRuntime.ready;
  }

  const embeddedBackendRoot = getEmbeddedBackendRoot();
  await ensureEmbeddedBackendExtracted();
  const embeddedBackendEntry = getEmbeddedBackendEntry();

  if (!existsSync(embeddedBackendEntry)) {
    throw new Error(`Embedded backend entrypoint not found at ${embeddedBackendEntry}`);
  }

  const packagedDatabasePath = getPackagedDatabasePath();
  mkdirSync(path.dirname(packagedDatabasePath), { recursive: true });
  openInstallWindow({
    title: 'Starting Elevenex Runtime',
    eyebrow: 'Starting Runtime',
    heading: 'Starting local runtime',
    description: 'Elevenex is launching its local services. The workspace will open as soon as they are ready.',
    status: 'Launching backend services...',
  });

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ELEVENEX_BACKEND_RUNTIME_ROOT: embeddedBackendRoot,
    DB_PATH: packagedDatabasePath,
    ELEVENEX_PROXY_PORT: proxyPort,
    FRONTEND_PORT: proxyPort,
  };

  const child = spawn(process.execPath, [embeddedBackendEntry], {
    cwd: embeddedBackendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuffer = '';

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[embedded-backend] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer = `${stderrBuffer}${text}`.slice(-4000);
    process.stderr.write(`[embedded-backend] ${text}`);
  });

  const ready = waitForBackendReady(backendUrl, EMBEDDED_BACKEND_READY_TIMEOUT_MS).catch((error) => {
    terminateChildProcess(child);
    closeInstallWindow();

    const details = stderrBuffer.trim();
    throw new Error(details ? `${error.message}\n\n${details}` : error.message);
  });

  embeddedBackendRuntime = { child, ready };

  child.once('exit', () => {
    embeddedBackendRuntime = null;
  });

  return ready;
}

function stopEmbeddedBackend() {
  if (!embeddedBackendRuntime?.child || embeddedBackendRuntime.child.killed) {
    return;
  }

  terminateChildProcess(embeddedBackendRuntime.child);
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeUrl(value) {
  const trimmed = `${value || ''}`.trim();
  if (!trimmed) {
    return '';
  }

  const url = new URL(trimmed);
  return url.toString().replace(/\/$/, '');
}

function readSettings() {
  try {
    const file = readFileSync(getSettingsPath(), 'utf8');
    const parsed = JSON.parse(file);
    return {
      backendUrl: typeof parsed.backendUrl === 'string' ? parsed.backendUrl : '',
      frontendUrl: typeof parsed.frontendUrl === 'string' ? parsed.frontendUrl : '',
    };
  } catch {
    return {
      backendUrl: '',
      frontendUrl: '',
    };
  }
}

function writeSettings(nextSettings) {
  const settingsPath = getSettingsPath();
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2));
}

function resolveAppTargets() {
  const settings = readSettings();
  const useEmbeddedBackend = shouldUseEmbeddedBackend(settings);
  const backendUrl = settings.backendUrl || defaultBackendUrl;
  const frontendUrl = settings.frontendUrl || defaultFrontendUrl;

  return {
    backendUrl,
    frontendUrl,
    effectiveFrontendUrl: frontendUrl || null,
    useEmbeddedBackend,
  };
}

function getRuntimeMode(frontendTarget) {
  if (frontendTarget.kind === 'file') {
    return 'electron-local';
  }

  if (debugFrontend) {
    return 'electron-debug';
  }

  return 'browser';
}

function getFrontendTarget() {
  const targets = resolveAppTargets();
  if (targets.effectiveFrontendUrl) {
    return {
      kind: 'url',
      value: targets.effectiveFrontendUrl,
      backendUrl: targets.backendUrl,
      useEmbeddedBackend: false,
    };
  }

  if (debugFrontend) {
    return {
      kind: 'url',
      value: targets.backendUrl,
      backendUrl: targets.backendUrl,
      useEmbeddedBackend: false,
    };
  }

  const localEntry = getLocalFrontendEntry();
  if (existsSync(localEntry)) {
    return {
      kind: 'file',
      value: localEntry,
      backendUrl: targets.backendUrl,
      useEmbeddedBackend: targets.useEmbeddedBackend,
    };
  }

  return {
    kind: 'url',
    value: targets.backendUrl,
    backendUrl: targets.backendUrl,
    useEmbeddedBackend: false,
  };
}

function normalizeBrowserUrl(value) {
  const trimmed = `${value || ''}`.trim();

  if (!trimmed) {
    return 'about:blank';
  }

  if (trimmed === 'about:blank') {
    return trimmed;
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported');
  }

  return url.toString();
}

function toSshRuntimeView(id, runtime) {
  if (!runtime) {
    return {
      id,
      status: 'inactive',
      installStatus: 'unknown',
      pid: null,
      startedAt: null,
      stoppedAt: null,
      lastError: null,
      debugDetails: null,
    };
  }

  return {
    id,
    status: runtime.status,
    installStatus: runtime.installStatus ?? 'unknown',
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastError: runtime.error,
    debugDetails: runtime.debugDetails,
  };
}

function buildResolvedSshConfig(forward) {
  const resolveArgs = ['-G', '-p', String(forward.sshPort)];

  if (forward.sshUser) {
    resolveArgs.push('-l', forward.sshUser);
  }

  if (forward.authMode === 'key' && forward.identityFilePath) {
    resolveArgs.push('-o', 'IdentitiesOnly=yes');
    resolveArgs.push('-o', `IdentityFile=${forward.identityFilePath}`);
  }

  resolveArgs.push(forward.sshHost);

  const resolved = spawnSync('ssh', resolveArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (resolved.error) {
    throw resolved.error;
  }

  if (resolved.status !== 0) {
    throw new Error(
      (resolved.stderr || resolved.stdout || `ssh -G exited with code ${resolved.status ?? 'unknown'}`).trim(),
    );
  }

  const configLines = [];
  let resolvedHostname = '';
  for (const rawLine of resolved.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(' ');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'hostname') {
      resolvedHostname = value;
    }
    if (!value || SSH_FORWARD_CONFIG_EXCLUDED_OPTIONS.has(key)) {
      continue;
    }

    configLines.push(`  ${line}`);
  }

  if (!configLines.some((line) => line.startsWith('  hostname '))) {
    throw new Error(`Unable to resolve SSH host "${forward.sshHost}"`);
  }

  // Keep user-defined RemoteForward/StreamLocalForward entries (e.g. forwarded
  // gpg-agent sockets used for commit signing), but neutralise the surrounding
  // strictness so a stale socket or one already bound by another muxed session
  // never tears down elevenex's tunnel.
  configLines.push('  ExitOnForwardFailure no');
  configLines.push('  StreamLocalBindUnlink yes');

  if (forward.authMode === 'password') {
    configLines.push('  PreferredAuthentications password,keyboard-interactive');
    configLines.push('  PubkeyAuthentication no');
  }

  if (forward.authMode === 'key' && forward.identityFilePath) {
    configLines.push(`  IdentityFile ${forward.identityFilePath}`);
    configLines.push('  IdentitiesOnly yes');
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'elevenex-ssh-forward-'));
  const configPath = path.join(tempDir, 'config');
  writeFileSync(
    configPath,
    [`Host ${forward.sshHost}`, ...configLines, ''].join('\n'),
    'utf8',
  );

  return {
    configPath,
    tempDir,
    resolveArgs,
  };
}

function createSshAskPassRuntime(forward) {
  const secret = forward.authMode === 'password'
    ? forward.password
    : forward.passphrase;
  if (!secret) {
    return null;
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'elevenex-ssh-askpass-'));
  const scriptPath = path.join(tempDir, 'askpass.sh');
  writeFileSync(
    scriptPath,
    '#!/bin/sh\nprintf \'%s\\n\' "$ELEVENEX_SSH_ASKPASS_SECRET"\n',
    'utf8',
  );
  chmodSync(scriptPath, 0o700);

  return {
    tempDir,
    scriptPath,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':0',
      SSH_ASKPASS: scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
      ELEVENEX_SSH_ASKPASS_SECRET: secret,
    },
  };
}

function cleanupSshArtifacts(runtime) {
  const tempDirs = [runtime?.resolvedConfig?.tempDir, runtime?.askPass?.tempDir];
  if (tempDirs.every((tempDir) => !tempDir)) {
    return;
  }

  for (const tempDir of tempDirs) {
    if (!tempDir) {
      continue;
    }

    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for temporary SSH assets.
    }
  }

  runtime.resolvedConfig = null;
  runtime.askPass = null;
}

function buildSshTarget(forward) {
  return forward.sshHost;
}

function getSshBaseArgs(resolvedConfig, target) {
  return ['-F', resolvedConfig.configPath, target];
}

function runSshCommandAsync(forward, command) {
  return new Promise((resolve, reject) => {
    const resolvedConfig = buildResolvedSshConfig(forward);
    const askPass = createSshAskPassRuntime(forward);
    const target = buildSshTarget(forward);
    const baseArgs = getSshBaseArgs(resolvedConfig, target);
    const sshArgs = [...baseArgs, 'sh', '-lc', shellSingleQuote(command)];

    let child;
    try {
      child = spawn('ssh', sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: askPass?.env ?? process.env,
      });
    } catch (error) {
      cleanupSshArtifacts({ resolvedConfig, askPass });
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.once('exit', (code) => {
      cleanupSshArtifacts({ resolvedConfig, askPass });
      if (code !== 0) {
        reject(new Error((stderr || stdout || `ssh exited with code ${code ?? 'unknown'}`).trim()));
      } else {
        resolve({ stdout, stderr, args: sshArgs, resolveArgs: resolvedConfig.resolveArgs });
      }
    });

    child.once('error', (error) => {
      cleanupSshArtifacts({ resolvedConfig, askPass });
      reject(error);
    });
  });
}

function runSshCommand(forward, command, options = {}) {
  const resolvedConfig = buildResolvedSshConfig(forward);
  const askPass = createSshAskPassRuntime(forward);
  const target = buildSshTarget(forward);
  const baseArgs = getSshBaseArgs(resolvedConfig, target);
  const sshArgs = [
    ...baseArgs,
    'sh',
    '-lc',
    shellSingleQuote(command),
  ];

  try {
    const result = spawnSync('ssh', sshArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: askPass?.env ?? process.env,
      ...options,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `ssh exited with code ${result.status ?? 'unknown'}`).trim());
    }

    return {
      stdout: `${result.stdout || ''}`,
      stderr: `${result.stderr || ''}`,
      args: sshArgs,
      resolveArgs: resolvedConfig.resolveArgs,
    };
  } finally {
    cleanupSshArtifacts({ resolvedConfig, askPass });
  }
}

function emitRemoteInstallerEvent(sessionId, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('elevenex-remote-server:installer-event', {
    sessionId,
    ...payload,
  });
}

function destroyRemoteInstallerSession(sessionId) {
  const existing = remoteInstallerSessions.get(sessionId);
  if (!existing) {
    return;
  }

  terminateChildProcess(existing.process);

  cleanupSshArtifacts(existing);
  remoteInstallerSessions.delete(sessionId);
  emitRemoteInstallerEvent(sessionId, { type: 'closed' });
}

function destroyRemoteInstallerSessionForServer(serverId) {
  const existing = Array.from(remoteInstallerSessions.values())
    .find((session) => session.serverId === serverId);
  if (!existing) {
    return;
  }

  destroyRemoteInstallerSession(existing.id);
}

function createRemoteInstallerSession(forward, preflight) {
  const existing = Array.from(remoteInstallerSessions.values()).find((session) => session.serverId === forward.id);
  if (existing) {
    existing.preflight = preflight;
    return existing;
  }

  const resolvedConfig = buildResolvedSshConfig(forward);
  const askPass = createSshAskPassRuntime(forward);
  const sessionId = nextRemoteInstallerSessionId++;
  const target = buildSshTarget(forward);
  const sshArgs = [
    '-tt',
    '-F',
    resolvedConfig.configPath,
    target,
  ];
  const child = spawn('ssh', sshArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: askPass?.env ?? process.env,
  });

  const sessionState = {
    id: sessionId,
    serverId: forward.id,
    forward,
    process: child,
    resolvedConfig,
    askPass,
    preflight,
  };
  remoteInstallerSessions.set(sessionId, sessionState);

  child.stdout.on('data', (chunk) => {
    emitRemoteInstallerEvent(sessionId, {
      type: 'data',
      data: chunk.toString(),
    });
  });
  child.stderr.on('data', (chunk) => {
    emitRemoteInstallerEvent(sessionId, {
      type: 'data',
      data: chunk.toString(),
    });
  });
  child.once('exit', (code, signal) => {
    cleanupSshArtifacts(sessionState);
    remoteInstallerSessions.delete(sessionId);
    emitRemoteInstallerEvent(sessionId, {
      type: 'exit',
      code: code ?? null,
      signal: signal ?? null,
    });
  });
  child.once('error', (error) => {
    emitRemoteInstallerEvent(sessionId, {
      type: 'error',
      message: error.message,
    });
  });

  return sessionState;
}

function getRemoteInstallStatus(preflight, bundledVersion) {
  if (!['linux', 'darwin'].includes(preflight.remotePlatform)) {
    return 'unsupported-os';
  }

  if (!preflight.remoteTarget) {
    return 'unsupported-os';
  }

  if (preflight.missingDependencies.length > 0) {
    return 'missing-prereqs';
  }

  if (!preflight.currentVersion) {
    return 'missing';
  }

  if (bundledVersion && preflight.currentVersion !== bundledVersion) {
    return 'needs-update';
  }

  return 'available';
}

function toRemoteEnsureReadyResult(forward, preflight, overrides = {}) {
  const bundledVersion = typeof overrides.bundledVersion === 'string'
    ? overrides.bundledVersion
    : getRemoteRuntimeVersion();
  const installStatus = overrides.installStatus || getRemoteInstallStatus(preflight, bundledVersion);
  const suggestedCommands = getSuggestedInstallCommands(
    preflight.osRelease || {},
    preflight.remotePlatform,
  );
  return {
    status: overrides.status || 'error',
    installPhase: overrides.installPhase || 'checking',
    installStatus,
    remotePlatform: preflight.remotePlatform,
    remoteArch: preflight.remoteArch,
    missingDependencies: [...(preflight.missingDependencies || [])],
    message: overrides.message || '',
    localPort: overrides.localPort ?? null,
    sessionId: overrides.sessionId ?? null,
    osRelease: preflight.osRelease || {},
    suggestedCommands,
    version: bundledVersion || null,
  };
}

function buildRemoteRuntimeDownloadUrl(version, targetKey) {
  if (!version || !targetKey) {
    return null;
  }
  if (!/^[a-f0-9]{7,64}$/i.test(version) && !/^v?\d+\.\d+\.\d+/.test(version)) {
    return null;
  }
  return `${RUNTIME_RELEASE_BASE}/runtime-${version}/elevenex-remote-runtime-${targetKey}.tar.gz`;
}

function buildDownloadScript(url, remoteDestination) {
  const safeUrl = url.replace(/'/g, `'\\''`);
  return [
    'set -eu',
    `URL='${safeUrl}'`,
    `DEST=${shellPathQuote(remoteDestination)}`,
    'TMP="$DEST.partial"',
    'rm -f "$TMP"',
    'if command -v curl >/dev/null 2>&1; then',
    '  curl -fsSL --connect-timeout 5 --max-time 600 -o "$TMP" "$URL" || exit 2',
    'elif command -v wget >/dev/null 2>&1; then',
    '  wget -q --connect-timeout=5 --timeout=600 -O "$TMP" "$URL" || exit 2',
    'else',
    '  exit 3',
    'fi',
    'mv "$TMP" "$DEST"',
  ].join('\n');
}

function tryRemoteDownload(forward, url, remoteDestination) {
  try {
    runSshCommand(forward, buildDownloadScript(url, remoteDestination));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.warn(`[remote-runtime] download from ${url} failed: ${message.split('\n')[0]}`);
    return false;
  }
}

async function tryRemoteDownloadAsync(forward, url, remoteDestination) {
  try {
    await runSshCommandAsync(forward, buildDownloadScript(url, remoteDestination));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.warn(`[remote-runtime] download from ${url} failed: ${message.split('\n')[0]}`);
    return false;
  }
}

function emitRemoteServerPhaseEvent(serverId, phase) {
  console.info('[remote-runtime] phase', { serverId, phase });
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('elevenex-remote-server:phase-update', { serverId, phase });
}

async function ensureRemoteServerReady(forward) {
  const bundledVersion = getRemoteRuntimeVersion();
  if (!bundledVersion) {
    throw new Error('Remote runtime version is unavailable.');
  }

  console.info('[remote-runtime] ensure ready', {
    serverId: forward.id,
    host: forward.sshHost,
    localPort: forward.localPort,
    remotePort: forward.remotePort,
    bundledVersion,
  });
  emitRemoteServerPhaseEvent(forward.id, 'checking');
  const preflightResult = await runSshCommandAsync(forward, buildRemotePreflightScript(forward.remotePort || 11111));
  const preflight = parseRemotePreflight(preflightResult.stdout);
  console.info('[remote-runtime] preflight result', {
    serverId: forward.id,
    remotePlatform: preflight.remotePlatform,
    remoteArch: preflight.remoteArch,
    remoteTarget: preflight.remoteTarget,
    currentVersion: preflight.currentVersion,
    runningBackendVersion: preflight.runningBackendVersion,
    backendReachable: preflight.backendReachable,
    tmuxSessionPresent: preflight.tmuxSessionPresent,
    missingDependencies: preflight.missingDependencies,
  });

  if (!['linux', 'darwin'].includes(preflight.remotePlatform)) {
    return toRemoteEnsureReadyResult(forward, preflight, {
      status: 'unsupported',
      installPhase: 'checking',
      message: `Remote OS ${preflight.remotePlatform || 'unknown'} is not supported yet. Linux or macOS is required for auto-install.`,
      bundledVersion,
    });
  }

  if (!preflight.remoteTarget) {
    return toRemoteEnsureReadyResult(forward, preflight, {
      status: 'unsupported',
      installPhase: 'checking',
      message: `Remote architecture ${preflight.remoteArch || 'unknown'} is not supported yet.`,
      bundledVersion,
    });
  }

  if (preflight.missingDependencies.length > 0) {
    const session = createRemoteInstallerSession(forward, preflight);
    return toRemoteEnsureReadyResult(forward, preflight, {
      status: 'waiting-for-user',
      installPhase: 'missing-prereqs',
      message: `Install the missing dependencies on ${forward.sshHost}, then re-check.`,
      sessionId: session.id,
      bundledVersion,
    });
  }

  const installStatus = getRemoteInstallStatus(preflight, bundledVersion);
  const runningVersionMismatch = Boolean(
    bundledVersion
    && preflight.backendReachable
    && preflight.runningBackendVersion !== bundledVersion,
  );
  const needsRuntimeRestart = installStatus === 'missing'
    || installStatus === 'needs-update'
    || !preflight.backendReachable
    || runningVersionMismatch;
  const remoteArchivePath = `~/.elevenex/tmp/elevenex-${bundledVersion}-${preflight.remoteTarget}.tar.gz`;
  const remoteReleaseDir = `~/.elevenex/releases/${bundledVersion}-${preflight.remoteTarget}`;
  const remoteCurrentLink = '~/.elevenex/current';
  const remoteCurrentRoot = '~/.elevenex/current';

  if (installStatus === 'missing' || installStatus === 'needs-update') {
    emitRemoteServerPhaseEvent(forward.id, 'uploading');
    await runSshCommandAsync(forward, 'mkdir -p "$HOME/.elevenex/tmp" "$HOME/.elevenex/releases" "$HOME/.elevenex/logs"');

    const downloadUrl = buildRemoteRuntimeDownloadUrl(bundledVersion, preflight.remoteTarget);
    if (!downloadUrl) {
      throw new Error(`Remote runtime download URL could not be resolved for ${bundledVersion}.`);
    }
    const downloaded = await tryRemoteDownloadAsync(forward, downloadUrl, remoteArchivePath);

    if (!downloaded) {
      throw new Error(
        `Failed to download remote runtime artifact ${downloadUrl} on ${forward.sshHost}.`,
      );
    }

    emitRemoteServerPhaseEvent(forward.id, 'installing');
    await runSshCommandAsync(
      forward,
      buildRemoteInstallCommand({
        remoteArchivePath,
        remoteReleaseDir,
        remoteCurrentLink,
      }),
    );
  }

  if (needsRuntimeRestart) {
    emitRemoteServerPhaseEvent(forward.id, 'starting');
    await runSshCommandAsync(
      forward,
      buildRemoteStartCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        forcePortCleanup: preflight.backendReachable && (
          installStatus === 'needs-update'
          || runningVersionMismatch
        ),
      }),
    );
  }

  await runSshCommandAsync(
    forward,
    buildRemoteWaitForReadyCommand({
      remoteRoot: remoteCurrentRoot,
      remotePort: forward.remotePort || 11111,
      expectedVersion: bundledVersion,
    }),
  );

  emitRemoteServerPhaseEvent(forward.id, 'probing');
  let runtime = await startSshForwardRuntime({
    ...forward,
    probeType: 'elevenex-backend',
  });

  if (isRemoteBackendProbeMissing(runtime)) {
    console.warn('[remote-runtime] backend probe failed after startup; restarting remote runtime and reallocating tunnel port', {
      serverId: forward.id,
      sshHost: forward.sshHost,
      previousLocalPort: forward.localPort,
      remotePort: forward.remotePort,
    });

    await stopSshForwardRuntime(forward.id);
    forward.localPort = await getFreePort();

    emitRemoteServerPhaseEvent(forward.id, 'starting');
    await runSshCommandAsync(
      forward,
      buildRemoteStartCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        forcePortCleanup: true,
      }),
    );

    await runSshCommandAsync(
      forward,
      buildRemoteWaitForReadyCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        expectedVersion: bundledVersion,
      }),
    );

    emitRemoteServerPhaseEvent(forward.id, 'probing');
    runtime = await startSshForwardRuntime({
      ...forward,
      probeType: 'elevenex-backend',
    });
  }

  if (runtime.status !== 'active') {
    return toRemoteEnsureReadyResult(forward, preflight, {
      status: 'error',
      installPhase: 'probing',
      message: isRemoteBackendProbeMissing(runtime)
        ? 'Could not restart the remote Elevenex app.'
        : runtime.lastError || 'Could not establish the SSH tunnel.',
      bundledVersion,
    });
  }

  return toRemoteEnsureReadyResult(forward, {
    ...preflight,
    currentVersion: bundledVersion,
    backendReachable: true,
  }, {
    status: 'ready',
    installPhase: 'ready',
    installStatus: 'available',
    message: '',
    localPort: forward.localPort,
    bundledVersion,
  });
}

function probeElevenexBackend(localPort) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port: localPort,
        path: '/api/projects',
        timeout: SSH_FORWARD_PROBE_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode && response.statusCode < 500);
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Probe timed out'));
    });
    request.on('error', () => resolve(false));
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function allocateLocalPort(id) {
  const existing = sshForwardRuntimes.get(id);
  if (existing && (existing.status === 'connecting' || existing.status === 'active')) {
    return existing.localPort;
  }
  return getFreePort();
}

function isRemoteBackendProbeMissing(runtime) {
  return runtime?.status === 'error'
    && (
      runtime.installStatus === 'missing'
      || runtime.debugDetails?.lastEvent === 'probe-missing'
    );
}

function assertNoSshBindConflict(forward) {
  for (const [id, runtime] of sshForwardRuntimes.entries()) {
    if (
      id !== forward.id
      && (runtime.status === 'connecting' || runtime.status === 'active')
      && runtime.bindAddress === forward.bindAddress
      && runtime.localPort === forward.localPort
      && runtime.process.exitCode === null
    ) {
      throw new Error(`Local port ${forward.bindAddress}:${forward.localPort} is already forwarded by another tunnel.`);
    }
  }
}

async function startSshForwardRuntime(forward) {
  const existing = sshForwardRuntimes.get(forward.id);
  if (existing && (existing.status === 'connecting' || existing.status === 'active')) {
    return toSshRuntimeView(forward.id, existing);
  }

  assertNoSshBindConflict(forward);

  const resolvedConfig = buildResolvedSshConfig(forward);
  const askPass = createSshAskPassRuntime(forward);
  const target = forward.sshHost;
  const bindSpec = `${forward.bindAddress}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`;
  const batchMode = askPass ? 'no' : 'yes';
  const spawnArgs = [
    '-F',
    resolvedConfig.configPath,
    '-N',
    '-L',
    bindSpec,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    `BatchMode=${batchMode}`,
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    target,
  ];
  const childProcess = spawn(
    'ssh',
    spawnArgs,
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: askPass?.env ?? process.env,
    },
  );

  const runtime = {
    id: forward.id,
    process: childProcess,
    bindAddress: forward.bindAddress,
    localPort: forward.localPort,
    status: 'connecting',
    installStatus: 'unknown',
    pid: childProcess.pid ?? null,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    error: null,
    resolvedConfig,
    askPass,
    stderrLines: [],
    debugDetails: {
      command: 'ssh',
      args: [...spawnArgs],
      target,
      bindSpec,
      resolveCommand: 'ssh',
      resolveArgs: resolvedConfig.resolveArgs,
      resolvedConfigPath: resolvedConfig.configPath,
      startedAt: null,
      stoppedAt: null,
      exitCode: null,
      signal: null,
      stderr: [],
      lastEvent: 'spawned',
    },
    activationTimer: null,
    stopTimer: null,
  };
  sshForwardRuntimes.set(forward.id, runtime);
  runtime.debugDetails.startedAt = runtime.startedAt;
  console.info('[ssh-forward] starting', {
    id: forward.id,
    target,
    bindSpec,
    pid: runtime.pid,
  });

  childProcess.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (!message) {
      return;
    }
    runtime.error = message;
    runtime.stderrLines.push(message);
    runtime.stderrLines = runtime.stderrLines.slice(-20);
    runtime.debugDetails.stderr = [...runtime.stderrLines];
    runtime.debugDetails.lastEvent = 'stderr';
    console.error('[ssh-forward] stderr', {
      id: forward.id,
      pid: runtime.pid,
      message,
    });
  });

  childProcess.once('error', (error) => {
    runtime.status = 'error';
    runtime.error = error.message;
    runtime.debugDetails.lastEvent = 'process-error';
    cleanupSshArtifacts(runtime);
    console.error('[ssh-forward] process error', {
      id: forward.id,
      pid: runtime.pid,
      error: error.message,
      debug: runtime.debugDetails,
    });
  });

  childProcess.once('exit', (code, signal) => {
    if (runtime.activationTimer) clearTimeout(runtime.activationTimer);
    if (runtime.stopTimer) clearTimeout(runtime.stopTimer);

    runtime.stoppedAt = new Date().toISOString();
    runtime.debugDetails.stoppedAt = runtime.stoppedAt;
    runtime.debugDetails.exitCode = code;
    runtime.debugDetails.signal = signal ?? null;

    if (runtime.installStatus === 'missing') {
      runtime.status = 'error';
      runtime.debugDetails.lastEvent = 'probe-missing';
    } else if (runtime.status === 'stopping' || signal === 'SIGTERM' || signal === 'SIGKILL') {
      runtime.status = 'inactive';
      runtime.error = null;
      runtime.debugDetails.lastEvent = 'stopped';
    } else if (code === 0) {
      runtime.status = 'inactive';
      runtime.debugDetails.lastEvent = 'exited-cleanly';
    } else {
      runtime.status = 'error';
      runtime.error = runtime.error || `ssh exited with code ${code ?? 'unknown'}`;
      runtime.debugDetails.lastEvent = 'exit-error';
      console.error('[ssh-forward] exited with error', {
        id: forward.id,
        pid: runtime.pid,
        code,
        signal,
        error: runtime.error,
        debug: runtime.debugDetails,
      });
    }

    cleanupSshArtifacts(runtime);

    setTimeout(() => {
      const current = sshForwardRuntimes.get(forward.id);
      if (current === runtime && current.status === 'inactive') {
        sshForwardRuntimes.delete(forward.id);
      }
    }, 500);
  });

  runtime.activationTimer = setTimeout(() => {
    const current = sshForwardRuntimes.get(forward.id);
    if (current === runtime && current.status === 'connecting') {
      runtime.status = 'active';
      runtime.error = null;
      runtime.debugDetails.lastEvent = 'active';
      console.info('[ssh-forward] active', {
        id: forward.id,
        pid: runtime.pid,
        target,
        bindSpec,
      });
    }
  }, 600);

  await new Promise((resolve) => setTimeout(resolve, 700));

  const current = sshForwardRuntimes.get(forward.id);
  if (
    current
    && current.status === 'active'
    && forward.probeType === 'elevenex-backend'
  ) {
    const probeSucceeded = await probeElevenexBackend(forward.localPort);
    current.installStatus = probeSucceeded ? 'available' : 'missing';
    if (!probeSucceeded) {
      current.status = 'error';
      current.error = `Elevenex is not reachable on ${forward.sshHost}. Install Elevenex on port ${forward.remotePort} first.`;
      current.debugDetails.lastEvent = 'probe-missing';
    }
  }

  return toSshRuntimeView(forward.id, sshForwardRuntimes.get(forward.id));
}

async function stopSshForwardRuntime(id) {
  const runtime = sshForwardRuntimes.get(id);
  if (!runtime) {
    return toSshRuntimeView(id, null);
  }

  if (runtime.activationTimer) clearTimeout(runtime.activationTimer);

  if (runtime.process.exitCode !== null || runtime.process.killed) {
    sshForwardRuntimes.delete(id);
    return toSshRuntimeView(id, null);
  }

  runtime.status = 'stopping';

  await new Promise((resolve) => {
    const cleanup = () => {
      if (runtime.stopTimer) clearTimeout(runtime.stopTimer);
      sshForwardRuntimes.delete(id);
      resolve();
    };

    runtime.process.once('exit', cleanup);
    terminateChildProcess(runtime.process);

    runtime.stopTimer = setTimeout(() => {
      if (runtime.process.exitCode === null) {
        try {
          runtime.process.kill('SIGKILL');
        } catch {
          // Ignore duplicate kill errors.
        }
      }
    }, CHILD_PROCESS_KILL_TIMEOUT_MS);
  });

  return toSshRuntimeView(id, null);
}

function isInternalBrowserUrl(targetUrl) {
  if (targetUrl === 'about:blank') {
    return true;
  }

  try {
    const url = new URL(targetUrl);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function getProjectIdFromBrowserKey(browserKey) {
  const match = /^project:(\d+)(?::tab:.+)?$/.exec(`${browserKey || ''}`);
  return match ? Number(match[1]) : null;
}

function getIsolatedPartition(browserKey) {
  const projectId = getProjectIdFromBrowserKey(browserKey);
  return projectId === null ? SHARED_PARTITION : `persist:elevenex-browser:${projectId}`;
}

function getPartitionForRuntimeContext(browserKey, runtimeContext) {
  return runtimeContext === 'shared' ? SHARED_PARTITION : getIsolatedPartition(browserKey);
}

function normalizePatternValue(pattern) {
  const trimmed = `${pattern || ''}`.trim();
  if (!trimmed) {
    return '';
  }

  if (!trimmed.includes('://')) {
    return trimmed.toLowerCase();
  }

  const [scheme, ...restParts] = trimmed.split('://');
  const rest = restParts.join('://');
  const separatorIndex = rest.search(/[/?#]/);
  const host = separatorIndex === -1 ? rest : rest.slice(0, separatorIndex);
  const suffix = separatorIndex === -1 ? '' : rest.slice(separatorIndex);
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${suffix}`;
}

function globToRegExp(glob) {
  const escaped = `${glob || ''}`.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

function toUrlPatternVariants(pattern) {
  const normalized = normalizePatternValue(pattern);
  if (!normalized) {
    return [];
  }

  if (normalized.includes('://')) {
    return [normalized];
  }

  return [`http://${normalized}/*`, `https://${normalized}/*`];
}

function rewriteLocalhostToProxy(url) {
  try {
    const parsed = new URL(url);
    if (
      (parsed.hostname === 'localhost'
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === '[::1]'
        || parsed.hostname === '::1')
      && parsed.port
    ) {
      return `${currentBackendUrl}/api/mcp-auth-proxy/${parsed.port}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // not a valid URL, return as-is
  }
  return url;
}

function matchesSharedPattern(targetUrl, sharedGlobs) {
  if (!targetUrl || targetUrl === 'about:blank' || !sharedGlobs?.length) {
    return false;
  }

  let normalizedTarget;
  try {
    normalizedTarget = normalizeBrowserUrl(targetUrl);
  } catch {
    return false;
  }

  return sharedGlobs.some((pattern) =>
    toUrlPatternVariants(pattern).some((variant) => globToRegExp(variant).test(normalizedTarget)),
  );
}

function resolveRuntimeContext(browserKey, isolationConfig, targetUrl) {
  if (!isolationConfig || isolationConfig.mode === 'shared') {
    return 'shared';
  }

  if (targetUrl && matchesSharedPattern(targetUrl, isolationConfig.sharedGlobs || [])) {
    return 'shared';
  }

  return 'isolated';
}

function ensureBrowserLayout(payload) {
  const browserBounds = toSafeBrowserBounds(payload?.browserBounds ?? payload?.bounds);
  const devtoolsVisible = Boolean(payload?.devtoolsVisible);
  const devtoolsBounds =
    devtoolsVisible && payload?.devtoolsBounds ? toSafeBrowserBounds(payload.devtoolsBounds) : null;

  return {
    browserBounds,
    devtoolsBounds,
    devtoolsVisible,
  };
}

function getBrowserState(browserKey) {
  const entry = browserViews.get(browserKey);
  if (!entry) {
    return null;
  }

  const { webContents, lastError } = entry.view;

  return {
    key: browserKey,
    url: webContents.getURL() || 'about:blank',
    title: webContents.getTitle() || '',
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
    isLoading: webContents.isLoading(),
    lastError,
    devtoolsOpen: Boolean(entry.devtoolsVisible),
    runtimeContext: entry.runtimeContext,
  };
}

function broadcastBrowserState(browserKey) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const state = getBrowserState(browserKey);
  if (state) {
    mainWindow.webContents.send('elevenex-browser:state-changed', state);
  }
}

function detachBrowserView(browserKey) {
  if (!mainWindow) {
    return;
  }

  const entry = browserViews.get(browserKey);
  if (!entry) {
    return;
  }

  detachDevToolsView(browserKey);

  if (!entry.attached) {
    if (attachedBrowserKey === browserKey) {
      attachedBrowserKey = null;
    }
    return;
  }

  try {
    mainWindow.contentView.removeChildView(entry.view);
  } catch {
    // Ignore duplicate detach attempts.
  }

  entry.attached = false;

  if (attachedBrowserKey === browserKey) {
    attachedBrowserKey = null;
  }
}

function attachBrowserView(browserKey, layout) {
  if (!mainWindow) {
    throw new Error('Main window is not available');
  }

  const entry = ensureBrowserView(browserKey);
  entry.layout = layout;

  if (attachedBrowserKey && attachedBrowserKey !== browserKey) {
    detachBrowserView(attachedBrowserKey);
  }

  if (entry.attached) {
    try {
      mainWindow.contentView.removeChildView(entry.view);
    } catch {
      // Ignore duplicate detach attempts while refreshing z-order.
    }
  }

  mainWindow.contentView.addChildView(entry.view);
  entry.attached = true;

  entry.view.setBounds(layout.browserBounds);
  syncBrowserDevToolsView(browserKey, layout);
  attachedBrowserKey = browserKey;

  return getBrowserState(browserKey);
}

function toSafeBrowserBounds(bounds) {
  return {
    x: Math.max(0, Math.round(Number(bounds?.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds?.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds?.width) || 0)),
    height: Math.max(1, Math.round(Number(bounds?.height) || 0)),
  };
}

function getBrowserEntryNavigationState(browserKey) {
  const entry = browserViews.get(browserKey);
  if (!entry) {
    return null;
  }

  return {
    attached: entry.attached,
    devtoolsVisible: entry.devtoolsVisible,
    layout: entry.layout,
    isolationConfig: entry.isolationConfig,
  };
}

async function loadBrowserUrl(browserKey, targetUrl, options = {}) {
  const normalizedUrl = rewriteLocalhostToProxy(normalizeBrowserUrl(targetUrl));
  const existing = browserViews.get(browserKey);
  const navigationState = options.navigationState
    || getBrowserEntryNavigationState(browserKey)
    || {
      attached: false,
      devtoolsVisible: false,
      layout: null,
      isolationConfig: options.isolationConfig || null,
    };
  const isolationConfig = options.isolationConfig ?? navigationState.isolationConfig ?? existing?.isolationConfig ?? null;
  const runtimeContext = options.runtimeContext ?? resolveRuntimeContext(browserKey, isolationConfig, normalizedUrl);
  const entry = ensureBrowserView(browserKey, isolationConfig, { runtimeContext });

  entry.view.lastError = null;
  entry.devtoolsVisible = navigationState.devtoolsVisible;

  if (navigationState.layout) {
    entry.layout = navigationState.layout;
  }

  if (navigationState.attached && entry.layout) {
    attachBrowserView(browserKey, {
      ...entry.layout,
      devtoolsVisible: entry.devtoolsVisible,
    });
  }

  await entry.view.webContents.loadURL(normalizedUrl);
  return getBrowserState(browserKey);
}

function handleNavigationOutsideApp(url) {
  shell.openExternal(url).catch(() => {});
}

function shouldIgnoreMainFrameFlag(isMainFrame) {
  return typeof isMainFrame === 'boolean' && !isMainFrame;
}

function routeTopLevelNavigation(browserKey, targetUrl, options = {}) {
  if (!isInternalBrowserUrl(targetUrl)) {
    handleNavigationOutsideApp(targetUrl);
    return;
  }

  const entry = browserViews.get(browserKey);
  const isolationConfig = options.isolationConfig ?? entry?.isolationConfig ?? null;
  const nextRuntimeContext = resolveRuntimeContext(browserKey, isolationConfig, targetUrl);
  const currentRuntimeContext = entry?.runtimeContext ?? resolveRuntimeContext(browserKey, isolationConfig);

  if (!entry || currentRuntimeContext === nextRuntimeContext) {
    if (options.source === 'window-open') {
      void loadBrowserUrl(browserKey, targetUrl, {
        isolationConfig,
        runtimeContext: nextRuntimeContext,
      });
    }
    return;
  }

  const navigationState = getBrowserEntryNavigationState(browserKey);
  destroyBrowserView(browserKey);
  void loadBrowserUrl(browserKey, targetUrl, {
    isolationConfig,
    runtimeContext: nextRuntimeContext,
    navigationState,
  }).catch(() => {});
}

function registerBrowserViewEvents(browserKey, view) {
  const syncState = () => broadcastBrowserState(browserKey);

  view.lastError = null;
  view.webContents.setWindowOpenHandler(({ url }) => {
    const proxied = rewriteLocalhostToProxy(url);
    if (isInternalBrowserUrl(proxied)) {
      routeTopLevelNavigation(browserKey, proxied, { source: 'window-open' });
    } else {
      handleNavigationOutsideApp(proxied);
    }

    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, url, _isInPlace, isMainFrame) => {
    if (shouldIgnoreMainFrameFlag(isMainFrame)) {
      return;
    }

    const proxied = rewriteLocalhostToProxy(url);
    if (proxied !== url) {
      event.preventDefault();
      void view.webContents.loadURL(proxied);
      return;
    }

    if (!isInternalBrowserUrl(url)) {
      event.preventDefault();
      handleNavigationOutsideApp(url);
      return;
    }

    const entry = browserViews.get(browserKey);
    if (!entry) {
      return;
    }

    const nextRuntimeContext = resolveRuntimeContext(browserKey, entry.isolationConfig, url);
    if (entry.runtimeContext !== nextRuntimeContext) {
      event.preventDefault();
      routeTopLevelNavigation(browserKey, url, { source: 'will-navigate' });
    }
  });

  view.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (shouldIgnoreMainFrameFlag(isMainFrame)) {
      return;
    }

    const proxied = rewriteLocalhostToProxy(url);
    if (proxied !== url) {
      event.preventDefault();
      void view.webContents.loadURL(proxied);
      return;
    }

    const entry = browserViews.get(browserKey);
    if (!entry) {
      return;
    }

    const nextRuntimeContext = resolveRuntimeContext(browserKey, entry.isolationConfig, url);
    if (entry.runtimeContext !== nextRuntimeContext) {
      event.preventDefault();
      routeTopLevelNavigation(browserKey, url, { source: 'will-redirect' });
    }
  });

  view.webContents.on('did-start-loading', syncState);
  view.webContents.on('did-stop-loading', syncState);
  view.webContents.on('did-navigate', () => {
    view.lastError = null;
    syncState();
  });
  view.webContents.on('did-navigate-in-page', () => {
    view.lastError = null;
    syncState();
  });
  view.webContents.on('page-title-updated', syncState);
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    view.lastError = `${errorDescription} (${validatedURL || 'unknown URL'})`;
    syncState();
  });
  view.webContents.on('devtools-opened', syncState);
  view.webContents.on('devtools-closed', () => {
    const entry = browserViews.get(browserKey);
    if (entry) {
      entry.devtoolsVisible = false;
      detachDevToolsView(browserKey);
    }
    syncState();
  });
}

function ensureBrowserView(browserKey, isolationConfig, options = {}) {
  const existing = browserViews.get(browserKey);
  const runtimeContext = options.runtimeContext
    || existing?.runtimeContext
    || resolveRuntimeContext(browserKey, isolationConfig);

  if (existing && existing.runtimeContext === runtimeContext) {
    if (isolationConfig) {
      existing.isolationConfig = isolationConfig;
    }
    return existing;
  }

  if (existing) {
    destroyBrowserView(browserKey);
  }

  const partition = getPartitionForRuntimeContext(browserKey, runtimeContext);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
    },
  });

  registerBrowserViewEvents(browserKey, view);
  const entry = {
    view,
    attached: false,
    devtoolsView: null,
    devtoolsAttached: false,
    devtoolsVisible: false,
    partition,
    runtimeContext,
    isolationConfig: isolationConfig || null,
    layout: null,
  };
  browserViews.set(browserKey, entry);
  view.webContents.loadURL('about:blank');

  return entry;
}

function ensureBrowserDevToolsView(browserKey) {
  const entry = ensureBrowserView(browserKey);
  if (entry.devtoolsView && !entry.devtoolsView.webContents.isDestroyed()) {
    return entry;
  }

  const devtoolsView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  entry.view.webContents.setDevToolsWebContents(devtoolsView.webContents);
  entry.devtoolsView = devtoolsView;
  entry.devtoolsAttached = false;
  return entry;
}

function detachDevToolsView(browserKey) {
  if (!mainWindow) {
    return;
  }

  const entry = browserViews.get(browserKey);
  if (!entry?.devtoolsView || !entry.devtoolsAttached) {
    return;
  }

  try {
    mainWindow.contentView.removeChildView(entry.devtoolsView);
  } catch {
    // Ignore duplicate detach attempts.
  }

  entry.devtoolsAttached = false;
}

function destroyDevToolsView(browserKey) {
  const entry = browserViews.get(browserKey);
  if (!entry?.devtoolsView) {
    return;
  }

  detachDevToolsView(browserKey);

  if (!entry.devtoolsView.webContents.isDestroyed()) {
    entry.devtoolsView.webContents.destroy();
  }

  entry.devtoolsView = null;
  entry.devtoolsAttached = false;
}

function syncBrowserDevToolsView(browserKey, layout) {
  const entry = browserViews.get(browserKey);
  if (!entry || !layout.devtoolsVisible || !layout.devtoolsBounds) {
    detachDevToolsView(browserKey);
    return;
  }

  ensureBrowserDevToolsView(browserKey);

  if (entry.devtoolsAttached) {
    try {
      mainWindow.contentView.removeChildView(entry.devtoolsView);
    } catch {
      // Ignore duplicate detach attempts while refreshing z-order.
    }
  }

  mainWindow.contentView.addChildView(entry.devtoolsView);
  entry.devtoolsAttached = true;

  if (!entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  entry.devtoolsView.setBounds(layout.devtoolsBounds);
}

function destroyBrowserView(browserKey) {
  const entry = browserViews.get(browserKey);
  if (!entry) {
    return;
  }

  detachBrowserView(browserKey);
  if (entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.closeDevTools();
  }
  destroyDevToolsView(browserKey);
  browserViews.delete(browserKey);
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.destroy();
  }
}

async function createMainWindow() {
  const frontendTarget = getFrontendTarget();
  currentBackendUrl = frontendTarget.backendUrl;
  const isMac = process.platform === 'darwin';
  const appIconPath = getAppIconPath();

  if (!frontendTarget.useEmbeddedBackend) {
    stopEmbeddedBackend();
  }

  if (frontendTarget.useEmbeddedBackend) {
    try {
      await startEmbeddedBackend(frontendTarget.backendUrl);
    } catch (error) {
      dialog.showErrorBox(
        'Embedded Backend Failed to Start',
        error instanceof Error ? error.message : 'Unknown backend startup error',
      );
      throw error;
    }
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: 'Elevenex',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 18, y: 16 },
        }
      : {
          icon: existsSync(appIconPath) ? appIconPath : undefined,
          frame: false,
          titleBarStyle: 'hidden',
          titleBarOverlay: false,
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--elevenex-backend-origin=${frontendTarget.backendUrl}`,
        `--elevenex-runtime-mode=${getRuntimeMode(frontendTarget)}`,
      ],
    },
  });

  if (frontendTarget.kind === 'file') {
    mainWindow.loadFile(frontendTarget.value);
  } else {
    mainWindow.loadURL(frontendTarget.value);
  }

  if (debugFrontend) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('maximize', emitMainWindowState);
  mainWindow.on('unmaximize', emitMainWindowState);
  mainWindow.on('enter-full-screen', emitMainWindowState);
  mainWindow.on('leave-full-screen', emitMainWindowState);
  mainWindow.once('ready-to-show', () => {
    closeInstallWindow();
    emitMainWindowState();
  });
  mainWindow.on('close', (event) => {
    if (isReloadingMainWindow || isAppQuitting) {
      return;
    }

    // On macOS, closing the main window (red traffic light, Cmd+W) should
    // quit the whole app rather than leave a headless process alive — this
    // app has no persistent dock-only state worth keeping.
    if (process.platform === 'darwin') {
      event.preventDefault();
      requestAppQuit();
    }
  });

  mainWindow.on('closed', () => {
    for (const browserKey of Array.from(browserViews.keys())) {
      destroyBrowserView(browserKey);
    }
    mainWindow = null;
  });
}

function buildSettingsHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Connection Settings</title>
    <style>
      :root {
        color-scheme: light;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        background: #f7f7f5;
        color: #1f2937;
      }
      main {
        padding: 20px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 18px;
      }
      p {
        margin: 0 0 16px;
        font-size: 13px;
        line-height: 1.5;
        color: #4b5563;
      }
      label {
        display: block;
        margin-bottom: 14px;
        font-size: 12px;
        font-weight: 600;
        color: #374151;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        margin-top: 6px;
        padding: 10px 12px;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        font-size: 13px;
        background: white;
      }
      .hint {
        display: block;
        margin-top: 6px;
        font-weight: 400;
        color: #6b7280;
      }
      .error {
        min-height: 18px;
        margin: 2px 0 14px;
        font-size: 12px;
        color: #b91c1c;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 13px;
        cursor: pointer;
      }
      button[type="button"] {
        background: #e5e7eb;
        color: #111827;
      }
      button[type="submit"] {
        background: #111827;
        color: white;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Connection Settings</h1>
      <p>Leave field empty to use default startup behavior.</p>
      <form id="settings-form">
        <label>
          Backend URL
          <input id="backendUrl" type="url" placeholder="${defaultBackendUrl}" />
          <span class="hint">Used for API, WebSocket, and socket.io traffic.</span>
        </label>
        <label>
          Frontend URL
          <input id="frontendUrl" type="url" placeholder="${debugFrontend ? defaultBackendUrl : 'Use built local frontend if available'}" />
          <span class="hint">Optional remote renderer override. Empty = built frontend or backend debug target.</span>
        </label>
        <div id="error" class="error"></div>
        <div class="actions">
          <button type="button" id="cancel">Cancel</button>
          <button type="submit">Save and Reload</button>
        </div>
      </form>
    </main>
    <script>
      const form = document.getElementById('settings-form');
      const backendUrl = document.getElementById('backendUrl');
      const frontendUrl = document.getElementById('frontendUrl');
      const error = document.getElementById('error');
      const cancel = document.getElementById('cancel');

      window.elevenexSettings.load().then((settings) => {
        backendUrl.value = settings.backendUrl || '';
        frontendUrl.value = settings.frontendUrl || '';
      });

      cancel.addEventListener('click', () => window.close());

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.textContent = '';
        const result = await window.elevenexSettings.save({
          backendUrl: backendUrl.value,
          frontendUrl: frontendUrl.value,
        });

        if (!result.ok) {
          error.textContent = result.error || 'Failed to save settings.';
          return;
        }

        window.close();
      });
    </script>
  </body>
</html>`;
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: !!mainWindow,
    parent: mainWindow ?? undefined,
    title: 'Connection Settings',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildSettingsHtml())}`);
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

async function reloadMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const wasDevToolsOpen = mainWindow.webContents.isDevToolsOpened();

  isReloadingMainWindow = true;

  try {
    mainWindow.destroy();
    await createMainWindow();
  } finally {
    isReloadingMainWindow = false;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setBounds(bounds);

  if (wasDevToolsOpen && !mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Connection Settings...',
          click: () => openSettingsWindow(),
        },
        {
          label: 'Reload App',
          ...(!app.isPackaged ? { accelerator: 'CmdOrCtrl+R' } : {}),
          click: () => void reloadMainWindow(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : [{
      label: 'Elevenex',
      submenu: [
        {
          label: 'Connection Settings...',
          click: () => openSettingsWindow(),
        },
        {
          label: 'Reload App',
          ...(!app.isPackaged ? { accelerator: 'CmdOrCtrl+R' } : {}),
          click: () => void reloadMainWindow(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(!app.isPackaged ? [{ role: 'reload' }, { role: 'forceReload' }] : []),
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' },
            ]
          : [{ role: 'close' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('elevenex-settings:load', () => readSettings());

ipcMain.handle('elevenex-settings:save', (_event, nextSettings) => {
  try {
    const normalized = {
      backendUrl: normalizeUrl(nextSettings.backendUrl),
      frontendUrl: normalizeUrl(nextSettings.frontendUrl),
    };

    writeSettings(normalized);
    void reloadMainWindow();

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid settings',
    };
  }
});

ipcMain.handle('elevenex-window:get-environment', () => ({
  isElectron: true,
  platform: process.platform,
  usesNativeMacControls: process.platform === 'darwin',
}));

ipcMain.handle('elevenex-window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('elevenex-window:maximize', () => {
  if (mainWindow && !mainWindow.isMaximized()) {
    mainWindow.maximize();
  }
  return {
    isMaximized: mainWindow?.isMaximized() ?? false,
    isFullScreen: mainWindow?.isFullScreen() ?? false,
    isFocused: mainWindow?.isFocused() ?? false,
  };
});

ipcMain.handle('elevenex-window:unmaximize', () => {
  if (mainWindow && mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  }
  return {
    isMaximized: mainWindow?.isMaximized() ?? false,
    isFullScreen: mainWindow?.isFullScreen() ?? false,
    isFocused: mainWindow?.isFocused() ?? false,
  };
});

ipcMain.handle('elevenex-window:toggle-maximize', () => {
  if (!mainWindow) {
    return { isMaximized: false };
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }

  return {
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  };
});

ipcMain.handle('elevenex-window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('elevenex-window:is-maximized', () => ({
  isMaximized: mainWindow?.isMaximized() ?? false,
  isFullScreen: mainWindow?.isFullScreen() ?? false,
  isFocused: mainWindow?.isFocused() ?? false,
}));

ipcMain.handle('elevenex-browser:is-supported', () => true);

ipcMain.handle('elevenex-external-links:open', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  await shell.openExternal(url);
  return true;
});

const authWindows = new Map();

function registerAuthWindowNavigationHandlers(authWindow) {
  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    const proxied = rewriteLocalhostToProxy(url);
    if (proxied !== url) {
      void authWindow.loadURL(proxied);
      return { action: 'deny' };
    }

    return { action: 'allow' };
  });

  authWindow.webContents.on('will-navigate', (event, url) => {
    const proxied = rewriteLocalhostToProxy(url);
    if (proxied !== url) {
      event.preventDefault();
      void authWindow.loadURL(proxied);
    }
  });

  authWindow.webContents.on('will-redirect', (event, url) => {
    const proxied = rewriteLocalhostToProxy(url);
    if (proxied !== url) {
      event.preventDefault();
      void authWindow.loadURL(proxied);
    }
  });
}

ipcMain.handle('elevenex-auth-window:open', async (_event, payload) => {
  const url = typeof payload === 'string' ? payload : payload?.url;
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  const key = `${payload?.key || 'default'}`;

  let authWindow = authWindows.get(key);
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    void authWindow.loadURL(rewriteLocalhostToProxy(url));
    return true;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 400,
    minHeight: 500,
    parent: mainWindow ?? undefined,
    title: typeof payload?.title === 'string' && payload.title ? payload.title : 'Authentication',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:elevenex-auth:${key}`,
    },
  });

  authWindows.set(key, authWindow);
  registerAuthWindowNavigationHandlers(authWindow);
  authWindow.on('closed', () => {
    if (authWindows.get(key) === authWindow) {
      authWindows.delete(key);
    }
  });

  await authWindow.loadURL(rewriteLocalhostToProxy(url));
  return true;
});

ipcMain.handle('elevenex-browser:show', (_event, payload) => {
  const browserKey = `${payload?.key || ''}`;
  if (!browserKey) {
    throw new Error('Browser key is required');
  }

  ensureBrowserView(browserKey, payload?.isolationConfig);
  return attachBrowserView(browserKey, ensureBrowserLayout(payload));
});

ipcMain.handle('elevenex-browser:hide', (_event, browserKey) => {
  detachBrowserView(`${browserKey || ''}`);
});

ipcMain.handle('elevenex-browser:close', (_event, browserKey) => {
  destroyBrowserView(`${browserKey || ''}`);
});

ipcMain.handle('elevenex-browser:navigate', async (_event, payload) => {
  const browserKey = `${payload?.key || ''}`;
  if (!browserKey) {
    throw new Error('Browser key is required');
  }

  const layout = payload?.bounds || payload?.browserBounds ? ensureBrowserLayout(payload) : null;
  const navigationState = layout
    ? {
      attached: true,
      devtoolsVisible: layout.devtoolsVisible,
      layout,
      isolationConfig: payload?.isolationConfig ?? null,
    }
    : undefined;

  return loadBrowserUrl(browserKey, payload?.url, {
    isolationConfig: payload?.isolationConfig,
    navigationState,
  });
});

ipcMain.handle('elevenex-browser:back', (_event, browserKey) => {
  const entry = ensureBrowserView(`${browserKey || ''}`);
  if (entry.view.webContents.navigationHistory.canGoBack()) {
    entry.view.webContents.navigationHistory.goBack();
  }
  return getBrowserState(`${browserKey || ''}`);
});

ipcMain.handle('elevenex-browser:forward', (_event, browserKey) => {
  const entry = ensureBrowserView(`${browserKey || ''}`);
  if (entry.view.webContents.navigationHistory.canGoForward()) {
    entry.view.webContents.navigationHistory.goForward();
  }
  return getBrowserState(`${browserKey || ''}`);
});

ipcMain.handle('elevenex-browser:reload', (_event, browserKey) => {
  const entry = ensureBrowserView(`${browserKey || ''}`);
  entry.view.lastError = null;
  entry.view.webContents.reload();
  return getBrowserState(`${browserKey || ''}`);
});

ipcMain.handle('elevenex-browser:get-state', (_event, browserKey) => {
  const key = `${browserKey || ''}`;
  if (!key || !browserViews.has(key)) {
    return null;
  }

  return getBrowserState(key);
});

ipcMain.handle('elevenex-browser:set-devtools-visible', (_event, payload) => {
  const browserKey = `${payload?.key || ''}`;
  if (!browserKey) {
    throw new Error('Browser key is required');
  }

  const entry = ensureBrowserView(browserKey);
  const layout = ensureBrowserLayout(payload);
  entry.devtoolsVisible = layout.devtoolsVisible;

  if (!layout.devtoolsVisible && entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.closeDevTools();
  }
  if (!layout.devtoolsVisible) {
    destroyDevToolsView(browserKey);
  }

  if (attachedBrowserKey === browserKey && entry.attached) {
    attachBrowserView(browserKey, layout);
  }

  broadcastBrowserState(browserKey);
  return getBrowserState(browserKey);
});

ipcMain.handle('elevenex-browser:update-isolation-config', (_event, payload) => {
  const { projectId } = payload || {};
  if (!projectId) return;
  const browserKeyPrefix = `project:${projectId}:tab:`;
  for (const browserKey of Array.from(browserViews.keys())) {
    if (browserKey.startsWith(browserKeyPrefix)) {
      destroyBrowserView(browserKey);
    }
  }
});

ipcMain.handle('elevenex-ssh-forwarding:is-supported', () => true);

ipcMain.handle('elevenex-ssh-forwarding:start', async (_event, payload) => {
  const forward = {
    id: Number(payload?.id),
    sshHost: `${payload?.sshHost || ''}`.trim(),
    sshUser: `${payload?.sshUser || ''}`.trim(),
    sshPort: Number(payload?.sshPort || 22),
    bindAddress: `${payload?.bindAddress || '127.0.0.1'}`.trim(),
    localPort: Number(payload?.localPort),
    remoteHost: `${payload?.remoteHost || '127.0.0.1'}`.trim(),
    remotePort: Number(payload?.remotePort),
    authMode: payload?.authMode === 'password' || payload?.authMode === 'key' ? payload.authMode : 'agent',
    password: `${payload?.password || ''}`,
    identityFilePath: `${payload?.identityFilePath || ''}`.trim(),
    passphrase: `${payload?.passphrase || ''}`,
    probeType: payload?.probeType === 'elevenex-backend' ? 'elevenex-backend' : 'none',
  };

  if (!Number.isFinite(forward.id) || forward.id <= 0) {
    throw new Error('Forward id is required');
  }

  if (!forward.sshHost) {
    throw new Error('SSH host is required');
  }

  if (forward.authMode === 'password' && !forward.password.trim()) {
    throw new Error('SSH password is required');
  }

  if (forward.authMode === 'key' && !forward.identityFilePath) {
    throw new Error('A private key path is required');
  }

  for (const port of [forward.sshPort, forward.localPort, forward.remotePort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Ports must be between 1 and 65535');
    }
  }

  return startSshForwardRuntime(forward);
});

ipcMain.handle('elevenex-ssh-forwarding:stop', async (_event, id) => {
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error('Forward id is required');
  }

  return stopSshForwardRuntime(numericId);
});

ipcMain.handle('elevenex-ssh-forwarding:get-state', (_event, id) => {
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return null;
  }

  return toSshRuntimeView(numericId, sshForwardRuntimes.get(numericId) ?? null);
});

ipcMain.handle('elevenex-ssh-forwarding:pick-identity-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: 'Choose an SSH private key',
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('elevenex-remote-server:ensure-ready', async (_event, payload) => {
  const serverId = Number(payload?.id);
  if (!Number.isFinite(serverId) || serverId <= 0) {
    throw new Error('Remote server id is required');
  }

  const sshHost = `${payload?.sshHost || ''}`.trim();
  if (!sshHost) {
    throw new Error('SSH host is required');
  }

  const localPort = await allocateLocalPort(serverId);
  const forward = {
    id: serverId,
    sshHost,
    sshUser: `${payload?.sshUser || ''}`.trim(),
    sshPort: Number(payload?.sshPort || 22),
    bindAddress: `${payload?.bindAddress || '127.0.0.1'}`.trim(),
    localPort,
    remoteHost: `${payload?.remoteHost || '127.0.0.1'}`.trim(),
    remotePort: Number(payload?.remotePort || 11111),
    authMode: payload?.authMode === 'password' || payload?.authMode === 'key' ? payload.authMode : 'agent',
    password: `${payload?.password || ''}`,
    identityFilePath: `${payload?.identityFilePath || ''}`.trim(),
    passphrase: `${payload?.passphrase || ''}`,
    probeType: 'elevenex-backend',
  };

  let result;
  try {
    result = await ensureRemoteServerReady(forward);
  } catch (error) {
    console.error('[remote-runtime] ensure-ready failed', {
      serverId: forward.id,
      message: error instanceof Error ? error.message : `${error}`,
    });
    result = {
      status: 'error',
      installPhase: 'starting',
      installStatus: 'unknown',
      remotePlatform: 'unknown',
      remoteArch: 'unknown',
      missingDependencies: [],
      message: error instanceof Error ? error.message : 'Remote runtime setup failed.',
      localPort: null,
      sessionId: null,
      osRelease: {},
      suggestedCommands: [],
      version: getRemoteRuntimeVersion(),
    };
  }
  if (result.status === 'ready' || result.status === 'error' || result.status === 'unsupported') {
    destroyRemoteInstallerSessionForServer(forward.id);
  }
  return result;
});

ipcMain.handle('elevenex-remote-server:recheck', async (_event, payload) => {
  const sessionId = Number(payload?.sessionId);
  const sessionState = remoteInstallerSessions.get(sessionId);
  if (!sessionState) {
    throw new Error('Remote installer session not found');
  }

  let result;
  try {
    result = await ensureRemoteServerReady(sessionState.forward);
  } catch (error) {
    console.error('[remote-runtime] recheck failed', {
      sessionId,
      message: error instanceof Error ? error.message : `${error}`,
    });
    result = {
      status: 'error',
      installPhase: 'starting',
      installStatus: 'unknown',
      remotePlatform: 'unknown',
      remoteArch: 'unknown',
      missingDependencies: [],
      message: error instanceof Error ? error.message : 'Remote runtime setup failed.',
      localPort: null,
      sessionId,
      osRelease: {},
      suggestedCommands: [],
      version: getRemoteRuntimeVersion(),
    };
  }
  if (result.status === 'ready' || result.status === 'error' || result.status === 'unsupported') {
    destroyRemoteInstallerSession(sessionId);
  }
  return result;
});

ipcMain.handle('elevenex-remote-server:send-input', (_event, payload) => {
  const sessionId = Number(payload?.sessionId);
  const data = `${payload?.data || ''}`;
  const sessionState = remoteInstallerSessions.get(sessionId);
  if (!sessionState || !sessionState.process?.stdin || sessionState.process.stdin.destroyed) {
    return false;
  }

  sessionState.process.stdin.write(data);
  return true;
});

ipcMain.handle('elevenex-remote-server:resize', (_event, payload) => {
  const sessionId = Number(payload?.sessionId);
  const cols = Number(payload?.cols);
  const rows = Number(payload?.rows);
  const sessionState = remoteInstallerSessions.get(sessionId);
  if (!sessionState || !sessionState.process?.stdin || sessionState.process.stdin.destroyed) {
    return false;
  }

  if (Number.isFinite(cols) && Number.isFinite(rows)) {
    sessionState.process.stdin.write(`stty cols ${Math.max(20, cols)} rows ${Math.max(5, rows)}\n`);
  }

  return true;
});

ipcMain.handle('elevenex-remote-server:close-session', (_event, sessionId) => {
  destroyRemoteInstallerSession(Number(sessionId));
  return true;
});

// ─── Cursor integration ────────────────────────────────────────────────────────

ipcMain.handle('elevenex-cursor:open', async (_event, payload) => {
  const { worktreePath, mode, sshUser, sshHost } = payload || {};

  if (!worktreePath || typeof worktreePath !== 'string') {
    return { ok: false, error: 'Worktree path is required' };
  }

  if (mode === 'remote') {
    if (!sshHost || typeof sshHost !== 'string') {
      return { ok: false, error: 'SSH host is required for remote mode' };
    }

    const remoteTarget = sshUser ? `${sshUser}@${sshHost}` : sshHost;

    try {
      const child = spawn('cursor', ['--remote', `ssh-remote+${remoteTarget}`, worktreePath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(`cursor://vscode-remote/ssh-remote+${remoteTarget}${worktreePath}`);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `Could not open Cursor: ${e.message}` };
      }
    }
  }

  // Local mode (default)
  try {
    const child = spawn('cursor', [worktreePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true };
  } catch {
    try {
      await shell.openExternal(`cursor://file${worktreePath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Could not open Cursor: ${e.message}` };
    }
  }
});

app.whenReady().then(async () => {
  app.setName('Elevenex');

  if (process.platform === 'darwin' && app.dock) {
    const macAppIcon = getMacAppIcon();
    if (macAppIcon) {
      app.dock.setIcon(macAppIcon);
    }
  }

  installMenu();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}).catch((error) => {
  dialog.showErrorBox(
    'Elevenex Startup Failed',
    error instanceof Error ? error.message : 'Unknown startup error',
  );
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    requestAppQuit();
  }
});

app.on('before-quit', () => {
  // Run cleanup in before-quit (not will-quit) so WebContentsView renderer
  // processes are destroyed before Electron waits for windows to close —
  // lingering renderers were preventing the app from actually exiting.
  isAppQuitting = true;
  runShutdownCleanup();
});

app.on('will-quit', () => {
  runShutdownCleanup();
});

app.on('quit', () => {
  clearShutdownForceExitTimer();
});
