declare global {
  interface ElevenexElectronBridge {
    windowControls?: ElectronWindowControlsApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export type DesktopPlatform = 'darwin' | 'linux' | 'win32' | 'unknown';

export interface ElectronWindowEnvironment {
  isElectron: boolean;
  platform: DesktopPlatform;
  usesNativeMacControls: boolean;
}

export interface ElectronWindowState {
  isMaximized: boolean;
  isFullScreen: boolean;
  isFocused: boolean;
}

export interface ElectronWindowControlsApi {
  getEnvironment(): Promise<ElectronWindowEnvironment>;
  minimize(): Promise<void>;
  maximize(): Promise<ElectronWindowState>;
  unmaximize(): Promise<ElectronWindowState>;
  toggleMaximize(): Promise<ElectronWindowState>;
  close(): Promise<void>;
  isMaximized(): Promise<ElectronWindowState>;
  onStateChanged(callback: (state: ElectronWindowState) => void): () => void;
}

export function getElectronWindowControlsApi(): ElectronWindowControlsApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.windowControls ?? null;
}
