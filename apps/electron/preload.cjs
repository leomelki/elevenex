const { contextBridge, ipcRenderer } = require('electron');

function getArgumentValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const proxyPort = process.env.ELEVENEX_PROXY_PORT || process.env.FRONTEND_PORT || '11111';
const backendOrigin =
  getArgumentValue('elevenex-backend-origin') ||
  process.env.ELECTRON_BACKEND_URL ||
  `http://127.0.0.1:${proxyPort}`;
const mode =
  getArgumentValue('elevenex-runtime-mode') ||
  (process.env.ELECTRON_DEBUG_FRONTEND === '1' ? 'electron-debug' : 'electron-local');

contextBridge.exposeInMainWorld('__ELEVENEX_RUNTIME__', {
  backendOrigin,
  apiBaseUrl: `${backendOrigin}/api`,
  mode,
});

contextBridge.exposeInMainWorld('__ELEVENEX_ELECTRON__', {
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
  },
  cursor: {
    open: (payload) => ipcRenderer.invoke('elevenex-cursor:open', payload),
  },
  externalLinks: {
    open: (url) => ipcRenderer.invoke('elevenex-external-links:open', url),
  },
});
