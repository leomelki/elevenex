export type OnboardingMode = 'local' | 'ssh' | 'wsl';

export type ServerAuthMode = 'agent' | 'password' | 'key';

export type OnboardingStep = 'choice' | 'ssh' | 'install' | 'project';

export type ServerInstallStatus =
  | 'unknown'
  | 'available'
  | 'missing'
  | 'needs-update'
  | 'unsupported-os'
  | 'missing-prereqs';

export interface SavedServer {
  id: number;
  name: string;
  sshHost: string;
  sshUser: string | null;
  sshPort: number;
  authMode: ServerAuthMode;
  identityFilePath: string | null;
  localPort: number;
  remotePort: number;
  installStatus: ServerInstallStatus;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string;
}

export interface OnboardingLastSshDefaults {
  name: string;
  sshHost: string;
  sshUser: string | null;
  sshPort: number;
  authMode: ServerAuthMode;
  identityFilePath: string | null;
}

// Unlike SavedServer, this is a singleton, not a named config the user creates
// and manages a list of — there is exactly one WSL backend connection, the way
// there is exactly one Local connection. It just remembers the last distro/port
// so a later reconnect can skip straight to a readiness probe.
export interface WslConnectionState {
  distroName: string | null;
  localPort: number;
  installStatus: ServerInstallStatus;
  lastConnectedAt: string;
}

export interface OnboardingStateSnapshot {
  mode: OnboardingMode | null;
  currentStep: OnboardingStep;
  activeServerId: number | null;
  remoteConnectionReady: boolean;
  projectHandoffAcknowledged: boolean;
  servers: SavedServer[];
  lastSshDefaults: OnboardingLastSshDefaults | null;
  wsl: WslConnectionState | null;
}
