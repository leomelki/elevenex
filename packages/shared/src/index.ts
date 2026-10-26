/** Serializable contracts only. Node and Electron APIs never enter the renderer. */
import type { EnvironmentContext, EnvironmentSelection, EnvironmentSnapshot, RemoteDiagnostic, RemoteForwardInput, RemoteHost, RemoteHostInput } from './remote';
import type { BackendClientState, BackendInfo, BackendResult } from './backend-client';
import type { MachineState, MachineEditInput, MachineRemoval, SshHostSuggestion } from './machines';
export type * from './remote';
export type * from './backend-client';
export type * from './machines';
export type Theme = 'light' | 'dark';
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

/** A snapshot is always available; URLs are usable only while phase is ready. */
export type BackendStatus =
  | { readonly phase: 'idle' | 'checking' | 'extracting' | 'starting' | 'stopping' | 'stopped'; readonly version: string | null }
  | { readonly phase: 'downloading'; readonly version: string; readonly receivedBytes: number; readonly totalBytes: number | null }
  | { readonly phase: 'ready'; readonly version: string; readonly url: string }
  | { readonly phase: 'failed'; readonly version: string | null; readonly message: string };

export interface GitStatus {
  readonly path: string;
  readonly branch: string;
  readonly staged: readonly string[];
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly mock: true;
}

export interface InvokeContracts {
  'machines:state': { args: []; result: MachineState };
  'machines:opened': { args: [selection: EnvironmentSelection]; result: MachineState };
  'machines:new-window': { args: [selection: EnvironmentSelection | null]; result: void };
  'machines:ssh-hosts': { args: [query: string]; result: readonly SshHostSuggestion[] };
  'machines:edit': { args: [selection: EnvironmentSelection, input: MachineEditInput]; result: MachineState };
  'machines:disconnect': { args: [hostId: string]; result: MachineState };
  'machines:remove': { args: [hostId: string, confirmWindows: boolean]; result: MachineRemoval };
  'machines:undo-remove': { args: [token: string]; result: MachineState };
  'machines:dismiss-removal': { args: [token: string]; result: void };
  'app:version': { args: []; result: string };
  'git:status': { args: [path: string]; result: GitStatus };
  'backend:status': { args: []; result: BackendStatus };
  'backend:retry': { args: []; result: BackendStatus };
  'backend:restart': { args: []; result: BackendStatus };
  'backend-client:state': { args: []; result: BackendClientState };
  'backend-client:info': { args: [scopeId: string]; result: BackendResult<BackendInfo> };
  'remote:hosts': { args: []; result: readonly RemoteHost[] };
  'remote:choose-file': { args: [kind: 'identity' | 'config']; result: string | null };
  'remote:save-host': { args: [host: RemoteHostInput, id: string | null]; result: RemoteHost };
  'remote:remove-host': { args: [id: string]; result: void };
  'environment:status': { args: []; result: EnvironmentSnapshot };
  'environment:backend-status': { args: []; result: BackendStatus };
  'environment:select': { args: [selection: EnvironmentSelection]; result: EnvironmentSnapshot };
  'environment:context': { args: [context: EnvironmentContext, expectedEnvironment: EnvironmentSelection]; result: EnvironmentSnapshot };
  'remote:retry': { args: []; result: EnvironmentSnapshot };
  'remote:pause': { args: []; result: EnvironmentSnapshot };
  'remote:disconnect': { args: []; result: EnvironmentSnapshot };
  'remote:answer': { args: [challengeId: string, answer: string | null]; result: void };
  'remote:add-forward': { args: [forward: RemoteForwardInput]; result: EnvironmentSnapshot };
  'remote:retry-forward': { args: [id: string]; result: EnvironmentSnapshot };
  'remote:remove-forward': { args: [id: string]; result: EnvironmentSnapshot };
  'remote:diagnostics': { args: []; result: readonly RemoteDiagnostic[] };
}

export interface EventContracts {
  'machines:changed': MachineState;
  'theme:changed': Theme;
  'backend:changed': BackendStatus;
  'backend-client:changed': BackendClientState;
  'environment:changed': EnvironmentSnapshot;
}

export type Invoke = <C extends keyof InvokeContracts>(
  channel: C,
  ...args: InvokeContracts[C]['args']
) => Promise<InvokeContracts[C]['result']>;

export type Subscribe = <C extends keyof EventContracts>(
  channel: C,
  listener: (value: EventContracts[C]) => void,
) => () => void;

/** The entire public preload API; raw IPC and Electron events stay private. */
export interface ElevenexBridge {
  readonly platform: DesktopPlatform;
  machineState(): Promise<MachineState>;
  editMachine(selection: EnvironmentSelection, input: MachineEditInput): Promise<MachineState>;
  disconnectMachine(hostId: string): Promise<MachineState>;
  removeMachine(hostId: string, confirmWindows: boolean): Promise<MachineRemoval>;
  undoRemoveMachine(token: string): Promise<MachineState>;
  dismissMachineRemoval(token: string): Promise<void>;
  markMachineOpened(selection: EnvironmentSelection): Promise<MachineState>;
  openMachineWindow(selection: EnvironmentSelection | null): Promise<void>;
  sshHostSuggestions(query: string): Promise<readonly SshHostSuggestion[]>;
  onMachineStateChanged(listener: (state: MachineState) => void): () => void;
  appVersion(): Promise<InvokeContracts['app:version']['result']>;
  gitStatus(...args: InvokeContracts['git:status']['args']): Promise<InvokeContracts['git:status']['result']>;
  onThemeChanged(listener: (theme: EventContracts['theme:changed']) => void): () => void;
  backendStatus(): Promise<BackendStatus>;
  retryBackend(): Promise<BackendStatus>;
  restartBackend(): Promise<BackendStatus>;
  onBackendChanged(listener: (status: BackendStatus) => void): () => void;
  backendClientState(): Promise<BackendClientState>;
  backendInfo(scopeId: string): Promise<BackendResult<BackendInfo>>;
  onBackendClientChanged(listener: (state: BackendClientState) => void): () => void;
  remoteHosts(): Promise<readonly RemoteHost[]>;
  chooseRemoteSshFile(kind: 'identity' | 'config'): Promise<string | null>;
  saveRemoteHost(...args: InvokeContracts['remote:save-host']['args']): Promise<RemoteHost>;
  removeRemoteHost(id: string): Promise<void>;
  environmentStatus(): Promise<EnvironmentSnapshot>;
  environmentBackendStatus(): Promise<BackendStatus>;
  selectEnvironment(selection: EnvironmentSelection): Promise<EnvironmentSnapshot>;
  saveEnvironmentContext(context: EnvironmentContext, expectedEnvironment: EnvironmentSelection): Promise<EnvironmentSnapshot>;
  retryRemote(): Promise<EnvironmentSnapshot>;
  pauseRemoteRecovery(): Promise<EnvironmentSnapshot>;
  disconnectRemote(): Promise<EnvironmentSnapshot>;
  answerRemoteChallenge(id: string, answer: string | null): Promise<void>;
  addRemoteForward(forward: RemoteForwardInput): Promise<EnvironmentSnapshot>;
  retryRemoteForward(id: string): Promise<EnvironmentSnapshot>;
  removeRemoteForward(id: string): Promise<EnvironmentSnapshot>;
  remoteDiagnostics(): Promise<readonly RemoteDiagnostic[]>;
  onEnvironmentChanged(listener: (status: EnvironmentSnapshot) => void): () => void;
}
