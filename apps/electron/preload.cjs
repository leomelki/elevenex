const { contextBridge, ipcRenderer } = require('electron');

function getArgumentValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

// The embedded backend runs on a random port, so the main process is the source
// of truth: it always passes --elevenex-backend-origin. The env/11111 fallbacks
// only apply to dev/non-embedded runs where the port is fixed.
const proxyPort = process.env.ELEVENEX_PROXY_PORT || process.env.FRONTEND_PORT || '11111';
const backendOrigin =
  getArgumentValue('elevenex-backend-origin') ||
  process.env.ELECTRON_BACKEND_URL ||
  `http://127.0.0.1:${proxyPort}`;
const mode =
  getArgumentValue('elevenex-runtime-mode') ||
  (process.env.ELECTRON_DEBUG_FRONTEND === '1' ? 'electron-debug' : 'electron-local');

// All windows share one Chromium profile, and therefore one localStorage. The
// window id is what lets the renderer namespace its per-window state (active
// environment, open tabs, layout) instead of clobbering the other windows'.
const windowId = getArgumentValue('elevenex-window-id') || 'w0';

function readInjectedEnvironment() {
  const raw = getArgumentValue('elevenex-window-environment');
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld('__ELEVENEX_RUNTIME__', {
  backendOrigin,
  apiBaseUrl: `${backendOrigin}/api`,
  mode,
  windowId,
  // The environment this window was opened on. Authoritative on first paint,
  // before the renderer has read its own per-window storage.
  windowEnvironment: readInjectedEnvironment(),
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('__ELEVENEX_ELECTRON__', {
  app: {
    restart: () => ipcRenderer.invoke('elevenex-app:restart'),
  },
  windows: {
    // The id itself is exposed on __ELEVENEX_RUNTIME__ (single source of
    // truth); this namespace is only the operations.
    list: () => ipcRenderer.invoke('elevenex-windows:list'),
    openNew: (env) => ipcRenderer.invoke('elevenex-windows:open-new', { env: env ?? null }),
    focus: (targetWindowId) => ipcRenderer.invoke('elevenex-windows:focus', targetWindowId),
    // Must be called on every environment switch: the main process owns the
    // refcounted tunnel leases and the persisted layout, and neither can follow
    // a switch it is not told about.
    setEnvironment: (payload) => ipcRenderer.invoke('elevenex-windows:set-environment', payload),
    onChanged: (callback) => subscribe('elevenex-windows:changed', callback),
    // Relay for app-global renderer state (theme, saved-server catalogue). The
    // DOM `storage` event is not dependable across BrowserWindows.
    broadcast: (channel, payload) =>
      ipcRenderer.invoke('elevenex-windows:broadcast', { channel, payload: payload ?? null }),
    onBroadcast: (callback) => subscribe('elevenex-windows:broadcast', callback),
  },
  windowControls: {
    getEnvironment: () => ipcRenderer.invoke('elevenex-window:get-environment'),
    minimize: () => ipcRenderer.invoke('elevenex-window:minimize'),
    maximize: () => ipcRenderer.invoke('elevenex-window:maximize'),
    unmaximize: () => ipcRenderer.invoke('elevenex-window:unmaximize'),
    toggleMaximize: () => ipcRenderer.invoke('elevenex-window:toggle-maximize'),
    close: () => ipcRenderer.invoke('elevenex-window:close'),
    isMaximized: () => ipcRenderer.invoke('elevenex-window:is-maximized'),
    onStateChanged: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-window:state-changed', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-window:state-changed', listener);
      };
    },
  },
  browser: {
    isSupported: () => ipcRenderer.invoke('elevenex-browser:is-supported'),
    show: (payload) => ipcRenderer.invoke('elevenex-browser:show', payload),
    hide: (key) => ipcRenderer.invoke('elevenex-browser:hide', key),
    close: (key) => ipcRenderer.invoke('elevenex-browser:close', key),
    navigate: (payload) => ipcRenderer.invoke('elevenex-browser:navigate', payload),
    back: (key) => ipcRenderer.invoke('elevenex-browser:back', key),
    forward: (key) => ipcRenderer.invoke('elevenex-browser:forward', key),
    reload: (key) => ipcRenderer.invoke('elevenex-browser:reload', key),
    getState: (key) => ipcRenderer.invoke('elevenex-browser:get-state', key),
    setDevToolsVisible: (payload) => ipcRenderer.invoke('elevenex-browser:set-devtools-visible', payload),
    updateIsolationConfig: (payload) => ipcRenderer.invoke('elevenex-browser:update-isolation-config', payload),
    onStateChanged: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-browser:state-changed', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-browser:state-changed', listener);
      };
    },
  },
  sshForwarding: {
    isSupported: () => ipcRenderer.invoke('elevenex-ssh-forwarding:is-supported'),
    start: (payload) => ipcRenderer.invoke('elevenex-ssh-forwarding:start', payload),
    stop: (id) => ipcRenderer.invoke('elevenex-ssh-forwarding:stop', id),
    getState: (id) => ipcRenderer.invoke('elevenex-ssh-forwarding:get-state', id),
    pickIdentityFile: () => ipcRenderer.invoke('elevenex-ssh-forwarding:pick-identity-file'),
  },
  remoteServer: {
    ensureReady: (payload) => ipcRenderer.invoke('elevenex-remote-server:ensure-ready', payload),
    recheck: (payload) => ipcRenderer.invoke('elevenex-remote-server:recheck', payload),
    sendInput: (payload) => ipcRenderer.invoke('elevenex-remote-server:send-input', payload),
    resize: (payload) => ipcRenderer.invoke('elevenex-remote-server:resize', payload),
    closeSession: (sessionId) => ipcRenderer.invoke('elevenex-remote-server:close-session', sessionId),
    onInstallerEvent: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-remote-server:installer-event', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-remote-server:installer-event', listener);
      };
    },
    onPhaseUpdate: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-remote-server:phase-update', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-remote-server:phase-update', listener);
      };
    },
  },
  wslServer: {
    isSupported: () => ipcRenderer.invoke('elevenex-wsl-server:is-supported'),
    listDistros: () => ipcRenderer.invoke('elevenex-wsl-server:list-distros'),
    ensureReady: (payload) => ipcRenderer.invoke('elevenex-wsl-server:ensure-ready', payload),
    // Installer-session lifecycle is shared with the SSH remote path (see
    // main.cjs) — sessions are keyed by sessionId and never touch SSH-specific
    // state, so the same channels work for both transports.
    recheck: (payload) => ipcRenderer.invoke('elevenex-remote-server:recheck', payload),
    sendInput: (payload) => ipcRenderer.invoke('elevenex-remote-server:send-input', payload),
    resize: (payload) => ipcRenderer.invoke('elevenex-remote-server:resize', payload),
    closeSession: (sessionId) => ipcRenderer.invoke('elevenex-remote-server:close-session', sessionId),
    onInstallerEvent: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-remote-server:installer-event', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-remote-server:installer-event', listener);
      };
    },
    onPhaseUpdate: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-remote-server:phase-update', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-remote-server:phase-update', listener);
      };
    },
  },
  cursor: {
    open: (payload) => ipcRenderer.invoke('elevenex-cursor:open', payload),
  },
  externalLinks: {
    open: (url) => ipcRenderer.invoke('elevenex-external-links:open', url),
  },
  updates: {
    getState: () => ipcRenderer.invoke('elevenex-updates:get-state'),
    check: (payload) => ipcRenderer.invoke('elevenex-updates:check', payload),
    install: () => ipcRenderer.invoke('elevenex-updates:install'),
    openReleasePage: () => ipcRenderer.invoke('elevenex-updates:open-release-page'),
    onStateChanged: (callback) => {
      if (typeof callback !== 'function') {
        return () => {};
      }

      const listener = (_event, state) => callback(state);
      ipcRenderer.on('elevenex-updates:state-changed', listener);
      return () => {
        ipcRenderer.removeListener('elevenex-updates:state-changed', listener);
      };
    },
  },
  authWindow: {
    open: (payload) => ipcRenderer.invoke('elevenex-auth-window:open', payload),
  },
});
