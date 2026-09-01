import { OnboardingMode } from '@/shared/models/onboarding.model';

declare global {
  interface ElevenexElectronBridge {
    windows?: ElectronWindowsApi;
  }
}

export {};

/**
 * Which backend a window is bound to. The identity is `mode` + `serverId`; the
 * label is for display only (window title, Window menu, "open elsewhere" chips)
 * and is supplied by the renderer because the saved-server catalogue lives in
 * localStorage, not in the main process.
 */
export interface ElectronEnvironmentRef {
  mode: OnboardingMode;
  serverId: number | null;
  label: string;
}

export interface ElectronWindowSummary {
  windowId: string;
  envRef: ElectronEnvironmentRef;
  label: string;
  focused: boolean;
}

export interface ElectronWindowsBroadcast {
  channel: string;
  payload: unknown;
}

export interface ElectronWindowsApi {
  list(): Promise<ElectronWindowSummary[]>;
  openNew(env?: ElectronEnvironmentRef | null): Promise<string>;
  focus(windowId: string): Promise<boolean>;
  /**
   * Tell the main process this window changed environment. Load-bearing: the
   * refcounted SSH tunnel leases and the persisted layout both live there and
   * cannot follow a switch they are not told about.
   */
  setEnvironment(payload: {
    env: ElectronEnvironmentRef;
    backendOrigin?: string;
  }): Promise<boolean>;
  onChanged(callback: (windows: ElectronWindowSummary[]) => void): () => void;
  broadcast(channel: string, payload?: unknown): Promise<boolean>;
  onBroadcast(callback: (message: ElectronWindowsBroadcast) => void): () => void;
}

export function getElectronWindowsApi(): ElectronWindowsApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.windows ?? null;
}
