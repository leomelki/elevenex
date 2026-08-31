declare global {
  interface ElevenexElectronBridge {
    updates?: ElectronUpdatesApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready-to-restart'
  | 'error';

/** How the downloaded artifact gets applied on this machine. */
export type AppUpdateInstallKind = 'nsis' | 'dmg' | 'appimage' | 'deb';

export interface AppUpdateState {
  /** False in the browser build, on unpackaged runs, and on unpublished platforms. */
  supported: boolean;
  unsupportedReason: string | null;
  installKind: AppUpdateInstallKind | null;
  status: AppUpdateStatus;
  /** Commit sha the running app was built from. */
  currentVersion: string | null;
  currentVersionShort: string | null;
  latestVersion: string | null;
  latestVersionShort: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  assetName: string | null;
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
  message: string | null;
  error: string | null;
  lastCheckedAt: string | null;
}

export interface ElectronUpdatesApi {
  getState(): Promise<AppUpdateState>;
  /** `force` bypasses the main process' short-lived release cache. */
  check(payload?: { force?: boolean }): Promise<AppUpdateState>;
  install(): Promise<AppUpdateState>;
  openReleasePage(): Promise<boolean>;
  onStateChanged(callback: (state: AppUpdateState) => void): () => void;
}

export function getElectronUpdatesApi(): ElectronUpdatesApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.updates ?? null;
}
