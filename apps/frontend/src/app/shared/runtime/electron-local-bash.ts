declare global {
  interface ElevenexElectronBridge {
    localBash?: ElectronLocalBashApi;
  }
}

export {};

export interface LocalBashState {
  enabled: boolean;
  supported: boolean;
  shell: string;
  platform: string;
  label: string;
}

export interface LocalBashRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  cwd: string;
}

export interface ElectronLocalBashApi {
  getState(): Promise<LocalBashState>;
  setEnabled(enabled: boolean): Promise<LocalBashState>;
  run(payload: { id: string; command: string; cwd?: string; timeoutMs: number }): Promise<LocalBashRunResult>;
  cancel(id: string): Promise<boolean>;
  onStateChanged(callback: (state: LocalBashState) => void): () => void;
}

export function getElectronLocalBashApi(): ElectronLocalBashApi | null {
  if (typeof window === 'undefined') return null;
  return window.__ELEVENEX_ELECTRON__?.localBash ?? null;
}
