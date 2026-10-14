import type { SshForwardStatus, PortForwardCreator } from './ssh-forward.model';

/** Wire contract validated by backend mcp/port-forwarding/port-forwarding.protocol.ts. */
export interface DesktopForwardingContext {
  desktopId: string;
  windowId: string;
  mode: 'local' | 'ssh' | 'paired' | 'wsl';
  connectionLabel: string;
  defaultConnection: 'ssh' | 'paired' | null;
}
export interface PortForwardHandle {
  createdBySession?: PortForwardCreator;
  id: number;
  projectId: number;
  name: string;
  transport: 'ssh' | 'paired';
  connectionLabel: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: SshForwardStatus;
  running: boolean;
  localUrl: string;
  lastError: string | null;
}
export interface PortForwardRequest {
  type: 'request';
  id: string;
  operation: 'list' | 'get' | 'create' | 'start' | 'stop' | 'remove';
  args: {
    /** Authenticated caller, supplied by the backend; not a tool input. */
    requestedBy?: PortForwardCreator;
    projectId: number;
    forwardId?: number;
    limit?: number;
    offset?: number;
    remotePort?: number;
    localPort?: number;
    remoteHost?: string;
    name?: string;
    sshHost?: string;
    sshUser?: string;
    sshPort?: number;
    startImmediately?: boolean;
  };
}
export interface PortForwardResponse {
  forwards: PortForwardHandle[];
  total: number;
  nextOffset: number | null;
  reused?: boolean;
  removed?: boolean;
}
