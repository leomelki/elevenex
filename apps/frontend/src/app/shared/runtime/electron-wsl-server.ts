import {
  RemoteInstallGuidance,
  RemoteInstallPhase,
  RemoteInstallStatus,
} from './electron-remote-server';

declare global {
  interface ElevenexElectronBridge {
    wslServer?: ElectronWslServerApi;
  }
}

export {};

// Sentinel "server id" used on phase-update events for the singleton WSL
// connection — mirrors WSL_SERVER_ID in apps/electron/main.cjs. There is no
// per-connection id the way SSH servers have one, since WSL is not a list of
// named configs.
export const WSL_SERVER_ID = -1;

export interface WslDistro {
  name: string;
  state: string;
  wslVersion: number;
  isDefault: boolean;
}

export interface ElectronWslServerEnsureReadyResult {
  status: 'ready' | 'waiting-for-user' | 'unsupported' | 'error';
  installPhase: RemoteInstallPhase;
  installStatus: RemoteInstallStatus;
  remotePlatform: string;
  remoteArch: string;
  missingDependencies: ('claude' | 'tmux')[];
  message: string;
  localPort: number | null;
  sessionId: number | null;
  osRelease: Record<string, string>;
  installGuidance: RemoteInstallGuidance[];
  version: string | null;
  // The distro actually used — meaningful even when the request omitted
  // distroName and the main process picked WSL's own default.
  distroName: string | null;
}

export interface ElectronWslServerEnsureReadyPayload {
  distroName?: string | null;
  sessionId?: number | null;
}

export interface ElectronWslServerInstallerEvent {
  sessionId: number;
  type: 'data' | 'exit' | 'error' | 'closed';
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
}

export interface ElectronWslServerPhaseEvent {
  serverId: number;
  phase: RemoteInstallPhase;
}

export interface ElectronWslServerApi {
  isSupported(): Promise<boolean>;
  listDistros(): Promise<WslDistro[]>;
  ensureReady(payload: ElectronWslServerEnsureReadyPayload): Promise<ElectronWslServerEnsureReadyResult>;
  recheck(payload: ElectronWslServerEnsureReadyPayload): Promise<ElectronWslServerEnsureReadyResult>;
  sendInput(payload: { sessionId: number; data: string }): Promise<boolean>;
  resize(payload: { sessionId: number; cols: number; rows: number }): Promise<boolean>;
  closeSession(sessionId: number): Promise<boolean>;
  onInstallerEvent(callback: (event: ElectronWslServerInstallerEvent) => void): () => void;
  onPhaseUpdate(callback: (event: ElectronWslServerPhaseEvent) => void): () => void;
}

export function getElectronWslServerApi(): ElectronWslServerApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.wslServer ?? null;
}
