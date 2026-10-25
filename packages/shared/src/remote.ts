/** Credentials are transient challenge replies, never part of a saved host. */
export interface RemoteHostInput {
  readonly name: string;
  /** OpenSSH Host alias or hostname; user and port can inherit ssh_config. */
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly configFile?: string;
  /** Explicit consent; permits configured forwarding, including custom sockets. */
  readonly forwardAgent: boolean;
}
export interface RemoteHost extends RemoteHostInput { readonly id: string }
export type EnvironmentSelection = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly hostId: string };
export interface EnvironmentContext {
  readonly projectId: number | null;
  readonly taskId: number | null;
  readonly sessionId: number | null;
  readonly draft: string;
  /** Last consumed domain-event cursor, for reconciliation by the consumer. */
  readonly cursor: string | null;
}
export type RemoteStage = 'authentication' | 'discovery' | 'download' | 'installation' | 'runtime' | 'transport' | 'application';
export interface RemoteFailure {
  readonly stage: RemoteStage;
  readonly code: 'authentication' | 'host-trust' | 'configuration' | 'compatibility' | 'timeout' | 'unavailable';
  readonly message: string;
  readonly action: 'retry' | 'authenticate' | 'verify-host' | 'edit' | 'install-prerequisites';
  readonly transient: boolean;
}
export interface RemoteChallenge {
  readonly id: string;
  readonly kind: 'credential' | 'trust';
  readonly prompt: string;
  readonly expiresAt: number;
}
export interface RemoteConnectionStatus {
  readonly hostId: string;
  readonly phase: 'disconnected' | 'connecting' | 'awaiting-input' | 'setting-up' | 'ready' | 'recovering' | 'paused';
  readonly stage: RemoteStage;
  readonly authenticated: boolean;
  readonly transport: 'closed' | 'opening' | 'healthy' | 'unresponsive';
  readonly application: 'unknown' | 'starting' | 'ready' | 'unavailable';
  readonly attempt: number;
  readonly retryAt: number | null;
  readonly failure: RemoteFailure | null;
  readonly progress: { readonly receivedBytes: number; readonly totalBytes: number | null } | null;
  /** Changes after every successful reconnection. Reject work from older generations. */
  readonly generation: number;
  /** Changes when the remote daemon restarts; remote work may then need reconciliation. */
  readonly instanceId: string | null;
}
export interface RemoteForwardInput { readonly remotePort: number; readonly localPort: number; readonly label: string }
export interface RemoteForward extends RemoteForwardInput {
  readonly id: string;
  readonly phase: 'waiting' | 'listening' | 'unavailable' | 'conflict' | 'stopped';
  readonly boundPort: number | null;
  readonly message: string | null;
}
export interface EnvironmentSnapshot {
  readonly selection: EnvironmentSelection;
  readonly context: EnvironmentContext;
  readonly connection: RemoteConnectionStatus | null;
  /** Only the requesting window receives its challenge. */
  readonly challenge: RemoteChallenge | null;
  readonly forwards: readonly RemoteForward[];
}
export interface RemoteDiagnostic {
  readonly at: number;
  readonly stage: RemoteStage;
  readonly code: string;
  readonly message: string;
}
