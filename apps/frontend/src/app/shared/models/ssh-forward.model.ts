export type SshForwardStatus = 'inactive' | 'connecting' | 'active' | 'stopping' | 'error';

export interface SshForward {
  id: number;
  projectId: number;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string | null;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  createdAt: string;
  updatedAt: string;
  status: SshForwardStatus;
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
  destinationLabel: string;
  connectionLabel: string;
}
