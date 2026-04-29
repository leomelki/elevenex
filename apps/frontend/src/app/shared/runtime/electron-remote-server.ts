declare global {
  interface ElevenexElectronBridge {
    remoteServer?: ElectronRemoteServerApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export type RemoteInstallStatus =
  | 'unknown'
  | 'available'
  | 'missing'
  | 'needs-update'
  | 'unsupported-os'
  | 'missing-prereqs';

export type RemoteInstallPhase =
  | 'checking'
  | 'missing-prereqs'
  | 'uploading'
  | 'installing'
  | 'starting'
  | 'probing'
  | 'ready';

export interface ElectronRemoteServerEnsureReadyResult {
  status: 'ready' | 'waiting-for-user' | 'unsupported' | 'error';
  installPhase: RemoteInstallPhase;
  installStatus: RemoteInstallStatus;
  remotePlatform: string;
  remoteArch: string;
  missingDependencies: Array<'claude' | 'tmux'>;
  message: string;
  localPort: number | null;
  sessionId: number | null;
  osRelease: Record<string, string>;
  suggestedCommands: string[];
  version: string | null;
}

export interface ElectronRemoteServerEnsureReadyPayload {
  id: number;
  sshHost: string;
  sshUser?: string | null;
  sshPort: number;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  authMode?: 'agent' | 'password' | 'key';
  password?: string | null;
  identityFilePath?: string | null;
  passphrase?: string | null;
  sessionId?: number | null;
}

export interface ElectronRemoteServerInstallerEvent {
  sessionId: number;
  type: 'data' | 'exit' | 'error' | 'closed';
  data?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
}

export interface ElectronRemoteServerPhaseEvent {
  serverId: number;
  phase: RemoteInstallPhase;
}

export interface ElectronRemoteServerApi {
  ensureReady(payload: ElectronRemoteServerEnsureReadyPayload): Promise<ElectronRemoteServerEnsureReadyResult>;
  recheck(payload: ElectronRemoteServerEnsureReadyPayload): Promise<ElectronRemoteServerEnsureReadyResult>;
  sendInput(payload: { sessionId: number; data: string }): Promise<boolean>;
  resize(payload: { sessionId: number; cols: number; rows: number }): Promise<boolean>;
  closeSession(sessionId: number): Promise<boolean>;
  onInstallerEvent(callback: (event: ElectronRemoteServerInstallerEvent) => void): () => void;
  onPhaseUpdate(callback: (event: ElectronRemoteServerPhaseEvent) => void): () => void;
}

export function getElectronRemoteServerApi(): ElectronRemoteServerApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.remoteServer ?? null;
}
