import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopPlatform, ElevenexBridge, Invoke, Subscribe } from '@elevenex/shared';

// Type-only workspace imports: a sandboxed preload may require Electron only.
const invoke: Invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe: Subscribe = (channel, listener) => {
  const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
  ipcRenderer.on(channel, handler);
  // EventEmitter returns ipcRenderer itself. Never return that privileged object
  // through contextBridge; unsubscribe is a void operation.
  return () => { ipcRenderer.removeListener(channel, handler); };
};

const bridge = Object.freeze<ElevenexBridge>({
  platform: process.platform as DesktopPlatform,
  appVersion: () => invoke('app:version'),
  gitStatus: (path: string) => invoke('git:status', path),
  onThemeChanged: (listener) => subscribe('theme:changed', listener),
});

contextBridge.exposeInMainWorld('elevenex', bridge);
