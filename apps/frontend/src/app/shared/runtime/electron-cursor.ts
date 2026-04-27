declare global {
  interface ElevenexElectronBridge {
    cursor?: ElectronCursorApi;
  }
}

export {};

export interface CursorOpenPayload {
  worktreePath: string;
  mode: 'local' | 'remote';
  sshUser?: string;
  sshHost?: string;
}

export interface CursorOpenResult {
  ok: boolean;
  error?: string;
}

export interface ElectronCursorApi {
  open(payload: CursorOpenPayload): Promise<CursorOpenResult>;
}

export function getElectronCursorApi(): ElectronCursorApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.cursor ?? null;
}
