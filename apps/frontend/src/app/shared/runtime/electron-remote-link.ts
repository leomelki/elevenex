import type { ElectronSshForwardRuntimeState } from './electron-ssh-forwarding';

declare global {
  interface ElevenexElectronBridge {
    remoteLink?: ElectronRemoteLinkApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export type RemoteLinkTransport = 'relay' | 'direct' | 'p2p' | 'ssh';

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
  /**
   * How traffic is flowing right now, as opposed to how the two ends found each
   * other. A relayed link upgrades itself to `direct` when hole punching
   * succeeds, and silently returns to `relay` if that path drops.
   */
  path: 'relay' | 'direct';
  error: string | null;
}

/**
 * Sharing through an SSH server both machines can log in to. The relay port is
 * a loopback port on that server; left out, one is picked and kept.
 */
export interface RemoteLinkSshSharingOptions {
  host: string;
  port?: number;
  user?: string;
  relayPort?: number;
  identityFile?: string;
}

/** This machine's own login for an SSH-relayed device, when it differs from the sharer's. */
export interface RemoteLinkSshLoginOverride {
  user?: string;
  identityFile?: string;
}

export interface RemoteLinkEnableSharingPayload {
  transport: RemoteLinkTransport;
  relayUrl?: string;
  directPort?: number;
  label?: string;
  ssh?: RemoteLinkSshSharingOptions;
}

export interface ElectronRemoteLinkApi {
  startForward?(payload: { deviceId: number; id: number; bindAddress: string; localPort: number; remoteHost: string; remotePort: number }): Promise<ElectronSshForwardRuntimeState>;
  stopForward?(deviceId: number, id: number): Promise<ElectronSshForwardRuntimeState | null>;
  getForwardState?(deviceId: number, id: number): Promise<ElectronSshForwardRuntimeState | null>;
  isSupported(): Promise<boolean>;
  getSharing(): Promise<RemoteLinkSharingState>;
  /** Returns the pairing code, which is the credential — request only on demand. */
  getSharingCode(): Promise<string | null>;
  enableSharing(payload: RemoteLinkEnableSharingPayload): Promise<RemoteLinkSharingState>;
  disableSharing(): Promise<RemoteLinkSharingState>;
  regenerateCode(): Promise<string | null>;
  suggestedHost(): Promise<string>;
  list(): Promise<RemoteLinkDeviceState[]>;
  add(payload: { code: string; name?: string; ssh?: RemoteLinkSshLoginOverride }): Promise<RemoteLinkDeviceState>;
  rename(payload: { id: number; name: string }): Promise<RemoteLinkDeviceState | null>;
  remove(id: number): Promise<boolean>;
  connect(id: number): Promise<RemoteLinkDeviceState>;
  disconnect(id: number): Promise<boolean>;
  getState(id: number): Promise<RemoteLinkDeviceState | null>;
  onSharingChanged(callback: (state: RemoteLinkSharingState) => void): () => void;
  onStatusChanged(callback: (state: RemoteLinkDeviceState) => void): () => void;
}

/**
 * Reads only the transport out of a pasted code, so the form can ask for an SSH
 * login before the code is saved. The code itself is decoded in the main process.
 */
export function pairingCodeTransport(code: string): RemoteLinkTransport | null {
  const text = code.trim();
  if (!text.startsWith('EX1-')) {
    return null;
  }
  try {
    const base64 = text.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { t?: unknown };
    return payload.t === 'relay' || payload.t === 'direct' || payload.t === 'p2p' || payload.t === 'ssh' ? payload.t : null;
  } catch {
    return null;
  }
}

export function getElectronRemoteLinkApi(): ElectronRemoteLinkApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.remoteLink ?? null;
}
