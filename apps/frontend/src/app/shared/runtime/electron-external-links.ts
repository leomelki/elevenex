declare global {
  interface ElevenexElectronBridge {
    externalLinks?: ElectronExternalLinksApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export interface ElectronExternalLinksApi {
  open(url: string): Promise<void>;
}

export function getElectronExternalLinksApi(): ElectronExternalLinksApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.externalLinks ?? null;
}
