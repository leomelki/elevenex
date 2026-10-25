import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopPlatform, ElevenexBridge, Invoke, Subscribe } from '@elevenex/shared';

// Type-only workspace imports: a sandboxed preload may require Electron only.
const invoke: Invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe: Subscribe = (channel, listener) => {
  const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const bridge = Object.freeze<ElevenexBridge>({
  platform: process.platform as DesktopPlatform,
  appVersion: () => invoke('app:version'),
  gitStatus: (path: string) => invoke('git:status', path),
  onThemeChanged: (listener) => subscribe('theme:changed', listener),
  backendStatus: () => invoke('backend:status'),
  retryBackend: () => invoke('backend:retry'),
  restartBackend: () => invoke('backend:restart'),
  onBackendChanged: (listener) => subscribe('backend:changed', listener),
  remoteHosts: () => invoke('remote:hosts'),
  chooseRemoteSshFile: kind => invoke('remote:choose-file', kind),
  saveRemoteHost: (host, id) => invoke('remote:save-host', host, id),
  removeRemoteHost: id => invoke('remote:remove-host', id),
  environmentStatus: () => invoke('environment:status'),
  environmentBackendStatus: () => invoke('environment:backend-status'),
  selectEnvironment: selection => invoke('environment:select', selection),
  saveEnvironmentContext: (context, expected) => invoke('environment:context', context, expected),
  retryRemote: () => invoke('remote:retry'),
  pauseRemoteRecovery: () => invoke('remote:pause'),
  disconnectRemote: () => invoke('remote:disconnect'),
  answerRemoteChallenge: (id, answer) => invoke('remote:answer', id, answer),
  addRemoteForward: forward => invoke('remote:add-forward', forward),
  retryRemoteForward: id => invoke('remote:retry-forward', id),
  removeRemoteForward: id => invoke('remote:remove-forward', id),
  remoteDiagnostics: () => invoke('remote:diagnostics'),
  onEnvironmentChanged: listener => subscribe('environment:changed', listener),
});

contextBridge.exposeInMainWorld('elevenex', bridge);
