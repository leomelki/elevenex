declare global {
  interface ElevenexElectronBridge {
    authWindow?: ElectronAuthWindowApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export interface ElectronAuthWindowOpenPayload {
  url: string;
  key?: string;
  title?: string;
}

export interface ElectronAuthWindowApi {
  open(payload: ElectronAuthWindowOpenPayload | string): Promise<boolean>;
}

export function getElectronAuthWindowApi(): ElectronAuthWindowApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.authWindow ?? null;
}
