export type OnboardingMode = 'local' | 'ssh';

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

export interface OnboardingStateSnapshot {
  mode: OnboardingMode | null;
  currentStep: OnboardingStep;
  activeServerId: number | null;
  remoteConnectionReady: boolean;
  projectHandoffAcknowledged: boolean;
  servers: SavedServer[];
  lastSshDefaults: OnboardingLastSshDefaults | null;
}
