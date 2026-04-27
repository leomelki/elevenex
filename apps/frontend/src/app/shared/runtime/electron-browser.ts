declare global {
  interface ElevenexElectronBridge {
    browser?: ElectronBrowserApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewLayout {
  browserBounds: BrowserViewBounds;
  devtoolsBounds?: BrowserViewBounds;
  devtoolsVisible?: boolean;
}

export interface BrowserIsolationPayload {
  mode: 'shared' | 'isolated';
  sharedGlobs: string[];
}

export interface BrowserViewState {
  key: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  lastError: string | null;
  devtoolsOpen: boolean;
  runtimeContext: 'shared' | 'isolated';
}

export interface ElectronBrowserApi {
  isSupported(): Promise<boolean>;
  show(payload: { key: string; isolationConfig?: BrowserIsolationPayload } & BrowserViewLayout): Promise<BrowserViewState | null>;
  hide(key: string): Promise<void>;
  close(key: string): Promise<void>;
  navigate(payload: { key: string; url: string; isolationConfig?: BrowserIsolationPayload } & Partial<BrowserViewLayout>): Promise<BrowserViewState | null>;
  back(key: string): Promise<BrowserViewState | null>;
  forward(key: string): Promise<BrowserViewState | null>;
  reload(key: string): Promise<BrowserViewState | null>;
  getState(key: string): Promise<BrowserViewState | null>;
  setDevToolsVisible(payload: { key: string } & BrowserViewLayout): Promise<BrowserViewState | null>;
  updateIsolationConfig(payload: { projectId: number; mode: 'shared' | 'isolated'; sharedGlobs: string[] }): Promise<void>;
  onStateChanged(callback: (state: BrowserViewState) => void): () => void;
}

export function getElectronBrowserApi(): ElectronBrowserApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.browser ?? null;
}
