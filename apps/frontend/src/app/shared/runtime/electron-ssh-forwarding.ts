declare global {
  interface ElevenexElectronBridge {
    sshForwarding?: ElectronSshForwardingApi;
  }

  interface Window {
    __ELEVENEX_ELECTRON__?: ElevenexElectronBridge;
  }
}

export {};

export interface ElectronSshForwardRuntimeState {
  id: number;
  status: 'inactive' | 'connecting' | 'active' | 'stopping' | 'error';
  installStatus?: 'unknown' | 'available' | 'missing' | 'needs-update' | 'unsupported-os' | 'missing-prereqs';
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
  debugDetails: {
    command: string;
    args: string[];
    target: string;
    bindSpec: string;
    startedAt: string | null;
    stoppedAt: string | null;
    exitCode: number | null;
    signal: string | null;
    stderr: string[];
    lastEvent: string;
  } | null;
}

export interface ElectronSshForwardStartPayload {
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
  probeType?: 'none' | 'elevenex-backend';
}

export interface ElectronSshForwardingApi {
  isSupported(): Promise<boolean>;
  start(payload: ElectronSshForwardStartPayload): Promise<ElectronSshForwardRuntimeState>;
  stop(id: number): Promise<ElectronSshForwardRuntimeState>;
  getState(id: number): Promise<ElectronSshForwardRuntimeState | null>;
  pickIdentityFile?(): Promise<string | null>;
}

export function getElectronSshForwardingApi(): ElectronSshForwardingApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__ELEVENEX_ELECTRON__?.sshForwarding ?? null;
}
