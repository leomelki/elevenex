const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, screen, session, shell } = require('electron');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const {
  REMOTE_HOME_DIRNAME,
  REMOTE_RUNTIME_TARGETS,
  buildRemoteInstallCommand,
  buildRemotePreflightScript,
  buildRemoteStartCommand,
  buildRemoteWaitForReadyCommand,
  buildWindowsRemoteInstallCommand,
  buildWindowsRemotePreflightScript,
  buildWindowsRemoteStartCommand,
  buildWindowsRemoteWaitForReadyCommand,
  getInstallGuidance,
  parseRemotePreflight,
  resolveRemoteRuntimeTarget,
  shellPathQuote,
  shellSingleQuote,
} = require('./remote-server-utils.cjs');
const {
  isWslCliAvailable,
  listWslDistros,
  getDefaultWslDistro,
} = require('./wsl-utils.cjs');
const { downloadToFile, formatBytes } = require('./download-utils.cjs');
const { createAppUpdater } = require('./app-updater.cjs');
const {
  LOCAL_ENVIRONMENT_REF,
  environmentRefKey,
  normalizeEnvironmentRef,
} = require('./environment-ref.cjs');
const { createConnectionRegistry } = require('./connection-registry.cjs');
const { rewriteLocalhostToProxy: rewriteMcpCallbackToProxy } = require('./mcp-proxy-url.cjs');
const { createWindowRegistry } = require('./window-manager.cjs');
const {
  DEFAULT_WINDOW_BOUNDS,
  MIN_WINDOW_SIZE,
  cascadeBounds,
  clampBoundsToDisplays,
  createWindowStateStore,
} = require('./window-state-store.cjs');

// Common install directories for user-facing binaries (tmux, claude, plannotator,
// cursor). macOS Electron apps launched from Finder/DMG get a stripped PATH
// because no shell rc files run — we extend it here once so every spawn
// (backend, ssh, cursor) inherits the richer PATH.
const COMMON_BINARY_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

// macOS/Linux Electron apps launched from Finder/Dock/DMG bypass the user's
// login shell, so PATH is stripped, LANG/LC_* are unset, and agent sockets
// (SSH_AUTH_SOCK, GPG_AGENT_INFO, IdentityAgent paths) never get populated.
// Symptoms range from missing tmux/claude binaries, ASCII-only terminals, to
// "Permission denied (publickey)" on every spawned ssh — until the user opens
// Terminal once to establish a ControlMaster we can mux onto.
//
// Resolve all of that in one shot by harvesting the login shell's env at
// startup and merging it into process.env. Anything Electron has explicit
// opinions about (NODE_*, ELECTRON_*, ELEVENEX_*) wins over the shell.
// Run an interactive login shell (-il) so we source the same rc files iTerm
// would (.zprofile/.zshenv/.zshrc, .bash_profile/.bashrc, etc.). Many users
// only export their agent socket override (1Password, Secretive, yubikey-agent)
// in .zshrc, so a login-only shell would miss it. Wrap the env dump in start/
// end markers because interactive rc files routinely print prompts, MOTD,
// plugin chatter, etc. on stdout; we slice between markers to recover just the
// env output. ELEVENEX_RESOLVING_ENV is exported so rc files can short-circuit
// expensive interactive setup if they want.
function harvestLoginShellEnv() {
  const loginShell = process.env.SHELL || '/bin/zsh';
  const startMarker = '__ELEVENEX_ENV_START__';
  const endMarker = '__ELEVENEX_ENV_END__';
  const script = `printf '%s\\n' '${startMarker}'; env -0; printf '%s\\n' '${endMarker}'`;
  try {
    const result = spawnSync(loginShell, ['-ilc', script], {
      encoding: 'buffer',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ELEVENEX_RESOLVING_ENV: '1' },
    });
    if (!result.stdout) return {};
    const stdout = result.stdout.toString('utf8');
    const start = stdout.indexOf(startMarker);
    const end = stdout.indexOf(endMarker, start + startMarker.length);
    if (start === -1 || end === -1) return {};
    const payload = stdout.slice(start + startMarker.length, end).replace(/^\r?\n/, '');
    const env = {};
    for (const entry of payload.split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return {};
  }
}

const PROTECTED_ENV_PREFIXES = ['NODE_', 'ELECTRON_', 'ELEVENEX_'];
const PROTECTED_ENV_KEYS = new Set([
  'PATH', // PATH is merged separately below to keep Electron's defaults
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
]);

function mergeLoginShellEnv(loginEnv) {
  for (const [key, value] of Object.entries(loginEnv)) {
    if (!key || value === undefined) continue;
    if (PROTECTED_ENV_KEYS.has(key)) continue;
    if (PROTECTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    // Only fill gaps — don't overwrite anything Electron already set
    // intentionally (CI overrides, test harnesses, parent-shell overrides
    // when launched from a terminal).
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function mergedPath(loginPath) {
  const seen = new Set();
  const parts = [];
  const addPart = (part) => {
    if (part && !seen.has(part)) {
      seen.add(part);
      parts.push(part);
    }
  };
  for (const part of (loginPath || '').split(':')) addPart(part);
  for (const part of (process.env.PATH || '').split(':')) addPart(part);
  for (const part of COMMON_BINARY_PATHS) addPart(part);
  return parts.join(':');
}

function ensureUtf8Locale(loginEnv) {
  const hasUtf8 = (value) => typeof value === 'string' && /utf-?8/i.test(value);
  if (hasUtf8(process.env.LC_ALL) || hasUtf8(process.env.LANG) || hasUtf8(process.env.LC_CTYPE)) {
    return;
  }
  const inherited = [loginEnv.LC_ALL, loginEnv.LANG, loginEnv.LC_CTYPE].find(hasUtf8);
  const fallback = inherited || 'en_US.UTF-8';
  if (!process.env.LANG) process.env.LANG = fallback;
  if (!process.env.LC_CTYPE) process.env.LC_CTYPE = fallback;
}

function dropStaleSshAuthSock() {
  // A stale SSH_AUTH_SOCK (eg. a launchd path whose backing process is gone)
  // makes ssh fail before it ever tries the on-disk keys. Better to clear it
  // than keep a value that's guaranteed to fail.
  const sock = process.env.SSH_AUTH_SOCK;
  if (sock && !existsSync(sock)) {
    delete process.env.SSH_AUTH_SOCK;
  }
}

const loginShellEnv = harvestLoginShellEnv();
mergeLoginShellEnv(loginShellEnv);
process.env.PATH = mergedPath(loginShellEnv.PATH);
ensureUtf8Locale(loginShellEnv);
dropStaleSshAuthSock();

// Explicit port override (dev / CI). When unset, the embedded backend is given a
// random free loopback port at launch (see ensureEmbeddedBackendPort) so it can
// never collide with another elevenex backend on the same machine — e.g. a remote
// SSH-to-localhost runtime, which binds 11111.
const explicitProxyPort = process.env.ELEVENEX_PROXY_PORT || process.env.FRONTEND_PORT || '';
const FALLBACK_BACKEND_PORT = '11111';
let embeddedBackendPort = explicitProxyPort || null;
const defaultFrontendUrl = process.env.ELECTRON_FRONTEND_URL || '';
const debugFrontend = process.env.ELECTRON_DEBUG_FRONTEND === '1';
const EMBEDDED_BACKEND_READY_TIMEOUT_MS = 20000;
const EMBEDDED_BACKEND_READY_POLL_INTERVAL_MS = 250;
const APP_DISPLAY_NAME = 'Elevenex';
const SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 4000;
const RUNTIME_RELEASE_BASE = process.env.ELEVENEX_RUNTIME_RELEASE_BASE
  || 'https://github.com/leomelki/elevenex/releases/download';
const CHILD_PROCESS_KILL_TIMEOUT_MS = 1500;

// Backend origin the renderer/preload should talk to. Reflects the resolved
// embedded port once allocated; falls back to 11111 only before allocation /
// in non-embedded dev modes. An explicit ELECTRON_BACKEND_URL always wins.
function getDefaultBackendUrl() {
  if (process.env.ELECTRON_BACKEND_URL) {
    return process.env.ELECTRON_BACKEND_URL;
  }
  return `http://127.0.0.1:${embeddedBackendPort || FALLBACK_BACKEND_PORT}`;
}

// Allocate the embedded backend's port once per process. Honors an explicit
// override; otherwise grabs a random free loopback port. Must be awaited before
// getFrontendTarget()/startEmbeddedBackend() so the backend URL handed to the
// renderer matches the port the backend actually binds.
async function ensureEmbeddedBackendPort() {
  if (!embeddedBackendPort) {
    embeddedBackendPort = String(await getFreePort());
  }
  return embeddedBackendPort;
}

let settingsWindow = null;
let installWindow = null;
// Browser views are keyed by `${windowId}::${browserKey}` — the renderer's keys
// (project:<id>:tab:<n>) are only unique within one window, and two windows on
// the same project must not fight over a single WebContentsView.
const browserViews = new Map();
// windowId -> currently attached view key. Each window shows at most one
// browser view at a time, but the windows are independent of each other.
const attachedBrowserKeys = new Map();
const sshForwardRuntimes = new Map();
const remoteInstallerSessions = new Map();
let nextRemoteInstallerSessionId = 1;
// serverId -> Set<windowId> for windows that are *connecting* to a remote and
// therefore do not hold its lease yet. Remote install/phase events must still
// reach them, otherwise the window driving the install sees no progress.
const remoteServerInterest = new Map();
// Sentinel "server id" for the singleton WSL backend connection. Negative so it
// never collides with a real saved SSH server's id (those are positive,
// Date.now()-based). There is only ever one WSL target — it is not a saved,
// named connection the way SSH servers are (see remote-install-flow docs).
const WSL_SERVER_ID = -1;
let embeddedBackendRuntime = null;
let embeddedBackendStartPromise = null;
let isAppQuitting = false;
const reloadingWindowIds = new Set();
let hasRunShutdownCleanup = false;
let shutdownForceExitTimer = null;

app.setName(APP_DISPLAY_NAME);
// ELEVENEX_USER_DATA_DIR lets a test run (or a second debugging profile) use an
// isolated Chromium profile, window layout and settings file instead of the
// user's real ones.
app.setPath(
  'userData',
  process.env.ELEVENEX_USER_DATA_DIR
    || path.join(app.getPath('appData'), APP_DISPLAY_NAME),
);

const windowRegistry = createWindowRegistry();

// Leases decide when a shared resource is actually torn down. Two windows on
// one SSH server share a single tunnel; every local window shares the single
// embedded backend. Only the last holder letting go stops anything.
const connectionRegistry = createConnectionRegistry({
  onRelease: (envRef) => {
    if (envRef.mode === 'ssh' || envRef.mode === 'wsl') {
      return stopSshForwardRuntime(envRef.serverId);
    }
    // The embedded backend is intentionally left running when the last local
    // window closes: restarting it costs seconds, and on macOS the app stays
    // alive with no windows. It is stopped for real in runShutdownCleanup().
    return undefined;
  },
  onError: (error, envRef) => {
    console.warn('[windows] environment teardown failed', {
      environment: environmentRefKey(envRef),
      message: error instanceof Error ? error.message : `${error}`,
    });
  },
});

const windowStateStore = createWindowStateStore({
  filePath: path.join(app.getPath('userData'), 'windows.json'),
  onError: (error) => {
    console.warn(`[windows] layout persistence failed: ${error instanceof Error ? error.message : error}`);
  },
});

// Frozen once shutdown starts. Quitting closes every window in turn, and each
// close would otherwise shrink the saved layout until it was empty — the next
// launch would restore nothing. The layout captured at the moment of quit is
// the one the user expects to come back to.
let isWindowLayoutFrozen = false;

function persistWindowLayout() {
  if (isWindowLayoutFrozen) {
    return;
  }
  windowStateStore.save(windowRegistry.toPersistedState());
}

function freezeWindowLayout() {
  if (isWindowLayoutFrozen) {
    return;
  }
  // Synchronous on purpose: the process is about to exit (with a hard
  // force-exit a few seconds out), and an awaited async write is not
  // guaranteed to land. Quitting is exactly when the layout must survive.
  windowStateStore.saveSync(windowRegistry.toPersistedState());
  isWindowLayoutFrozen = true;
}

function findExistingPath(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function getAppIconPath() {
  if (process.platform === 'win32') {
    // Windows renders the taskbar/title-bar icon best from a multi-resolution
    // .ico; fall back to the PNG logo if the icon file is unavailable.
    return findExistingPath([
      path.join(__dirname, 'assets', 'icon.ico'),
      path.join(process.resourcesPath, 'assets', 'icon.ico'),
      path.join(__dirname, '..', '..', '11x.png'),
      path.join(__dirname, '11x.png'),
      path.join(process.resourcesPath, '11x.png'),
    ]);
  }

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

function toWindowState(win) {
  if (!win || win.isDestroyed()) {
    return { isMaximized: false, isFullScreen: false, isFocused: false };
  }

  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
    isFocused: win.isFocused(),
  };
}

function emitWindowState(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents.send('elevenex-window:state-changed', toWindowState(win));
}

// The environment ref a remote serverId maps to. WSL is a singleton connection
// with a sentinel id (see WSL_SERVER_ID), everything else is a saved SSH server.
function environmentRefForServerId(serverId) {
  return serverId === WSL_SERVER_ID
    ? { mode: 'wsl', serverId: WSL_SERVER_ID }
    : { mode: 'ssh', serverId };
}

function addRemoteServerInterest(serverId, windowId) {
  if (!windowId) {
    return;
  }
  const existing = remoteServerInterest.get(serverId);
  if (existing) {
    existing.add(windowId);
    return;
  }
  remoteServerInterest.set(serverId, new Set([windowId]));
}

function removeRemoteServerInterest(serverId, windowId) {
  const existing = remoteServerInterest.get(serverId);
  if (!existing || !windowId) {
    return;
  }
  existing.delete(windowId);
  if (existing.size === 0) {
    remoteServerInterest.delete(serverId);
  }
}

function dropRemoteServerInterestForWindow(windowId) {
  for (const [serverId, windowIds] of remoteServerInterest) {
    windowIds.delete(windowId);
    if (windowIds.size === 0) {
      remoteServerInterest.delete(serverId);
    }
  }
}

// Everything watching a remote: the windows already bound to it plus the ones
// currently connecting. Both need the install/phase stream.
function sendToRemoteServerAudience(serverId, channel, payload) {
  windowRegistry.sendToEnv(
    environmentRefForServerId(serverId),
    channel,
    payload,
    [...(remoteServerInterest.get(serverId) ?? [])],
  );
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
// `ssh -G` prints resolved values unquoted and space-separated. For options
// whose value is a single token that may legitimately contain spaces (e.g. a
// 1Password agent socket under "~/Library/Group Containers/…"), the value must
// be re-quoted before it lands in a config file, otherwise ssh treats the part
// after the first space as "extra arguments at end of line" and refuses the
// config. Multi-token list options (userknownhostsfile, etc.) are intentionally
// excluded so their space-separated entries survive.
const SSH_FORWARD_CONFIG_QUOTED_OPTIONS = new Set([
  'identityagent',
  'identityfile',
  'certificatefile',
  'controlpath',
  'xauthlocation',
]);

function formatResolvedSshConfigLine(key, value) {
  if (
    SSH_FORWARD_CONFIG_QUOTED_OPTIONS.has(key) &&
    /\s/.test(value) &&
    !(value.startsWith('"') && value.endsWith('"'))
  ) {
    return `  ${key} "${value}"`;
  }
  return `  ${key} ${value}`;
}
const SSH_FORWARD_PROBE_TIMEOUT_MS = 1800;
const SSH_PORT_BOUND_TIMEOUT_MS = 10000;
// Agent forwarding needs two things the plain `-L` tunnel does not give us.
//
// 1. A fixed socket on the remote. `ssh -R` binds one for the life of the
//    connection and rebinds the same path on reconnect, which is what lets the
//    backend hold one SSH_AUTH_SOCK forever. The socket ssh normally exports
//    lives in a per-session /tmp directory and dies with the command that
//    created it, so a daemon can never rely on it.
// 2. A session channel. OpenSSH only sends the agent-forwarding request on one
//    (`auth-agent-req@openssh.com`), and `-N` opens no session at all, so hosts
//    with their own convention for republishing a forwarded agent — a login
//    hook maintaining a stable symlink, say — would see nothing to publish.
//    A no-op reader holds one open: no output, no CPU, and it exits on stdin
//    EOF when the tunnel goes away, so nothing is left behind.
//
// Both are skipped entirely unless the host's own SSH config asks for agent
// forwarding and an agent is actually reachable (see resolveAgentForwardPlan).
const SSH_AGENT_SESSION_KEEPALIVE_COMMAND = 'cat > /dev/null';
const REMOTE_AGENT_SOCKET_BASENAME = 'agent.sock';

function getLocalFrontendEntry() {
  return findExistingPath([
    path.join(__dirname, '..', 'frontend', 'dist', 'frontend', 'browser', 'index.html'),
    path.join(__dirname, 'frontend', 'dist', 'frontend', 'browser', 'index.html'),
  ]);
}

function getPackagedRuntimeRoot() {
  return path.join(os.homedir(), '.elevenex', 'runtime');
}

// Kept outside the runtime directory so it survives runtime wipes and lets the
// next launch clean up a backend left running by a previous (possibly crashed)
// session.
function getEmbeddedBackendPidPath() {
  return path.join(os.homedir(), '.elevenex', 'embedded-backend.pid');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we are not allowed to signal it.
    return error.code === 'EPERM';
  }
}

// The embedded backend spawns descendants (PTY/conpty agents, helper node
// processes) whose executables and native modules live under runtime/backend.
// Terminating only the direct child orphans those descendants, and on Windows a
// running executable keeps its directory locked — which is what makes the next
// launch's `rmdir runtime\backend` fail with EBUSY. Kill the whole tree while the
// parent is still alive so the tree relationship can be walked.
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === 'win32') {
    // taskkill /T walks and kills the entire descendant tree; /F forces it.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  // POSIX: the backend is spawned detached (its own process group), so a negative
  // pid signals the whole group. Fall back to the lone pid if that fails.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best effort — the process may already be gone.
    }
  }
}

// Last-resort cleanup for descendants that were orphaned by a crash (so the
// parent pid is already dead and taskkill /T can no longer find the tree). Find
// and kill anything still running from inside the runtime directory by image
// path. Scoped to the runtime subtree so a remote/SSH backend running from
// ~/.elevenex-remote/current is never touched. Windows-only; on POSIX a locked
// exe does not block removing its directory.
function killProcessesUnderRuntimeDir() {
  if (process.platform !== 'win32') {
    return;
  }

  const prefix = `${path.resolve(getPackagedRuntimeRoot())}\\`.replace(/'/g, "''");
  const script =
    'Get-CimInstance Win32_Process | '
    + `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', `
    + '[System.StringComparison]::OrdinalIgnoreCase) } | '
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

// A backend left running by a previous Elevenex session keeps runtime/backend
// locked on Windows, which makes the next startup's runtime cleanup fail with
// EBUSY. Kill any recorded leftover process tree before we touch the runtime
// directory or bind the backend port.
function terminateStaleEmbeddedBackend() {
  const pidPath = getEmbeddedBackendPidPath();
  let pid = null;
  try {
    pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  } catch {
    return;
  }

  if (pid !== process.pid && isProcessAlive(pid)) {
    killProcessTree(pid);
  }

  try {
    rmSync(pidPath, { force: true });
  } catch {
    // Non-fatal: the stale pid file is harmless once the process is gone.
  }
}

// On Windows a freshly-terminated backend can hold file handles for a short
// window, so retry the removal and, on persistent locking, kill the recorded
// backend plus any process still running from the runtime tree before trying
// once more with a longer window for the OS to release handles.
function removeRuntimeDir(runtimeRoot) {
  try {
    rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return;
  } catch (error) {
    if (error.code !== 'EBUSY' && error.code !== 'EPERM' && error.code !== 'ENOTEMPTY') {
      throw error;
    }
  }

  terminateStaleEmbeddedBackend();
  killProcessesUnderRuntimeDir();
  rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
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

function getEmbeddedBackendNodeExecutable() {
  const embeddedBackendRoot = getEmbeddedBackendRoot();
  const candidates = process.platform === 'win32'
    ? [path.join(embeddedBackendRoot, 'node', 'node.exe')]
    : [path.join(embeddedBackendRoot, 'node', 'bin', 'node')];

  return candidates.find((candidate) => existsSync(candidate)) || null;
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
      for (const entry of windowRegistry.all()) {
        entry.win.destroy();
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
  freezeWindowLayout();
  closeAuxiliaryWindows();

  for (const viewKey of Array.from(browserViews.keys())) {
    destroyBrowserView(viewKey);
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
  freezeWindowLayout();
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

  const installIconPath = getAppIconPath();
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
    ...(process.platform !== 'darwin' && existsSync(installIconPath)
      ? { icon: installIconPath }
      : {}),
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

function updateInstallProgress({ status, percent }) {
  if (!installWindow || installWindow.isDestroyed()) {
    return;
  }
  const js = percent != null
    ? `document.getElementById('progress').classList.remove('indeterminate');document.getElementById('progress').setAttribute('aria-valuenow','${percent}');document.getElementById('progress').setAttribute('aria-valuemin','0');document.getElementById('progress').setAttribute('aria-valuemax','100');document.getElementById('fill').style.width='${percent}%';document.getElementById('status').textContent=${JSON.stringify(status || '')};`
    : `document.getElementById('progress').classList.add('indeterminate');document.getElementById('progress').removeAttribute('aria-valuenow');document.getElementById('progress').removeAttribute('aria-valuemin');document.getElementById('progress').removeAttribute('aria-valuemax');document.getElementById('fill').style.width='';document.getElementById('status').textContent=${JSON.stringify(status || '')};`;
  installWindow.webContents.executeJavaScript(js).catch(() => {});
}

const NATIVE_BINARY_EXTENSIONS = ['.node', '.dylib'];
const NATIVE_EXECUTABLE_NAMES = ['node', 'spawn-helper'];

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
    removeRuntimeDir(runtimeRoot);
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
      resignNativeBinaries(path.join(runtimeRoot, 'backend'));
    }

    if (bundledVersion) {
      writeFileSync(getRuntimeVersionPath(), `${bundledVersion}\n`, 'utf8');
    }

    writeFileSync(runtimeMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    removeRuntimeDir(runtimeRoot);
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

function isAddressInUseError(message) {
  return /EADDRINUSE|address already in use/i.test(message || '');
}

// Exit code the backend uses to ask its launcher for a restart (see
// apps/backend/src/runtime-control/runtime-control.service.ts). Anything else is
// a real shutdown.
const BACKEND_RESTART_EXIT_CODE = 75;

// A freshly-extracted node.exe is often briefly locked on Windows: real-time AV
// scans the new executable, and the tar/file handles may not be fully released
// yet. Spawning during that window fails with one of these codes. The lock is
// transient, so the right response is a short backoff and retry rather than
// surfacing a fatal "backend failed to start" — which is why simply relaunching
// Elevenex (after the scan settles) currently works around it.
const TRANSIENT_SPAWN_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY', 'UNKNOWN', 'ENOENT']);

function isTransientSpawnLockError(error) {
  if (process.platform !== 'win32' || !error) {
    return false;
  }
  return TRANSIENT_SPAWN_LOCK_CODES.has(error.code);
}

// Spawn the backend process, wire logging/pid/exit tracking, and return a promise
// that resolves once it reports ready (or rejects with the captured stderr; the
// rejection carries `.addressInUse` so the caller can decide whether to retry on
// a different port).
function launchEmbeddedBackend(launchOptions) {
  const { backendExecutable, backendArgs, env, cwd, backendUrl } = launchOptions;
  const child = spawn(backendExecutable, backendArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: give the backend its own process group so we can signal the whole
    // tree (PTY agents, helper node processes) on shutdown instead of orphaning
    // descendants. Windows uses taskkill /T for the same effect.
    detached: process.platform !== 'win32',
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

  // spawn() reports a failure to launch the executable (e.g. the freshly
  // extracted node.exe is still locked by AV on Windows) via an asynchronous
  // 'error' event, not by throwing. Without this listener Node would rethrow it
  // as an uncaught exception in the main process — escaping the try/catch in
  // createAppWindow and breaking startup until the next relaunch.
  const spawnFailed = new Promise((_resolve, reject) => {
    child.once('error', (error) => {
      const wrapped = new Error(`Failed to launch embedded backend: ${error.message}`);
      wrapped.transientLock = isTransientSpawnLockError(error);
      reject(wrapped);
    });
  });

  const ready = Promise.race([
    waitForBackendReady(backendUrl, EMBEDDED_BACKEND_READY_TIMEOUT_MS),
    spawnFailed,
  ]).then(
    () => undefined,
    (error) => {
      terminateChildProcess(child);
      const details = stderrBuffer.trim();
      const wrapped = new Error(details ? `${error.message}\n\n${details}` : error.message);
      wrapped.addressInUse = error.addressInUse || isAddressInUseError(stderrBuffer);
      wrapped.transientLock = Boolean(error.transientLock);
      throw wrapped;
    },
  );

  embeddedBackendRuntime = { child, ready, backendUrl };

  try {
    writeFileSync(getEmbeddedBackendPidPath(), `${child.pid}\n`, 'utf8');
  } catch {
    // Non-fatal: the pid file only helps clean up a stale backend on next launch.
  }

  child.once('exit', (code) => {
    // Guard against a superseded launch (e.g. a retry already replaced the
    // runtime) clobbering the live one when this older child finally exits.
    if (embeddedBackendRuntime?.child !== child) {
      return;
    }

    // Settings -> "Restart backend" makes the backend exit with this code. It
    // deliberately does not respawn itself: a self-spawned process would escape
    // the pid tracking that lets us kill the whole tree on quit. Relaunch it
    // here instead, on the same port so the renderer's backend origin still
    // points at it.
    if (code === BACKEND_RESTART_EXIT_CODE && !isAppQuitting) {
      console.info('[embedded-backend] restart requested by the app, relaunching');
      launchEmbeddedBackend(launchOptions).catch((error) => {
        console.error(`[embedded-backend] relaunch after restart failed: ${error.message}`);
      });
      return;
    }

    embeddedBackendRuntime = null;
    try {
      rmSync(getEmbeddedBackendPidPath(), { force: true });
    } catch {
      // Non-fatal.
    }
  });

  return ready;
}

// Starts the embedded backend and returns the backend origin it actually bound.
// Every local window shares this one backend, and restoring several of them at
// once would otherwise race several spawns (and several install splashes) over
// the same port and PID file — so concurrent callers share one attempt.
function startEmbeddedBackend() {
  if (embeddedBackendRuntime) {
    return embeddedBackendRuntime.ready.then(() => embeddedBackendRuntime.backendUrl);
  }

  if (!embeddedBackendStartPromise) {
    embeddedBackendStartPromise = launchEmbeddedBackendWithRetries().finally(() => {
      embeddedBackendStartPromise = null;
    });
  }

  return embeddedBackendStartPromise;
}

async function launchEmbeddedBackendWithRetries() {
  const embeddedBackendRoot = getEmbeddedBackendRoot();
  // Clear out a backend orphaned by a previous/crashed session before it can
  // lock the runtime directory or hold the backend port.
  terminateStaleEmbeddedBackend();
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

  const bundledNodeExecutable = getEmbeddedBackendNodeExecutable();
  const backendExecutable = bundledNodeExecutable || process.execPath;
  const backendArgs = [embeddedBackendEntry];

  // Two transient failures justify a retry here:
  //  - EADDRINUSE: a random free port can be grabbed between getFreePort()
  //    releasing the probe socket and the backend binding it. Reallocate a fresh
  //    port and retry (only when the port wasn't explicitly pinned).
  //  - A Windows file lock on a freshly-extracted node.exe (AV scan / unreleased
  //    tar handles). Back off briefly and retry the same port so the very first
  //    launch after a download/update succeeds instead of requiring a relaunch.
  const maxAttempts = explicitProxyPort ? 1 : 5;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resolvedPort = await ensureEmbeddedBackendPort();
    const backendUrl = getDefaultBackendUrl();
    const env = {
      ...process.env,
      ELEVENEX_BACKEND_RUNTIME_ROOT: embeddedBackendRoot,
      DB_PATH: packagedDatabasePath,
      ELEVENEX_PROXY_PORT: resolvedPort,
      FRONTEND_PORT: resolvedPort,
      // Tells the backend a launcher is watching it, so Settings can offer a
      // restart (it exits with BACKEND_RESTART_EXIT_CODE and we relaunch it).
      ELEVENEX_BACKEND_SUPERVISED: '1',
    };
    if (!bundledNodeExecutable) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    try {
      await launchEmbeddedBackend({
        backendExecutable,
        backendArgs,
        env,
        cwd: embeddedBackendRoot,
        backendUrl,
      });
      return backendUrl;
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && (error.addressInUse || error.transientLock);
      if (!canRetry) {
        break;
      }
      if (error.addressInUse) {
        // Drop the contested port so the next attempt allocates a fresh one.
        embeddedBackendPort = null;
      } else {
        // Give Windows time to finish scanning/releasing the new executable
        // before retrying on the same port.
        updateInstallProgress({ status: 'Preparing backend… finalizing files' });
        await wait(750 * attempt);
      }
    }
  }

  closeInstallWindow();
  throw lastError || new Error('Embedded backend failed to start');
}

function stopEmbeddedBackend() {
  const child = embeddedBackendRuntime?.child;
  if (!child) {
    return;
  }

  // Kill the whole process tree, not just the direct child — orphaned
  // descendants keep the runtime directory locked on Windows and cause the next
  // launch to fail with EBUSY. Done while the parent is still alive so the tree
  // can be walked.
  if (typeof child.pid === 'number') {
    killProcessTree(child.pid);
  }

  // Backstop for the parent itself (and platforms where the tree kill missed it).
  terminateChildProcess(child);

  try {
    rmSync(getEmbeddedBackendPidPath(), { force: true });
  } catch {
    // Non-fatal.
  }
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
  const backendUrl = settings.backendUrl || getDefaultBackendUrl();
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

function buildSshResolveArgs(forward) {
  const resolveArgs = ['-G', '-p', String(forward.sshPort)];

  if (forward.sshUser) {
    resolveArgs.push('-l', forward.sshUser);
  }

  if (forward.authMode === 'key' && forward.identityFilePath) {
    resolveArgs.push('-o', 'IdentitiesOnly=yes');
    resolveArgs.push('-o', `IdentityFile=${forward.identityFilePath}`);
  }

  resolveArgs.push(forward.sshHost);
  return resolveArgs;
}

// `RemoteForward <remote> <local>`, with either side quoted when it contains
// spaces (agent sockets under "~/Library/Group Containers/…" routinely do).
function formatRemoteForwardLine(remoteSocket, localSocket) {
  const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
  return `  RemoteForward ${quote(remoteSocket)} ${quote(localSocket)}`;
}

// `resolvedSshOutput` is the `ssh -G` dump the caller already produced; only
// when it is missing (the standalone forwarding IPC path) is one resolved here.
function buildResolvedSshConfig(forward, resolvedSshOutput) {
  const resolveArgs = buildSshResolveArgs(forward);
  let resolvedStdout = resolvedSshOutput || '';

  if (!resolvedStdout) {
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

    resolvedStdout = resolved.stdout;
  }

  const configLines = [];
  let resolvedHostname = '';
  for (const rawLine of resolvedStdout.split(/\r?\n/)) {
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

    configLines.push(formatResolvedSshConfigLine(key, value));
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

  // Publishes the agent at the fixed path the remote backend was told to use.
  // StreamLocalBindUnlink above clears the socket a previous connection left
  // behind, so reconnects rebind the same path instead of failing.
  if (forward.agentForward) {
    configLines.push(formatRemoteForwardLine(
      forward.agentForward.remoteSocket,
      forward.agentForward.localSocket,
    ));
  }

  if (forward.authMode === 'password') {
    configLines.push('  PreferredAuthentications password,keyboard-interactive');
    configLines.push('  PubkeyAuthentication no');
  }

  if (forward.authMode === 'key' && forward.identityFilePath) {
    configLines.push(formatResolvedSshConfigLine('identityfile', forward.identityFilePath));
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

// Async `ssh -G`, resolved once per connection and reused by everything that
// needs it — a config can contain `Match exec` blocks that run shell commands
// on every resolve, so this must not be called more often than it used to be.
// Returns '' on failure; buildResolvedSshConfig then falls back to resolving it
// itself, which is also where a bad host surfaces as a proper error.
function resolveSshConfigOutput(forward) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', buildSshResolveArgs(forward), { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve('');
      return;
    }

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.once('error', () => resolve(''));
    child.once('exit', (code) => resolve(code === 0 ? stdout : ''));
  });
}

function readSshConfigValue(resolvedOutput, key) {
  const prefix = `${key} `;
  const line = `${resolvedOutput || ''}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

// ForwardAgent resolves to `no`, `yes`, an explicit socket path, or `$VAR`
// naming the environment variable holding one. Returns the socket the user
// actually wants forwarded, or null when forwarding is off or no agent is
// listening (unset, stale, or a Windows named pipe rather than a socket).
function resolveLocalAgentSocket(forwardAgentValue) {
  const value = `${forwardAgentValue || ''}`.trim();
  if (!value || value === 'no') {
    return null;
  }

  let candidate;
  if (value === 'yes') {
    candidate = process.env.SSH_AUTH_SOCK;
  } else if (value.startsWith('$')) {
    candidate = process.env[value.slice(1)];
  } else {
    candidate = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  }

  if (!candidate) {
    return null;
  }

  try {
    return statSync(candidate).isSocket() ? candidate : null;
  } catch {
    return null;
  }
}

// Whether this connection should carry an agent, and where it lands remotely.
// Everything is derived from the host's own SSH config, so a host that does not
// forward an agent — or a machine with no agent running at all — resolves to
// null and keeps exactly the forwarding-only tunnel it has today. Unix-socket
// forwarding rules out non-POSIX remotes, and WSL shares localhost with Windows
// rather than tunnelling, so neither gets a plan.
function resolveAgentForwardPlan(forward, preflight, resolvedSshOutput) {
  if (forward.transport === 'wsl' || !['linux', 'darwin'].includes(preflight?.remotePlatform)) {
    return null;
  }

  const remoteHome = `${preflight?.remoteHome || ''}`.trim().replace(/\/+$/, '');
  if (!remoteHome.startsWith('/')) {
    return null;
  }

  const localSocket = resolveLocalAgentSocket(readSshConfigValue(resolvedSshOutput, 'forwardagent'));
  if (!localSocket) {
    return null;
  }

  return {
    localSocket,
    remoteSocket: `${remoteHome}/${REMOTE_HOME_DIRNAME}/${REMOTE_AGENT_SOCKET_BASENAME}`,
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

  if (process.platform === 'win32') {
    // Windows OpenSSH cannot execute Unix shell scripts (CreateProcessW fails with
    // ERROR_BAD_EXE_FORMAT / error 193), and .bat files have the same problem.
    // Use the Electron binary itself as the askpass helper via ELECTRON_RUN_AS_NODE.
    // A small --require script writes the secret to stdout and exits before Node.js
    // tries to run SSH's prompt string as a JS file.
    const helperScript = path.join(tempDir, 'askpass.cjs');
    writeFileSync(
      helperScript,
      'process.stdout.write((process.env.ELEVENEX_SSH_ASKPASS_SECRET||"")+"\n");process.exit(0);\n',
      'utf8',
    );
    const helperScriptFwd = helperScript.replace(/\\/g, '/');
    const baseNodeOptions = process.env.NODE_OPTIONS || '';
    const nodeOptions = `${baseNodeOptions} --require "${helperScriptFwd}"`.trim();
    return {
      tempDir,
      scriptPath: process.execPath,
      env: {
        ...process.env,
        SSH_ASKPASS: process.execPath,
        SSH_ASKPASS_REQUIRE: 'force',
        ELEVENEX_SSH_ASKPASS_SECRET: secret,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: nodeOptions,
      },
    };
  }

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
  return [
    '-F',
    resolvedConfig.configPath,
    // Fail fast when the host is unreachable so exec commands (install/start/probe
    // scripts) don't hang forever on a dead network.
    '-o',
    'ConnectTimeout=10',
    // Detect a silently-dropped connection during long-running remote scripts (eg.
    // the readiness poll) and exit instead of leaving the promise unresolved.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    target,
  ];
}

function encodePowershellCommand(command) {
  return Buffer.from(`${command}`, 'utf16le').toString('base64');
}

function getRemoteCommandArgs(command, options = {}) {
  if (options.remotePlatform === 'win32') {
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowershellCommand(command),
    ];
  }

  return ['sh', '-lc', shellSingleQuote(command)];
}

// Builds the wsl.exe argv for running `command` inside forward.distroName (or
// WSL's own default distro when unset).
//
// The POSIX branch deliberately does NOT put `command` on the argv at all.
// wsl.exe forwards each argv element it receives to the Linux side as one
// literal argument, but that hand-off does not reliably round-trip the
// backslash-quote escaping Windows adds when node's spawn() builds the actual
// command line (needed because `command` — a multi-line script — is full of
// embedded `"` characters). The escaped quotes can arrive unescaped-back on
// the Linux side, garbling the script and breaking `sh -lc` with syntax
// errors near the mangled quotes. Piping the script over stdin instead (see
// runWslCommandAsync/runWslCommand) avoids Windows/WSL argv quoting entirely.
function getWslArgs(forward, command, options = {}) {
  const args = [];
  if (forward.distroName) {
    args.push('-d', forward.distroName);
  }
  args.push('--');
  if (options.remotePlatform === 'win32') {
    // Base64-encoded, so no quoting/escaping is needed either way — safe to
    // reuse verbatim. Should not normally be reached for a WSL distro (see
    // the transport === 'wsl' guard in runRemotePreflight).
    args.push(...getRemoteCommandArgs(command, options));
  } else {
    args.push('sh', '-ls');
  }
  return args;
}

function runWslCommandAsync(forward, command, options = {}) {
  return new Promise((resolve, reject) => {
    const wslArgs = getWslArgs(forward, command, options);
    const feedsStdin = options.remotePlatform !== 'win32';
    let child;
    try {
      child = spawn('wsl.exe', wslArgs, { stdio: [feedsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `wsl.exe exited with code ${code ?? 'unknown'}`).trim()));
      } else {
        resolve({ stdout, stderr, args: wslArgs });
      }
    });

    child.once('error', (error) => reject(error));

    if (feedsStdin) {
      child.stdin.end(command);
    }
  });
}

function runWslCommand(forward, command, options = {}) {
  const wslArgs = getWslArgs(forward, command, options);
  const feedsStdin = options.remotePlatform !== 'win32';
  const { remotePlatform: _remotePlatform, ...spawnOptions } = options;
  const result = spawnSync('wsl.exe', wslArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    input: feedsStdin ? command : undefined,
    ...spawnOptions,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `wsl.exe exited with code ${result.status ?? 'unknown'}`).trim());
  }

  return { stdout: `${result.stdout || ''}`, stderr: `${result.stderr || ''}`, args: wslArgs };
}

// Every caller in this file already threads a `forward`-shaped object through
// runSshCommand(Async) — dispatching on `forward.transport` here (rather than
// renaming every call site) keeps the entire preflight/install/start/wait
// orchestration below transport-agnostic. Only the actual process spawn
// differs between an SSH target and a local WSL distro.
function runSshCommandAsync(forward, command, options = {}) {
  if (forward.transport === 'wsl') {
    return runWslCommandAsync(forward, command, options);
  }

  return new Promise((resolve, reject) => {
    const resolvedConfig = buildResolvedSshConfig(forward);
    const askPass = createSshAskPassRuntime(forward);
    const target = buildSshTarget(forward);
    const baseArgs = getSshBaseArgs(resolvedConfig, target);
    const sshArgs = [...baseArgs, ...getRemoteCommandArgs(command, options)];

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
  if (forward.transport === 'wsl') {
    return runWslCommand(forward, command, options);
  }

  const resolvedConfig = buildResolvedSshConfig(forward);
  const askPass = createSshAskPassRuntime(forward);
  const target = buildSshTarget(forward);
  const baseArgs = getSshBaseArgs(resolvedConfig, target);
  const sshArgs = [...baseArgs, ...getRemoteCommandArgs(command, options)];

  try {
    const { remotePlatform: _remotePlatform, ...spawnOptions } = options;
    const result = spawnSync('ssh', sshArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: askPass?.env ?? process.env,
      ...spawnOptions,
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

function emitRemoteInstallerEvent(sessionId, payload, serverIdHint) {
  const serverId = serverIdHint ?? remoteInstallerSessions.get(sessionId)?.serverId;
  const message = { sessionId, ...payload };

  if (serverId === undefined) {
    // Session already gone and no hint: broadcast rather than drop, so a
    // terminal that is still mounted somewhere gets its closing frame.
    windowRegistry.broadcast('elevenex-remote-server:installer-event', message);
    return;
  }

  sendToRemoteServerAudience(serverId, 'elevenex-remote-server:installer-event', message);
}

function destroyRemoteInstallerSession(sessionId) {
  const existing = remoteInstallerSessions.get(sessionId);
  if (!existing) {
    return;
  }

  terminateChildProcess(existing.process);

  cleanupSshArtifacts(existing);
  remoteInstallerSessions.delete(sessionId);
  // Pass the server id explicitly: the session is gone from the map, so the
  // audience can no longer be resolved from it.
  emitRemoteInstallerEvent(sessionId, { type: 'closed' }, existing.serverId);
}

function destroyRemoteInstallerSessionForServer(serverId) {
  const existing = Array.from(remoteInstallerSessions.values())
    .find((session) => session.serverId === serverId);
  if (!existing) {
    return;
  }

  destroyRemoteInstallerSession(existing.id);
}

// Interactive terminal session that shows live install-guidance output when
// prerequisites are missing. Reuses the same `remoteInstallerSessions` map,
// events, and IPC channels (elevenex-remote-server:recheck/send-input/resize/
// close-session) as the SSH path — those are already keyed by sessionId and
// never touch SSH-specific state, so no WSL-specific IPC is needed for them.
function createWslInstallerSession(forward, preflight) {
  const sessionId = nextRemoteInstallerSessionId++;
  const wslArgs = forward.distroName ? ['-d', forward.distroName] : [];
  const child = spawn('wsl.exe', wslArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  const sessionState = {
    id: sessionId,
    serverId: forward.id,
    forward,
    process: child,
    resolvedConfig: null,
    askPass: null,
    preflight,
    // wsl.exe is spawned with plain OS pipes (no console/ConPTY to inherit),
    // so the distro-side shell has no controlling tty — `stty` would fail
    // with "Inappropriate ioctl for device". Unlike the SSH path's `-tt`.
    hasTty: false,
  };
  remoteInstallerSessions.set(sessionId, sessionState);

  child.stdout.on('data', (chunk) => {
    emitRemoteInstallerEvent(sessionId, { type: 'data', data: chunk.toString() });
  });
  child.stderr.on('data', (chunk) => {
    emitRemoteInstallerEvent(sessionId, { type: 'data', data: chunk.toString() });
  });
  child.once('exit', (code, signal) => {
    remoteInstallerSessions.delete(sessionId);
    emitRemoteInstallerEvent(sessionId, { type: 'exit', code: code ?? null, signal: signal ?? null });
  });
  child.once('error', (error) => {
    emitRemoteInstallerEvent(sessionId, { type: 'error', message: error.message });
  });

  return sessionState;
}

function createRemoteInstallerSession(forward, preflight) {
  const existing = Array.from(remoteInstallerSessions.values()).find((session) => session.serverId === forward.id);
  if (existing) {
    existing.preflight = preflight;
    return existing;
  }

  if (forward.transport === 'wsl') {
    return createWslInstallerSession(forward, preflight);
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
    // `-tt` above forces the remote sshd to allocate a real pty, so `stty` in
    // the resize handler works.
    hasTty: true,
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

async function runRemotePreflight(forward) {
  const remotePort = forward.remotePort || 11111;
  try {
    return await runSshCommandAsync(forward, buildRemotePreflightScript(remotePort));
  } catch (unixError) {
    // A WSL distro is always Linux — never probe it as a Windows target. Its
    // Win32 interop feature lets `powershell.exe` resolve and "succeed" by
    // transparently running the real Windows PowerShell outside the distro,
    // which would silently misreport the distro as a Windows remote.
    if (forward.transport === 'wsl') {
      throw unixError;
    }
    try {
      return await runSshCommandAsync(
        forward,
        buildWindowsRemotePreflightScript(remotePort),
        { remotePlatform: 'win32' },
      );
    } catch {
      throw unixError;
    }
  }
}

function getRemoteInstallStatus(preflight, bundledVersion) {
  if (!['linux', 'darwin', 'win32'].includes(preflight.remotePlatform)) {
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
  const installGuidance = getInstallGuidance(
    preflight.osRelease || {},
    preflight.remotePlatform,
    preflight.missingDependencies || [],
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
    installGuidance,
    version: bundledVersion || null,
    // Only meaningful for forward.transport === 'wsl' (which distro was
    // actually used, including when the caller let us pick the default) —
    // null for SSH forwards, which have no concept of a distro.
    distroName: forward.distroName ?? null,
  };
}

function buildRemoteRuntimeDownloadUrl(version, targetKey) {
  if (!version || !targetKey) {
    return null;
  }
  if (!/^[a-f0-9]{7,64}$/i.test(version) && !/^v?\d+\.\d+\.\d+/.test(version)) {
    return null;
  }
  const archiveExtension = REMOTE_RUNTIME_TARGETS[targetKey]?.archiveExtension || 'tar.gz';
  return `${RUNTIME_RELEASE_BASE}/runtime-${version}/elevenex-remote-runtime-${targetKey}.${archiveExtension}`;
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

function buildWindowsDownloadScript(url, remoteDestination) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$url = ${JSON.stringify(url)}`,
    `$dest = ${JSON.stringify(remoteDestination)}`,
    'if ($dest -eq "~") { $dest = $HOME }',
    'elseif ($dest.StartsWith("~/") -or $dest.StartsWith("~\\")) { $dest = Join-Path $HOME $dest.Substring(2) }',
    '$tmp = "$dest.partial"',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null',
    'Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue',
    'Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 600',
    'Move-Item -LiteralPath $tmp -Destination $dest -Force',
  ].join('\r\n');
}

function buildRemoteDownloadScript(url, remoteDestination, remotePlatform) {
  return remotePlatform === 'win32'
    ? buildWindowsDownloadScript(url, remoteDestination)
    : buildDownloadScript(url, remoteDestination);
}

function tryRemoteDownload(forward, url, remoteDestination, remotePlatform) {
  try {
    runSshCommand(forward, buildRemoteDownloadScript(url, remoteDestination, remotePlatform), { remotePlatform });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.warn(`[remote-runtime] download from ${url} failed: ${message.split('\n')[0]}`);
    return false;
  }
}

async function tryRemoteDownloadAsync(forward, url, remoteDestination, remotePlatform) {
  try {
    await runSshCommandAsync(
      forward,
      buildRemoteDownloadScript(url, remoteDestination, remotePlatform),
      { remotePlatform },
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`;
    console.warn(`[remote-runtime] download from ${url} failed: ${message.split('\n')[0]}`);
    return false;
  }
}

function emitRemoteServerPhaseEvent(serverId, phase) {
  console.info('[remote-runtime] phase', { serverId, phase });
  // Every window watching this server sees the same progress — two windows
  // waiting on one install must not have to guess what the other is doing.
  sendToRemoteServerAudience(serverId, 'elevenex-remote-server:phase-update', { serverId, phase });
}

// Last successful readiness result per server. Lets a second window join a
// server another window already brought up without re-running preflight,
// install and probing over SSH — the tunnel is shared, so the answer is too.
const readyRemoteServers = new Map();

function reuseReadyRemoteServer(serverId) {
  const cached = readyRemoteServers.get(serverId);
  const runtime = sshForwardRuntimes.get(serverId);
  if (!cached || runtime?.status !== 'active' || !runtime.localPort) {
    return null;
  }

  return { ...cached, localPort: runtime.localPort, sessionId: null };
}

function recordRemoteServerResult(serverId, result) {
  if (result?.status === 'ready') {
    readyRemoteServers.set(serverId, result);
  } else {
    readyRemoteServers.delete(serverId);
  }
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
  const preflightResult = await runRemotePreflight(forward);
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

  if (!['linux', 'darwin', 'win32'].includes(preflight.remotePlatform)) {
    return toRemoteEnsureReadyResult(forward, preflight, {
      status: 'unsupported',
      installPhase: 'checking',
      message: `Remote OS ${preflight.remotePlatform || 'unknown'} is not supported yet. Linux, macOS, or Windows is required for auto-install.`,
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
  const remoteArchiveExtension = REMOTE_RUNTIME_TARGETS[preflight.remoteTarget]?.archiveExtension || 'tar.gz';
  const remoteArchivePath = `~/${REMOTE_HOME_DIRNAME}/tmp/elevenex-${bundledVersion}-${preflight.remoteTarget}.${remoteArchiveExtension}`;
  const remoteReleaseDir = `~/${REMOTE_HOME_DIRNAME}/releases/${bundledVersion}-${preflight.remoteTarget}`;
  const remoteCurrentLink = `~/${REMOTE_HOME_DIRNAME}/current`;
  const remoteCurrentRoot = `~/${REMOTE_HOME_DIRNAME}/current`;
  const remoteCommandOptions = { remotePlatform: preflight.remotePlatform };
  const installCommand = preflight.remotePlatform === 'win32'
    ? buildWindowsRemoteInstallCommand
    : buildRemoteInstallCommand;
  const startCommand = preflight.remotePlatform === 'win32'
    ? buildWindowsRemoteStartCommand
    : buildRemoteStartCommand;
  const waitCommand = preflight.remotePlatform === 'win32'
    ? buildWindowsRemoteWaitForReadyCommand
    : buildRemoteWaitForReadyCommand;
  // Resolved before the backend starts, because the start command has to bake
  // the socket path into the daemon's environment; the tunnel then binds that
  // same path a few steps later. Null whenever the host does not forward an
  // agent, which leaves both the start command and the tunnel untouched.
  // The `ssh -G` dump is kept so the tunnel below reuses it instead of paying
  // for a second resolve.
  const resolvedSshOutput = forward.transport === 'wsl'
    ? ''
    : await resolveSshConfigOutput(forward);
  const agentForward = resolveAgentForwardPlan(forward, preflight, resolvedSshOutput);

  if (installStatus === 'missing' || installStatus === 'needs-update') {
    emitRemoteServerPhaseEvent(forward.id, 'uploading');
    await runSshCommandAsync(
      forward,
      preflight.remotePlatform === 'win32'
        ? `New-Item -ItemType Directory -Force -Path (Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\tmp"), (Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\releases"), (Join-Path $HOME "${REMOTE_HOME_DIRNAME}\\logs") | Out-Null`
        : `mkdir -p "$HOME/${REMOTE_HOME_DIRNAME}/tmp" "$HOME/${REMOTE_HOME_DIRNAME}/releases" "$HOME/${REMOTE_HOME_DIRNAME}/logs"`,
      remoteCommandOptions,
    );

    const downloadUrl = buildRemoteRuntimeDownloadUrl(bundledVersion, preflight.remoteTarget);
    if (!downloadUrl) {
      throw new Error(`Remote runtime download URL could not be resolved for ${bundledVersion}.`);
    }
    const downloaded = await tryRemoteDownloadAsync(forward, downloadUrl, remoteArchivePath, preflight.remotePlatform);

    if (!downloaded) {
      throw new Error(
        `Failed to download remote runtime artifact ${downloadUrl} on ${forward.sshHost}.`,
      );
    }

    emitRemoteServerPhaseEvent(forward.id, 'installing');
    await runSshCommandAsync(
      forward,
      installCommand({
        remoteArchivePath,
        remoteReleaseDir,
        remoteCurrentLink,
      }),
      remoteCommandOptions,
    );
  }

  if (needsRuntimeRestart) {
    emitRemoteServerPhaseEvent(forward.id, 'starting');
    await runSshCommandAsync(
      forward,
      startCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        forcePortCleanup: preflight.backendReachable && (
          installStatus === 'needs-update'
          || runningVersionMismatch
        ),
        agentSocketPath: agentForward?.remoteSocket,
      }),
      remoteCommandOptions,
    );
  }

  await runSshCommandAsync(
    forward,
    waitCommand({
      remoteRoot: remoteCurrentRoot,
      remotePort: forward.remotePort || 11111,
      expectedVersion: bundledVersion,
    }),
    remoteCommandOptions,
  );

  emitRemoteServerPhaseEvent(forward.id, 'probing');

  // WSL2 shares localhost with Windows automatically, so there is no tunnel to
  // start — the wait command above already blocked (from inside the distro)
  // until the backend was listening on forward.remotePort. All that is left is
  // to confirm Windows can actually reach it on the same port.
  if (forward.transport === 'wsl') {
    const reachable = await probeElevenexBackendWithRetries(forward.localPort, 10, 300);
    if (!reachable) {
      return toRemoteEnsureReadyResult(forward, preflight, {
        status: 'error',
        installPhase: 'probing',
        message: 'The Elevenex backend started inside WSL but is not reachable from Windows on '
          + `127.0.0.1:${forward.localPort}. WSL2 normally forwards localhost automatically — check `
          + 'that no firewall rule or the WSL "localhostForwarding" setting is blocking it, then retry.',
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

  let runtime = await startSshForwardRuntime({
    ...forward,
    agentForward,
    probeType: 'elevenex-backend',
  }, resolvedSshOutput);

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
      startCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        forcePortCleanup: true,
        agentSocketPath: agentForward?.remoteSocket,
      }),
      remoteCommandOptions,
    );

    await runSshCommandAsync(
      forward,
      waitCommand({
        remoteRoot: remoteCurrentRoot,
        remotePort: forward.remotePort || 11111,
        expectedVersion: bundledVersion,
      }),
      remoteCommandOptions,
    );

    emitRemoteServerPhaseEvent(forward.id, 'probing');
    runtime = await startSshForwardRuntime({
      ...forward,
      agentForward,
      probeType: 'elevenex-backend',
    }, resolvedSshOutput);
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

// Entry point for the singleton WSL backend connection (no saved/named config,
// unlike SSH servers — see onboarding.model.ts SavedServer vs the plain
// `wsl` snapshot field). Picks WSL's own default distro when none is given,
// then delegates to the same preflight/install/start/wait/probe pipeline used
// for a real SSH-to-Linux remote (ensureRemoteServerReady dispatches its
// transport off `forward.transport`).
async function ensureWslServerReady(distroName) {
  if (process.platform !== 'win32') {
    throw new Error('WSL is only available on Windows.');
  }

  if (!isWslCliAvailable()) {
    throw new Error('WSL is not installed. Install it with `wsl --install`, then restart Elevenex.');
  }

  const distros = listWslDistros();
  if (distros.length === 0) {
    throw new Error('No WSL Linux distribution is installed. Install one (e.g. `wsl --install -d Ubuntu`), then retry.');
  }

  const targetDistro = distroName
    ? distros.find((distro) => distro.name === distroName)
    : getDefaultWslDistro(distros);

  if (!targetDistro) {
    throw new Error(`WSL distribution "${distroName}" was not found.`);
  }

  if (targetDistro.wslVersion !== 2) {
    throw new Error(
      `"${targetDistro.name}" is running WSL version ${targetDistro.wslVersion}, but Elevenex needs WSL2 `
      + `to share localhost with Windows. Upgrade it with \`wsl --set-version ${targetDistro.name} 2\`, then retry.`,
    );
  }

  // No SSH tunnel means local and remote are literally the same port on
  // 127.0.0.1 once WSL2's localhost forwarding kicks in.
  const port = await getFreePort();
  const forward = {
    id: WSL_SERVER_ID,
    transport: 'wsl',
    distroName: targetDistro.name,
    sshHost: targetDistro.name,
    localPort: port,
    remotePort: port,
    probeType: 'elevenex-backend',
  };

  return ensureRemoteServerReady(forward);
}

function waitForLocalPortBound(address, port, timeoutMs) {
  const host = address === '0.0.0.0' ? '127.0.0.1' : address;
  const deadline = Date.now() + timeoutMs;
  const poll = (resolve) => {
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('error', () => {
      setTimeout(() => poll(resolve), 150);
    });
    socket.setTimeout(200, () => { socket.destroy(); setTimeout(() => poll(resolve), 150); });
    socket.connect(port, host);
  };
  return new Promise(poll);
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

// Shared by the WSL path (localhost forwarding to Windows can lag the
// wait-command's in-distro readiness poll by a beat) and the SSH tunnel path
// (the first request through a freshly bound -L listener still has to open a
// new forwarded channel and round-trip the real remote host). Both hops can
// outlast a single probe's timeout even though the backend itself is ready,
// so retry briefly instead of concluding it is missing after one attempt.
async function probeElevenexBackendWithRetries(localPort, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probeElevenexBackend(localPort)) {
      return true;
    }
    if (attempt < attempts - 1) {
      await wait(delayMs);
    }
  }
  return false;
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

async function startSshForwardRuntime(forward, resolvedSshOutput) {
  const existing = sshForwardRuntimes.get(forward.id);
  if (existing && (existing.status === 'connecting' || existing.status === 'active')) {
    return toSshRuntimeView(forward.id, existing);
  }

  assertNoSshBindConflict(forward);

  const resolvedConfig = buildResolvedSshConfig(forward, resolvedSshOutput);
  const askPass = createSshAskPassRuntime(forward);
  const target = forward.sshHost;
  const bindSpec = `${forward.bindAddress}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`;
  const batchMode = askPass ? 'no' : 'yes';
  // Set only when resolveAgentForwardPlan found an agent worth carrying, which
  // already rules out non-POSIX remotes — so the keepalive below can safely be
  // a POSIX shell one-liner.
  const keepsAgentSession = Boolean(forward.agentForward);
  const spawnArgs = [
    '-F',
    resolvedConfig.configPath,
    // `-T` keeps the session channel that agent forwarding rides on while still
    // refusing a TTY; `-N` opens no session at all.
    keepsAgentSession ? '-T' : '-N',
    '-L',
    bindSpec,
    // Do not abort on RemoteForward failures (eg. a user-defined gpg-agent
    // socket forward whose target path is already bound by another session).
    // The local LocalForward (-L) is validated separately by probing the
    // local port after spawn, so we don't need ssh to die for us here.
    '-o',
    'ExitOnForwardFailure=no',
    '-o',
    `BatchMode=${batchMode}`,
    // Fail fast when the host is unreachable so reconnect attempts don't hang on a
    // dead network (the frontend bounds the attempt too, but this returns sooner).
    '-o',
    'ConnectTimeout=10',
    // Detect a silently-dropped connection within ~30s and exit, which flips the
    // tunnel runtime status so recovery can react (backstop to the websocket signal).
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    target,
  ];
  if (keepsAgentSession) {
    spawnArgs.push(SSH_AGENT_SESSION_KEEPALIVE_COMMAND);
  }
  const childProcess = spawn(
    'ssh',
    spawnArgs,
    {
      // The keepalive reader blocks on stdin, so the pipe has to stay open for
      // as long as the tunnel does — it is never written to, and closing it
      // (or killing ssh) is what ends the remote session.
      stdio: [keepsAgentSession ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      env: askPass?.env ?? process.env,
    },
  );
  // ssh going away first turns any pending write into EPIPE; nothing writes
  // here, but an unhandled 'error' on the stream would still crash the process.
  childProcess.stdin?.on('error', () => {});

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
    // RemoteForward bind failures (eg. forwarded gpg-agent sockets already
    // taken by a parallel session) are non-fatal warnings — keep them in the
    // debug stream but don't surface them as the runtime's connection error.
    const isNonFatalForwardWarning = /remote port forwarding failed for listen (path|port)/i.test(message)
      || /Warning: remote port forwarding failed/i.test(message);
    if (!isNonFatalForwardWarning) {
      runtime.error = message;
    }
    runtime.stderrLines.push(message);
    runtime.stderrLines = runtime.stderrLines.slice(-20);
    runtime.debugDetails.stderr = [...runtime.stderrLines];
    runtime.debugDetails.lastEvent = 'stderr';
    console.error('[ssh-forward] stderr', {
      id: forward.id,
      pid: runtime.pid,
      message,
      nonFatal: isNonFatalForwardWarning,
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

  const portBound = await waitForLocalPortBound(forward.bindAddress, forward.localPort, SSH_PORT_BOUND_TIMEOUT_MS);
  {
    const current = sshForwardRuntimes.get(forward.id);
    if (current === runtime && current.status === 'connecting') {
      if (portBound) {
        runtime.status = 'active';
        runtime.error = null;
        runtime.debugDetails.lastEvent = 'active';
        console.info('[ssh-forward] active', {
          id: forward.id,
          pid: runtime.pid,
          target,
          bindSpec,
        });
      } else {
        runtime.status = 'error';
        runtime.error = runtime.error || 'SSH tunnel port was not bound within the timeout.';
        runtime.debugDetails.lastEvent = 'activation-timeout';
        console.error('[ssh-forward] port not bound within timeout', {
          id: forward.id,
          pid: runtime.pid,
          target,
          bindSpec,
        });
      }
    }
  }

  const current = sshForwardRuntimes.get(forward.id);
  if (
    current
    && current.status === 'active'
    && forward.probeType === 'elevenex-backend'
  ) {
    // A bound local listener only means ssh accepted the -L socket, not that
    // the first request through it will complete quickly: routing it forwards
    // a brand-new SSH channel to the real remote host, which pays a full
    // network round trip the single-shot 1.8s probe timeout can lose even
    // though the backend (already confirmed ready via the wait command run
    // over the same SSH connection) is perfectly healthy. Retry briefly
    // instead of concluding the backend is missing and tearing it down.
    const probeSucceeded = await probeElevenexBackendWithRetries(forward.localPort, 5, 500);
    current.installStatus = probeSucceeded ? 'available' : 'missing';
    if (!probeSucceeded) {
      current.status = 'error';
      // Preserve a specific stderr error if one was already captured (eg. a
      // local -L bind failure such as "bind: Address already in use"); the
      // generic unreachable message would mask the real reason.
      if (!current.error) {
        current.error = `Elevenex is not reachable on ${forward.sshHost}.`;
      }
      current.debugDetails.lastEvent = 'probe-missing';
    }
  }

  return toSshRuntimeView(forward.id, sshForwardRuntimes.get(forward.id));
}

async function stopSshForwardRuntime(id) {
  // The cached readiness result is only valid while the tunnel it was measured
  // through is alive.
  readyRemoteServers.delete(id);

  const runtime = sshForwardRuntimes.get(id);
  if (!runtime) {
    return toSshRuntimeView(id, null);
  }

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

// Browser views live in a process-wide map but their keys (project:<id>:tab:<n>)
// are only unique inside one renderer. Namespacing them by window keeps two
// windows showing the same project from stealing each other's view; the
// renderer never sees the prefix.
function toBrowserViewKey(windowId, browserKey) {
  return `${windowId}::${browserKey}`;
}

function splitBrowserViewKey(viewKey) {
  const separatorIndex = `${viewKey || ''}`.indexOf('::');
  if (separatorIndex === -1) {
    return { windowId: null, browserKey: `${viewKey || ''}` };
  }
  return {
    windowId: viewKey.slice(0, separatorIndex),
    browserKey: viewKey.slice(separatorIndex + 2),
  };
}

function getProjectIdFromBrowserKey(viewKey) {
  const { browserKey } = splitBrowserViewKey(viewKey);
  const match = /^project:(\d+)(?::tab:.+)?$/.exec(browserKey);
  return match ? Number(match[1]) : null;
}

// Partitions stay keyed on the project alone, deliberately: they hold real
// logged-in sessions, and re-keying them by window (or by backend) would sign
// the user out of every site open in a browser panel.
function getIsolatedPartition(viewKey) {
  const projectId = getProjectIdFromBrowserKey(viewKey);
  return projectId === null ? SHARED_PARTITION : `persist:elevenex-browser:${projectId}`;
}

function getPartitionForRuntimeContext(viewKey, runtimeContext) {
  return runtimeContext === 'shared' ? SHARED_PARTITION : getIsolatedPartition(viewKey);
}

function getBrowserViewOwner(viewKey) {
  const entry = browserViews.get(viewKey);
  const win = entry?.ownerWindow;
  return win && !win.isDestroyed() ? win : null;
}

function getBrowserViewBackendOrigin(viewKey) {
  const { windowId } = splitBrowserViewKey(viewKey);
  return (windowId && windowRegistry.backendOriginOf(windowId)) || getDefaultBackendUrl();
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

// `backendUrl` must be the origin of the window that owns the view or auth
// window (see mcp-proxy-url.cjs); falling back to the process default only
// covers callers that have no window context at all.
function rewriteLocalhostToProxy(url, backendUrl) {
  return rewriteMcpCallbackToProxy(url, backendUrl || getDefaultBackendUrl());
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

function getBrowserState(viewKey) {
  const entry = browserViews.get(viewKey);
  if (!entry) {
    return null;
  }

  const { webContents, lastError } = entry.view;

  return {
    // The renderer only knows its own unprefixed key.
    key: splitBrowserViewKey(viewKey).browserKey,
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

function broadcastBrowserState(viewKey) {
  const ownerWindow = getBrowserViewOwner(viewKey);
  if (!ownerWindow) {
    return;
  }

  const state = getBrowserState(viewKey);
  if (state) {
    ownerWindow.webContents.send('elevenex-browser:state-changed', state);
  }
}

function clearAttachedBrowserKey(viewKey) {
  const { windowId } = splitBrowserViewKey(viewKey);
  if (windowId && attachedBrowserKeys.get(windowId) === viewKey) {
    attachedBrowserKeys.delete(windowId);
  }
}

function detachBrowserView(viewKey) {
  const entry = browserViews.get(viewKey);
  if (!entry) {
    return;
  }

  detachDevToolsView(viewKey);

  const ownerWindow = getBrowserViewOwner(viewKey);
  if (!entry.attached || !ownerWindow) {
    entry.attached = false;
    clearAttachedBrowserKey(viewKey);
    return;
  }

  try {
    ownerWindow.contentView.removeChildView(entry.view);
  } catch {
    // Ignore duplicate detach attempts.
  }

  entry.attached = false;
  clearAttachedBrowserKey(viewKey);
}

function attachBrowserView(viewKey, layout, ownerWindow) {
  const entry = ensureBrowserView(viewKey, undefined, { ownerWindow });
  const targetWindow = ownerWindow ?? getBrowserViewOwner(viewKey);
  if (!targetWindow) {
    throw new Error('Window is not available');
  }

  entry.layout = layout;

  const { windowId } = splitBrowserViewKey(viewKey);
  const previousKey = windowId ? attachedBrowserKeys.get(windowId) : null;
  if (previousKey && previousKey !== viewKey) {
    detachBrowserView(previousKey);
  }

  if (entry.attached) {
    try {
      targetWindow.contentView.removeChildView(entry.view);
    } catch {
      // Ignore duplicate detach attempts while refreshing z-order.
    }
  }

  targetWindow.contentView.addChildView(entry.view);
  entry.attached = true;

  entry.view.setBounds(layout.browserBounds);
  syncBrowserDevToolsView(viewKey, layout);
  if (windowId) {
    attachedBrowserKeys.set(windowId, viewKey);
  }

  return getBrowserState(viewKey);
}

function toSafeBrowserBounds(bounds) {
  return {
    x: Math.max(0, Math.round(Number(bounds?.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds?.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds?.width) || 0)),
    height: Math.max(1, Math.round(Number(bounds?.height) || 0)),
  };
}

function getBrowserEntryNavigationState(viewKey) {
  const entry = browserViews.get(viewKey);
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

async function loadBrowserUrl(viewKey, targetUrl, options = {}) {
  const ownerWindow = options.ownerWindow ?? getBrowserViewOwner(viewKey);
  const normalizedUrl = rewriteLocalhostToProxy(
    normalizeBrowserUrl(targetUrl),
    getBrowserViewBackendOrigin(viewKey),
  );
  const existing = browserViews.get(viewKey);
  const navigationState = options.navigationState
    || getBrowserEntryNavigationState(viewKey)
    || {
      attached: false,
      devtoolsVisible: false,
      layout: null,
      isolationConfig: options.isolationConfig || null,
    };
  const isolationConfig = options.isolationConfig ?? navigationState.isolationConfig ?? existing?.isolationConfig ?? null;
  const runtimeContext = options.runtimeContext ?? resolveRuntimeContext(viewKey, isolationConfig, normalizedUrl);
  const entry = ensureBrowserView(viewKey, isolationConfig, { runtimeContext, ownerWindow });

  entry.view.lastError = null;
  entry.devtoolsVisible = navigationState.devtoolsVisible;

  if (navigationState.layout) {
    entry.layout = navigationState.layout;
  }

  if (navigationState.attached && entry.layout) {
    attachBrowserView(viewKey, {
      ...entry.layout,
      devtoolsVisible: entry.devtoolsVisible,
    }, ownerWindow);
  }

  await entry.view.webContents.loadURL(normalizedUrl);
  return getBrowserState(viewKey);
}

function handleNavigationOutsideApp(url) {
  shell.openExternal(url).catch(() => {});
}

function shouldIgnoreMainFrameFlag(isMainFrame) {
  return typeof isMainFrame === 'boolean' && !isMainFrame;
}

function routeTopLevelNavigation(viewKey, targetUrl, options = {}) {
  if (!isInternalBrowserUrl(targetUrl)) {
    handleNavigationOutsideApp(targetUrl);
    return;
  }

  const entry = browserViews.get(viewKey);
  const ownerWindow = options.ownerWindow ?? getBrowserViewOwner(viewKey);
  const isolationConfig = options.isolationConfig ?? entry?.isolationConfig ?? null;
  const nextRuntimeContext = resolveRuntimeContext(viewKey, isolationConfig, targetUrl);
  const currentRuntimeContext = entry?.runtimeContext ?? resolveRuntimeContext(viewKey, isolationConfig);

  if (!entry || currentRuntimeContext === nextRuntimeContext) {
    if (options.source === 'window-open') {
      void loadBrowserUrl(viewKey, targetUrl, {
        isolationConfig,
        runtimeContext: nextRuntimeContext,
        ownerWindow,
      });
    }
    return;
  }

  const navigationState = getBrowserEntryNavigationState(viewKey);
  destroyBrowserView(viewKey);
  void loadBrowserUrl(viewKey, targetUrl, {
    isolationConfig,
    runtimeContext: nextRuntimeContext,
    navigationState,
    ownerWindow,
  }).catch(() => {});
}

function registerBrowserViewEvents(viewKey, view) {
  const syncState = () => broadcastBrowserState(viewKey);
  const proxyUrl = (url) => rewriteLocalhostToProxy(url, getBrowserViewBackendOrigin(viewKey));

  view.lastError = null;
  view.webContents.setWindowOpenHandler(({ url }) => {
    const proxied = proxyUrl(url);
    if (isInternalBrowserUrl(proxied)) {
      routeTopLevelNavigation(viewKey, proxied, { source: 'window-open' });
    } else {
      handleNavigationOutsideApp(proxied);
    }

    return { action: 'deny' };
  });

  view.webContents.on('will-navigate', (event, url, _isInPlace, isMainFrame) => {
    if (shouldIgnoreMainFrameFlag(isMainFrame)) {
      return;
    }

    const proxied = proxyUrl(url);
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

    const entry = browserViews.get(viewKey);
    if (!entry) {
      return;
    }

    const nextRuntimeContext = resolveRuntimeContext(viewKey, entry.isolationConfig, url);
    if (entry.runtimeContext !== nextRuntimeContext) {
      event.preventDefault();
      routeTopLevelNavigation(viewKey, url, { source: 'will-navigate' });
    }
  });

  view.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (shouldIgnoreMainFrameFlag(isMainFrame)) {
      return;
    }

    const proxied = proxyUrl(url);
    if (proxied !== url) {
      event.preventDefault();
      void view.webContents.loadURL(proxied);
      return;
    }

    const entry = browserViews.get(viewKey);
    if (!entry) {
      return;
    }

    const nextRuntimeContext = resolveRuntimeContext(viewKey, entry.isolationConfig, url);
    if (entry.runtimeContext !== nextRuntimeContext) {
      event.preventDefault();
      routeTopLevelNavigation(viewKey, url, { source: 'will-redirect' });
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
    const entry = browserViews.get(viewKey);
    if (entry) {
      entry.devtoolsVisible = false;
      detachDevToolsView(viewKey);
    }
    syncState();
  });
}

function ensureBrowserView(viewKey, isolationConfig, options = {}) {
  const existing = browserViews.get(viewKey);
  const runtimeContext = options.runtimeContext
    || existing?.runtimeContext
    || resolveRuntimeContext(viewKey, isolationConfig);

  if (existing && existing.runtimeContext === runtimeContext) {
    if (isolationConfig) {
      existing.isolationConfig = isolationConfig;
    }
    if (options.ownerWindow) {
      existing.ownerWindow = options.ownerWindow;
    }
    return existing;
  }

  const ownerWindow = options.ownerWindow ?? existing?.ownerWindow ?? null;
  if (existing) {
    destroyBrowserView(viewKey);
  }

  const partition = getPartitionForRuntimeContext(viewKey, runtimeContext);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
    },
  });

  registerBrowserViewEvents(viewKey, view);
  const entry = {
    view,
    // The window this view is parented to. Views are process-wide, windows are
    // not: attaching, detaching and state pushes all have to target this one.
    ownerWindow,
    attached: false,
    devtoolsView: null,
    devtoolsAttached: false,
    devtoolsVisible: false,
    partition,
    runtimeContext,
    isolationConfig: isolationConfig || null,
    layout: null,
  };
  browserViews.set(viewKey, entry);
  view.webContents.loadURL('about:blank');

  return entry;
}

function ensureBrowserDevToolsView(viewKey) {
  const entry = ensureBrowserView(viewKey);
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

function detachDevToolsView(viewKey) {
  const entry = browserViews.get(viewKey);
  if (!entry?.devtoolsView || !entry.devtoolsAttached) {
    return;
  }

  const ownerWindow = getBrowserViewOwner(viewKey);
  if (ownerWindow) {
    try {
      ownerWindow.contentView.removeChildView(entry.devtoolsView);
    } catch {
      // Ignore duplicate detach attempts.
    }
  }

  entry.devtoolsAttached = false;
}

function destroyDevToolsView(viewKey) {
  const entry = browserViews.get(viewKey);
  if (!entry?.devtoolsView) {
    return;
  }

  detachDevToolsView(viewKey);

  if (!entry.devtoolsView.webContents.isDestroyed()) {
    entry.devtoolsView.webContents.destroy();
  }

  entry.devtoolsView = null;
  entry.devtoolsAttached = false;
}

function syncBrowserDevToolsView(viewKey, layout) {
  const entry = browserViews.get(viewKey);
  const ownerWindow = getBrowserViewOwner(viewKey);
  if (!entry || !ownerWindow || !layout.devtoolsVisible || !layout.devtoolsBounds) {
    detachDevToolsView(viewKey);
    return;
  }

  ensureBrowserDevToolsView(viewKey);

  if (entry.devtoolsAttached) {
    try {
      ownerWindow.contentView.removeChildView(entry.devtoolsView);
    } catch {
      // Ignore duplicate detach attempts while refreshing z-order.
    }
  }

  ownerWindow.contentView.addChildView(entry.devtoolsView);
  entry.devtoolsAttached = true;

  if (!entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.openDevTools({ mode: 'detach', activate: false });
  }

  entry.devtoolsView.setBounds(layout.devtoolsBounds);
}

function destroyBrowserView(viewKey) {
  const entry = browserViews.get(viewKey);
  if (!entry) {
    return;
  }

  detachBrowserView(viewKey);
  if (entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.closeDevTools();
  }
  destroyDevToolsView(viewKey);
  browserViews.delete(viewKey);
  if (!entry.view.webContents.isDestroyed()) {
    entry.view.webContents.destroy();
  }
}

function destroyBrowserViewsForWindow(windowId) {
  const prefix = `${windowId}::`;
  for (const viewKey of Array.from(browserViews.keys())) {
    if (viewKey.startsWith(prefix)) {
      destroyBrowserView(viewKey);
    }
  }
  attachedBrowserKeys.delete(windowId);
}

// Where a brand-new window should open. Sizing/positioning is derived from the
// windows already on screen so a second window is visibly a second window
// rather than a pixel-perfect overlay of the first.
function resolveNewWindowBounds(restored) {
  const displays = screen.getAllDisplays();
  if (restored?.bounds) {
    return { bounds: clampBoundsToDisplays(restored.bounds, displays) };
  }

  const reference = windowRegistry.focused()?.win ?? null;
  const workArea = (reference
    ? screen.getDisplayMatching(reference.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  ).workArea;

  const base = reference
    ? reference.getNormalBounds()
    : { ...DEFAULT_WINDOW_BOUNDS };
  const taken = windowRegistry.all().map((entry) => entry.win.getBounds());
  const cascaded = cascadeBounds(taken, base, workArea);

  return { bounds: clampBoundsToDisplays(cascaded, displays) };
}

function applyWindowTitle(win, envRef) {
  if (!win || win.isDestroyed()) {
    return;
  }

  const label = normalizeEnvironmentRef(envRef).label;
  // Mission Control, Alt-Tab, the taskbar and the Window menu all read this —
  // it is the only way to tell two windows apart without focusing them.
  win.setTitle(label ? `${label} — ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME);
}

function notifyWindowsChanged() {
  const payload = windowRegistry.list();
  windowRegistry.broadcast('elevenex-windows:changed', payload);
  installMenu();
}

async function createAppWindow(options = {}) {
  const envRef = normalizeEnvironmentRef(options.env ?? LOCAL_ENVIRONMENT_REF);

  // Allocate the embedded backend's port before resolving the frontend target so
  // the backend URL handed to the renderer/preload reflects the real (random) port.
  if (shouldUseEmbeddedBackend()) {
    await ensureEmbeddedBackendPort();
  }

  const frontendTarget = getFrontendTarget();
  const isMac = process.platform === 'darwin';
  const appIconPath = getAppIconPath();

  if (frontendTarget.useEmbeddedBackend) {
    try {
      // The backend may bind a different port than first computed (retry on
      // EADDRINUSE), so adopt the origin it actually bound for the renderer.
      // Concurrent restores share one start (see startEmbeddedBackend).
      frontendTarget.backendUrl = await startEmbeddedBackend();
    } catch (error) {
      dialog.showErrorBox(
        'Embedded Backend Failed to Start',
        error instanceof Error ? error.message : 'Unknown backend startup error',
      );
      throw error;
    }
  }

  const windowId = options.windowId || windowRegistry.nextWindowId();
  const placement = resolveNewWindowBounds(options.restore);

  const win = new BrowserWindow({
    ...(placement.bounds ?? DEFAULT_WINDOW_BOUNDS),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: APP_DISPLAY_NAME,
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
        // Lets the renderer namespace its per-window state (open tabs, layout,
        // active environment) without colliding with the other windows, which
        // share one Chromium profile and therefore one localStorage.
        `--elevenex-window-id=${windowId}`,
        `--elevenex-window-environment=${encodeURIComponent(JSON.stringify(envRef))}`,
      ],
    },
  });

  windowRegistry.register(win, {
    id: windowId,
    env: envRef,
    backendOrigin: frontendTarget.backendUrl,
  });
  connectionRegistry.acquire(windowId, envRef);
  applyWindowTitle(win, envRef);

  if (frontendTarget.kind === 'file') {
    win.loadFile(frontendTarget.value);
  } else {
    win.loadURL(frontendTarget.value);
  }

  // Intercept all new-window requests (target="_blank" links) and open them in
  // the system browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Determine the app's own origin so we can allow SPA navigations while
  // redirecting any external link clicks to the system browser.
  const appOrigin =
    frontendTarget.kind === 'file' ? null : new URL(frontendTarget.value).origin;

  win.webContents.on('will-navigate', (event, url) => {
    if (frontendTarget.kind === 'file' && url.startsWith('file://')) {
      return;
    }
    if (appOrigin && url.startsWith(appOrigin)) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  if (debugFrontend) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  const onWindowState = () => {
    emitWindowState(win);
    persistWindowLayout();
  };

  win.on('maximize', onWindowState);
  win.on('unmaximize', onWindowState);
  win.on('enter-full-screen', onWindowState);
  win.on('leave-full-screen', onWindowState);
  win.on('resize', persistWindowLayout);
  win.on('move', persistWindowLayout);
  win.on('focus', () => {
    windowRegistry.markFocused(windowId);
    emitWindowState(win);
    persistWindowLayout();
  });
  win.on('blur', () => emitWindowState(win));

  win.once('ready-to-show', () => {
    closeInstallWindow();
    if (options.restore?.maximized) {
      win.maximize();
    }
    if (options.restore?.fullScreen) {
      win.setFullScreen(true);
    }
    win.show();
    emitWindowState(win);
  });

  win.on('close', (event) => {
    if (reloadingWindowIds.has(windowId) || isAppQuitting) {
      return;
    }

    // Closing the *last* window on macOS quits, matching this app's long-
    // standing behaviour and its lack of dock-only state. Closing any other
    // window just closes that window — quitting the whole app because one of
    // several windows was dismissed would be a serious surprise.
    if (process.platform === 'darwin' && windowRegistry.count() <= 1) {
      event.preventDefault();
      requestAppQuit();
    }
  });

  win.on('closed', () => {
    destroyBrowserViewsForWindow(windowId);
    windowRegistry.unregister(windowId);

    // A reload destroys and immediately rebuilds the same window id. Releasing
    // its lease in between would drop the refcount to zero and tear down a
    // tunnel the window is about to reconnect to.
    if (reloadingWindowIds.has(windowId)) {
      return;
    }

    dropRemoteServerInterestForWindow(windowId);
    connectionRegistry.releaseAll(windowId);
    persistWindowLayout();
    notifyWindowsChanged();
  });

  persistWindowLayout();
  notifyWindowsChanged();

  return { win, windowId };
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
          <input id="backendUrl" type="url" placeholder="${getDefaultBackendUrl()}" />
          <span class="hint">Used for API, WebSocket, and socket.io traffic.</span>
        </label>
        <label>
          Frontend URL
          <input id="frontendUrl" type="url" placeholder="${debugFrontend ? getDefaultBackendUrl() : 'Use built local frontend if available'}" />
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

  const parentWindow = windowRegistry.focused()?.win ?? null;
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: !!parentWindow,
    parent: parentWindow ?? undefined,
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

// Tears a window down and rebuilds it in place, keeping its geometry and its
// environment. Used by "Reload App" and by a Connection Settings change, both
// of which need the preload's injected backend origin re-evaluated.
async function reloadAppWindow(target) {
  const entry = target ?? windowRegistry.focused();
  if (!entry || entry.win.isDestroyed()) {
    return;
  }

  const { id: windowId, win, env } = entry;
  const bounds = win.getBounds();
  const wasDevToolsOpen = win.webContents.isDevToolsOpened();

  reloadingWindowIds.add(windowId);

  let created = null;
  try {
    win.destroy();
    // Reuse the id so the window keeps its per-window renderer state (open
    // tabs, layout) and its slot in the persisted layout.
    created = await createAppWindow({ env, windowId, restore: { bounds } });
  } finally {
    reloadingWindowIds.delete(windowId);
  }

  if (!created || created.win.isDestroyed()) {
    return;
  }

  created.win.setBounds(bounds);

  if (wasDevToolsOpen && !created.win.webContents.isDevToolsOpened()) {
    created.win.webContents.openDevTools({ mode: 'detach' });
  }
}

function reloadAllAppWindows() {
  return windowRegistry.all().reduce(
    (chain, entry) => chain.then(() => reloadAppWindow(entry)),
    Promise.resolve(),
  );
}

// New windows inherit the focused window's environment: its tunnel is already
// up, so the window opens instantly, and "another window on what I'm working
// on" is overwhelmingly the common case. A window on a *different* environment
// is one click away in the environment switcher.
function openWindowForFocusedEnvironment() {
  const env = windowRegistry.focused()?.env ?? LOCAL_ENVIRONMENT_REF;
  return createAppWindow({ env }).catch((error) => {
    console.error('[windows] could not open a new window', error);
  });
}

function buildWindowListMenuItems() {
  const windows = windowRegistry.list();
  if (windows.length < 2) {
    return [];
  }

  return [
    { type: 'separator' },
    ...windows.map((entry) => ({
      label: entry.label || APP_DISPLAY_NAME,
      type: 'radio',
      checked: entry.focused,
      click: () => windowRegistry.focusWindow(entry.windowId),
    })),
  ];
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const appMenuItems = [
    {
      label: 'Connection Settings...',
      click: () => openSettingsWindow(),
    },
    {
      label: 'Reload Window',
      ...(!app.isPackaged ? { accelerator: 'CmdOrCtrl+R' } : {}),
      click: () => void reloadAppWindow(),
    },
  ];

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        ...appMenuItems,
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
        ...appMenuItems,
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]),
    {
      // Windows/Linux render no menu bar (the app is frameless there), so this
      // is a macOS convenience and an accelerator host — the discoverable
      // entry points for multi-window live in the environment switcher UI.
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => void openWindowForFocusedEnvironment(),
        },
        { type: 'separator' },
        { role: 'close', label: 'Close Window' },
      ],
    },
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
            ]
          : [{ role: 'close' }]),
        // Named by environment so the list is actually useful with several
        // windows open — "Elevenex, Elevenex, Elevenex" would not be.
        ...buildWindowListMenuItems(),
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
    // The backend/frontend override is process-wide, so every window has to
    // pick up the new origin, not just the one that opened Settings.
    void reloadAllAppWindows();

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid settings',
    };
  }
});

// Every window-scoped handler resolves the *calling* window. Reaching for a
// global "main window" would make the custom title bar controls of one window
// act on another.
function senderWindowEntry(event) {
  return windowRegistry.fromWebContents(event?.sender) ?? null;
}

function senderWindow(event) {
  return senderWindowEntry(event)?.win ?? null;
}

ipcMain.handle('elevenex-window:get-environment', (event) => ({
  isElectron: true,
  platform: process.platform,
  usesNativeMacControls: process.platform === 'darwin',
  windowId: senderWindowEntry(event)?.id ?? null,
}));

ipcMain.handle('elevenex-window:minimize', (event) => {
  senderWindow(event)?.minimize();
});

ipcMain.handle('elevenex-window:maximize', (event) => {
  const win = senderWindow(event);
  if (win && !win.isMaximized()) {
    win.maximize();
  }
  return toWindowState(win);
});

ipcMain.handle('elevenex-window:unmaximize', (event) => {
  const win = senderWindow(event);
  if (win && win.isMaximized()) {
    win.unmaximize();
  }
  return toWindowState(win);
});

ipcMain.handle('elevenex-window:toggle-maximize', (event) => {
  const win = senderWindow(event);
  if (!win) {
    return toWindowState(null);
  }

  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }

  return toWindowState(win);
});

ipcMain.handle('elevenex-window:close', (event) => {
  senderWindow(event)?.close();
});

ipcMain.handle('elevenex-window:is-maximized', (event) => toWindowState(senderWindow(event)));

// ─── Multi-window ──────────────────────────────────────────────────────────────

ipcMain.handle('elevenex-windows:list', () => windowRegistry.list());

ipcMain.handle('elevenex-windows:open-new', async (event, payload) => {
  const env = payload?.env
    ? normalizeEnvironmentRef(payload.env)
    : (senderWindowEntry(event)?.env ?? LOCAL_ENVIRONMENT_REF);

  const { windowId } = await createAppWindow({ env });
  return windowId;
});

ipcMain.handle('elevenex-windows:focus', (_event, windowId) =>
  windowRegistry.focusWindow(`${windowId || ''}`));

// Called by the renderer on every environment switch. Without it the lease of
// the environment the window just left would never be released (its tunnel
// would stay up forever) and the persisted layout would restore the window on
// the wrong backend.
ipcMain.handle('elevenex-windows:set-environment', (event, payload) => {
  const entry = senderWindowEntry(event);
  if (!entry) {
    return false;
  }

  const env = normalizeEnvironmentRef(payload?.env);
  windowRegistry.setEnv(entry.id, env);
  windowRegistry.setBackendOrigin(entry.id, payload?.backendOrigin);
  connectionRegistry.setEnvironment(entry.id, env);
  // The connection is established: stop treating this window as merely
  // interested in the remote's install stream.
  if (env.mode === 'ssh' || env.mode === 'wsl') {
    removeRemoteServerInterest(env.serverId, entry.id);
  }
  applyWindowTitle(entry.win, env);
  persistWindowLayout();
  notifyWindowsChanged();
  return true;
});

// Fan-out channel for state that is global to the app but lives in renderer
// storage (theme, the saved-server catalogue). The DOM `storage` event is not
// dependable across separate BrowserWindows, so the main process relays.
ipcMain.handle('elevenex-windows:broadcast', (event, payload) => {
  const senderId = senderWindowEntry(event)?.id ?? null;
  const channel = `${payload?.channel || ''}`;
  if (!channel) {
    return false;
  }

  for (const entry of windowRegistry.all()) {
    if (entry.id === senderId) {
      continue;
    }
    windowRegistry.sendTo(entry.id, 'elevenex-windows:broadcast', {
      channel,
      payload: payload?.payload ?? null,
    });
  }

  return true;
});

ipcMain.handle('elevenex-app:restart', () => {
  // Relaunch a fresh instance, then quit the current one through the normal
  // shutdown path so the embedded backend child is terminated cleanly. On the
  // next launch the backend re-detects tmux.
  app.relaunch();
  requestAppQuit();
});

// Built lazily: the constructor touches app.getPath('userData'), which is only
// meaningful after app.setPath() has run, and there is no reason to hit disk for
// a feature the user may never open.
let appUpdater = null;

function getAppUpdater() {
  if (!appUpdater) {
    appUpdater = createAppUpdater({
      app,
      shell,
      getCurrentVersion: getBundledVersion,
      // App updates are process-wide: every window shows the same state.
      onStateChanged: (state) => windowRegistry.broadcast('elevenex-updates:state-changed', state),
      requestQuit: requestAppQuit,
    });
  }

  return appUpdater;
}

ipcMain.handle('elevenex-updates:get-state', () => getAppUpdater().getState());

ipcMain.handle('elevenex-updates:check', (_event, payload) =>
  getAppUpdater().check({ force: payload?.force === true }));

ipcMain.handle('elevenex-updates:install', () => getAppUpdater().downloadAndInstall());

ipcMain.handle('elevenex-updates:open-release-page', async () => {
  await getAppUpdater().openReleasePage();
  return true;
});

ipcMain.handle('elevenex-browser:is-supported', () => true);

ipcMain.handle('elevenex-external-links:open', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  await shell.openExternal(url);
  return true;
});

const authWindows = new Map();

function registerAuthWindowNavigationHandlers(authWindow, getBackendOrigin) {
  const proxyUrl = (url) => rewriteLocalhostToProxy(url, getBackendOrigin());

  authWindow.webContents.setWindowOpenHandler(({ url }) => {
    const proxied = proxyUrl(url);
    if (proxied !== url) {
      void authWindow.loadURL(proxied);
      return { action: 'deny' };
    }

    return { action: 'allow' };
  });

  authWindow.webContents.on('will-navigate', (event, url) => {
    const proxied = proxyUrl(url);
    if (proxied !== url) {
      event.preventDefault();
      void authWindow.loadURL(proxied);
    }
  });

  authWindow.webContents.on('will-redirect', (event, url) => {
    const proxied = proxyUrl(url);
    if (proxied !== url) {
      event.preventDefault();
      void authWindow.loadURL(proxied);
    }
  });
}

ipcMain.handle('elevenex-auth-window:open', async (event, payload) => {
  const url = typeof payload === 'string' ? payload : payload?.url;
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }

  const key = `${payload?.key || 'default'}`;
  const requestingEntry = senderWindowEntry(event);
  // The OAuth callback has to reach the backend of the window that started the
  // flow. Resolved lazily so a mid-flow environment switch is picked up.
  const resolveBackendOrigin = () =>
    (requestingEntry && windowRegistry.backendOriginOf(requestingEntry.id)) || getDefaultBackendUrl();

  let authWindow = authWindows.get(key);
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    void authWindow.loadURL(rewriteLocalhostToProxy(url, resolveBackendOrigin()));
    return true;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 400,
    minHeight: 500,
    parent: requestingEntry?.win ?? undefined,
    title: typeof payload?.title === 'string' && payload.title ? payload.title : 'Authentication',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:elevenex-auth:${key}`,
    },
  });

  authWindows.set(key, authWindow);
  registerAuthWindowNavigationHandlers(authWindow, resolveBackendOrigin);
  authWindow.on('closed', () => {
    if (authWindows.get(key) === authWindow) {
      authWindows.delete(key);
    }
  });

  await authWindow.loadURL(rewriteLocalhostToProxy(url, resolveBackendOrigin()));
  return true;
});

// Turns a renderer-scoped browser key into the process-wide view key, and
// hands back the window that owns it.
function resolveBrowserView(event, rawKey, { required = true } = {}) {
  const browserKey = `${rawKey || ''}`;
  if (!browserKey && required) {
    throw new Error('Browser key is required');
  }

  const entry = senderWindowEntry(event);
  if (!entry && required) {
    throw new Error('Window is not available');
  }

  return {
    viewKey: entry ? toBrowserViewKey(entry.id, browserKey) : browserKey,
    ownerWindow: entry?.win ?? null,
    windowId: entry?.id ?? null,
  };
}

ipcMain.handle('elevenex-browser:show', (event, payload) => {
  const { viewKey, ownerWindow } = resolveBrowserView(event, payload?.key);

  ensureBrowserView(viewKey, payload?.isolationConfig, { ownerWindow });
  return attachBrowserView(viewKey, ensureBrowserLayout(payload), ownerWindow);
});

ipcMain.handle('elevenex-browser:hide', (event, browserKey) => {
  const { viewKey } = resolveBrowserView(event, browserKey, { required: false });
  detachBrowserView(viewKey);
});

ipcMain.handle('elevenex-browser:close', (event, browserKey) => {
  const { viewKey } = resolveBrowserView(event, browserKey, { required: false });
  destroyBrowserView(viewKey);
});

ipcMain.handle('elevenex-browser:navigate', async (event, payload) => {
  const { viewKey, ownerWindow } = resolveBrowserView(event, payload?.key);

  const layout = payload?.bounds || payload?.browserBounds ? ensureBrowserLayout(payload) : null;
  const navigationState = layout
    ? {
      attached: true,
      devtoolsVisible: layout.devtoolsVisible,
      layout,
      isolationConfig: payload?.isolationConfig ?? null,
    }
    : undefined;

  return loadBrowserUrl(viewKey, payload?.url, {
    isolationConfig: payload?.isolationConfig,
    navigationState,
    ownerWindow,
  });
});

ipcMain.handle('elevenex-browser:back', (event, browserKey) => {
  const { viewKey, ownerWindow } = resolveBrowserView(event, browserKey);
  const entry = ensureBrowserView(viewKey, undefined, { ownerWindow });
  if (entry.view.webContents.navigationHistory.canGoBack()) {
    entry.view.webContents.navigationHistory.goBack();
  }
  return getBrowserState(viewKey);
});

ipcMain.handle('elevenex-browser:forward', (event, browserKey) => {
  const { viewKey, ownerWindow } = resolveBrowserView(event, browserKey);
  const entry = ensureBrowserView(viewKey, undefined, { ownerWindow });
  if (entry.view.webContents.navigationHistory.canGoForward()) {
    entry.view.webContents.navigationHistory.goForward();
  }
  return getBrowserState(viewKey);
});

ipcMain.handle('elevenex-browser:reload', (event, browserKey) => {
  const { viewKey, ownerWindow } = resolveBrowserView(event, browserKey);
  const entry = ensureBrowserView(viewKey, undefined, { ownerWindow });
  entry.view.lastError = null;
  entry.view.webContents.reload();
  return getBrowserState(viewKey);
});

ipcMain.handle('elevenex-browser:get-state', (event, browserKey) => {
  const { viewKey } = resolveBrowserView(event, browserKey, { required: false });
  if (!viewKey || !browserViews.has(viewKey)) {
    return null;
  }

  return getBrowserState(viewKey);
});

ipcMain.handle('elevenex-browser:set-devtools-visible', (event, payload) => {
  const { viewKey, ownerWindow, windowId } = resolveBrowserView(event, payload?.key);

  const entry = ensureBrowserView(viewKey, undefined, { ownerWindow });
  const layout = ensureBrowserLayout(payload);
  entry.devtoolsVisible = layout.devtoolsVisible;

  if (!layout.devtoolsVisible && entry.view.webContents.isDevToolsOpened()) {
    entry.view.webContents.closeDevTools();
  }
  if (!layout.devtoolsVisible) {
    destroyDevToolsView(viewKey);
  }

  if (attachedBrowserKeys.get(windowId) === viewKey && entry.attached) {
    attachBrowserView(viewKey, layout, ownerWindow);
  }

  broadcastBrowserState(viewKey);
  return getBrowserState(viewKey);
});

ipcMain.handle('elevenex-browser:update-isolation-config', (event, payload) => {
  const { projectId } = payload || {};
  if (!projectId) return;

  // Scoped to the calling window: another window may be showing the same
  // project against a different backend and must not have its tabs recycled.
  const windowId = senderWindowEntry(event)?.id;
  if (!windowId) return;

  const viewKeyPrefix = toBrowserViewKey(windowId, `project:${projectId}:tab:`);
  for (const viewKey of Array.from(browserViews.keys())) {
    if (viewKey.startsWith(viewKeyPrefix)) {
      destroyBrowserView(viewKey);
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

// "Stop" from a window means "I no longer need this tunnel" — not "kill it".
// With several windows open the tunnel may still be carrying another window's
// entire session, so it is only really torn down once nobody is left on it.
ipcMain.handle('elevenex-ssh-forwarding:stop', async (event, id) => {
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    throw new Error('Forward id is required');
  }

  const entry = senderWindowEntry(event);
  const envRef = environmentRefForServerId(numericId);

  if (entry) {
    removeRemoteServerInterest(numericId, entry.id);
    connectionRegistry.release(entry.id, envRef);
  }

  const remainingHolders = connectionRegistry.holders(envRef)
    .filter((windowId) => windowId !== entry?.id);
  const remainingInterest = [...(remoteServerInterest.get(numericId) ?? [])]
    .filter((windowId) => windowId !== entry?.id);

  if (remainingHolders.length > 0 || remainingInterest.length > 0) {
    return toSshRuntimeView(numericId, sshForwardRuntimes.get(numericId) ?? null);
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

ipcMain.handle('elevenex-ssh-forwarding:pick-identity-file', async (event) => {
  const result = await dialog.showOpenDialog(senderWindow(event) ?? undefined, {
    title: 'Choose an SSH private key',
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('elevenex-remote-server:ensure-ready', async (event, payload) => {
  const serverId = Number(payload?.id);
  if (!Number.isFinite(serverId) || serverId <= 0) {
    throw new Error('Remote server id is required');
  }

  const sshHost = `${payload?.sshHost || ''}`.trim();
  if (!sshHost) {
    throw new Error('SSH host is required');
  }

  const requestingWindowId = senderWindowEntry(event)?.id ?? null;
  // Register interest *before* any phase event can fire, so the window driving
  // the connection sees its own progress even though it does not hold the
  // environment's lease yet.
  addRemoteServerInterest(serverId, requestingWindowId);

  // A tunnel that is already up (another window is on this server) is reused
  // as-is: no reinstall, no second `ssh -L`, and the window opens instantly.
  const reused = reuseReadyRemoteServer(serverId);
  if (reused) {
    emitRemoteServerPhaseEvent(serverId, 'ready');
    return reused;
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
    // Two windows connecting to the same server share one run: a duplicated
    // preflight/install/probe over SSH would be slow, noisy on the remote, and
    // would race a second `ssh -L` onto the same port.
    result = await connectionRegistry.run(
      environmentRefForServerId(serverId),
      () => ensureRemoteServerReady(forward),
    );
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
      installGuidance: [],
      version: getRemoteRuntimeVersion(),
    };
  }
  recordRemoteServerResult(serverId, result);
  if (result.status === 'ready' || result.status === 'error' || result.status === 'unsupported') {
    destroyRemoteInstallerSessionForServer(forward.id);
  }
  if (result.status !== 'ready') {
    removeRemoteServerInterest(serverId, requestingWindowId);
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
      installGuidance: [],
      version: getRemoteRuntimeVersion(),
    };
  }
  recordRemoteServerResult(sessionState.forward.id, result);
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

  if (sessionState.hasTty && Number.isFinite(cols) && Number.isFinite(rows)) {
    sessionState.process.stdin.write(`stty cols ${Math.max(20, cols)} rows ${Math.max(5, rows)}\n`);
  }

  return true;
});

ipcMain.handle('elevenex-remote-server:close-session', (_event, sessionId) => {
  destroyRemoteInstallerSession(Number(sessionId));
  return true;
});

// ─── WSL backend (Windows-only, singleton — see ensureWslServerReady) ─────────
// recheck/send-input/resize/close-session and the installer-event/phase-update
// pushes are intentionally NOT duplicated here: they're already keyed by
// sessionId/serverId and never touch SSH-specific state, so the frontend's
// wslServer bridge reuses the elevenex-remote-server:* channels for those.

ipcMain.handle('elevenex-wsl-server:is-supported', () => process.platform === 'win32' && isWslCliAvailable());

ipcMain.handle('elevenex-wsl-server:list-distros', () => {
  if (process.platform !== 'win32') {
    return [];
  }
  return listWslDistros();
});

ipcMain.handle('elevenex-wsl-server:ensure-ready', async (event, payload) => {
  const distroName = `${payload?.distroName || ''}`.trim() || null;
  const requestingWindowId = senderWindowEntry(event)?.id ?? null;
  addRemoteServerInterest(WSL_SERVER_ID, requestingWindowId);

  let result;
  try {
    result = await connectionRegistry.run(
      environmentRefForServerId(WSL_SERVER_ID),
      () => ensureWslServerReady(distroName),
    );
  } catch (error) {
    console.error('[wsl-runtime] ensure-ready failed', {
      distroName,
      message: error instanceof Error ? error.message : `${error}`,
    });
    result = {
      status: 'error',
      installPhase: 'starting',
      installStatus: 'unknown',
      remotePlatform: 'unknown',
      remoteArch: 'unknown',
      missingDependencies: [],
      message: error instanceof Error ? error.message : 'WSL backend setup failed.',
      localPort: null,
      sessionId: null,
      osRelease: {},
      installGuidance: [],
      version: getRemoteRuntimeVersion(),
      distroName,
    };
  }
  recordRemoteServerResult(WSL_SERVER_ID, result);
  if (result.status === 'ready' || result.status === 'error' || result.status === 'unsupported') {
    destroyRemoteInstallerSessionForServer(WSL_SERVER_ID);
  }
  if (result.status !== 'ready') {
    removeRemoteServerInterest(WSL_SERVER_ID, requestingWindowId);
  }
  return result;
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

/**
 * Chromium denies `getUserMedia` by default in Electron, so dictation would
 * silently fail in the packaged app without this. Only the microphone is
 * granted, and only to the pages we load ourselves — an embedded browser tab
 * or a remote page asking for the camera still gets refused.
 */
function installMicrophonePermissionHandler() {
  const isTrustedOrigin = (url) => {
    if (!url) return false;
    if (url.startsWith('file://')) return true;
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission === 'media') {
        const wantsVideo = details?.mediaTypes?.includes('video');
        callback(!wantsVideo && isTrustedOrigin(webContents?.getURL()));
        return;
      }
      callback(false);
    },
  );

  // Chromium also consults this synchronously for some media checks; without
  // it the mic can appear permitted and then produce a silent stream.
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === 'media' && isTrustedOrigin(requestingOrigin),
  );
}

// Restores the layout from the previous run. Windows bound to a remote open
// straight away in their reconnecting state rather than blocking startup on
// SSH — the renderer's existing recovery flow takes it from there, including
// prompting for a password when the server needs one.
async function restoreSavedWindows() {
  const saved = await windowStateStore.load();
  if (saved.length === 0) {
    await createAppWindow({ env: LOCAL_ENVIRONMENT_REF });
    return;
  }

  for (const entry of saved) {
    try {
      await createAppWindow({
        env: entry.env,
        windowId: entry.id,
        restore: {
          bounds: entry.bounds,
          maximized: entry.maximized,
          fullScreen: entry.fullScreen,
        },
      });
    } catch (error) {
      console.error('[windows] could not restore a window', error);
    }
  }

  // Every restore failed (eg. the embedded backend refused to start for one of
  // them): never leave the user with a running app and no window.
  if (windowRegistry.count() === 0) {
    await createAppWindow({ env: LOCAL_ENVIRONMENT_REF });
  }
}

// Without the lock, launching the binary twice spawns a second process that
// fights the first over ~/.elevenex/elevenex.db and kills its backend through
// terminateStaleEmbeddedBackend(). Now that multiple windows are a first-class
// feature, a second launch simply means "open another window".
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  const focusedEntry = windowRegistry.focused();
  if (focusedEntry) {
    windowRegistry.focusWindow(focusedEntry.id);
  }
  void openWindowForFocusedEnvironment();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }

  app.setName('Elevenex');

  if (process.platform === 'win32') {
    // Associate the taskbar button (and its icon) with the app rather than the
    // host electron.exe, so Windows shows the Elevenex icon in the taskbar,
    // window list, and search results.
    app.setAppUserModelId('fr.leomelki.elevenex');
  }

  if (process.platform === 'darwin' && app.dock) {
    const macAppIcon = getMacAppIcon();
    if (macAppIcon) {
      app.dock.setIcon(macAppIcon);
    }
  }

  installMicrophonePermissionHandler();
  installMenu();
  await restoreSavedWindows();

  app.on('activate', () => {
    if (windowRegistry.count() === 0) {
      void createAppWindow({ env: LOCAL_ENVIRONMENT_REF });
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
