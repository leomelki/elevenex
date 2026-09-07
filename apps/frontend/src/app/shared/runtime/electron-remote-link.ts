declare global {
  interface ElevenexElectronBridge {
    remoteLink?: ElectronRemoteLinkApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export type RemoteLinkTransport = 'relay' | 'direct';

export type RemoteLinkStatus =
  | 'stopped'
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

/** This machine offering its backend to another device. */
export interface RemoteLinkSharingState {
  configured: boolean;
  enabled: boolean;
  transport: RemoteLinkTransport | null;
  endpoint: string | null;
  label: string;
  createdAt?: string;
  status: RemoteLinkStatus;
  connectedPeers: number;
  error: string | null;
}

/**
 * A device this machine can connect to. Deliberately has no key field — the
 * pairing key never leaves the main process.
 */
export interface RemoteLinkDeviceState {
  id: number;
  name: string;
  transport: RemoteLinkTransport;
  endpoint: string;
  createdAt: string;
  lastConnectedAt: string;
  status: RemoteLinkStatus;
  localPort: number | null;
  backendUrl: string | null;
  error: string | null;
}

export interface RemoteLinkEnableSharingPayload {
  transport: RemoteLinkTransport;
  relayUrl?: string;
  directPort?: number;
  label?: string;
}

export interface ElectronRemoteLinkApi {
  isSupported(): Promise<boolean>;
  getSharing(): Promise<RemoteLinkSharingState>;
  /** Returns the pairing code, which is the credential — request only on demand. */
  getSharingCode(): Promise<string | null>;
  enableSharing(payload: RemoteLinkEnableSharingPayload): Promise<RemoteLinkSharingState>;
  disableSharing(): Promise<RemoteLinkSharingState>;
  regenerateCode(): Promise<string | null>;
  suggestedHost(): Promise<string>;
  list(): Promise<RemoteLinkDeviceState[]>;
  add(payload: { code: string; name?: string }): Promise<RemoteLinkDeviceState>;
  rename(payload: { id: number; name: string }): Promise<RemoteLinkDeviceState | null>;
  remove(id: number): Promise<boolean>;
  connect(id: number): Promise<RemoteLinkDeviceState>;
  disconnect(id: number): Promise<boolean>;
  getState(id: number): Promise<RemoteLinkDeviceState | null>;
  onSharingChanged(callback: (state: RemoteLinkSharingState) => void): () => void;
  onStatusChanged(callback: (state: RemoteLinkDeviceState) => void): () => void;
}

export function getElectronRemoteLinkApi(): ElectronRemoteLinkApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.remoteLink ?? null;
}
