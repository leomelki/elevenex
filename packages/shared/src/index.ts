import type { WorkspaceCommitPreview, WorkspaceCommitQuery } from './workspace-commit';
import type { WorkspaceArchiveSession, WorkspaceRestoreSession, WorkspaceClosePreview, WorkspaceGitSummary, WorkspaceGitAction, WorkspaceAddRepository, WorkspaceBranch, WorkspaceBranchQuery, WorkspaceCreateProject, WorkspaceCreateSession, WorkspaceCreateTask, WorkspaceFinishTask, WorkspaceFolder, WorkspaceFolderQuery, WorkspacePage, WorkspacePageQuery, WorkspaceProject, WorkspaceProjectDetail, WorkspaceRenameTask, WorkspaceSession, WorkspaceSessionQuery, WorkspaceSetStage, WorkspaceTask, WorkspaceTaskRecovery, WorkspaceTaskQuery, WorkspaceUpdateProject } from './workspace';
export type * from './workspace';
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
  'workspace:close-preview': { args: [scopeId: string, taskId: number]; result: BackendResult<WorkspaceClosePreview> };
  'workspace:commit-preview': { args: [scopeId: string, query: WorkspaceCommitQuery]; result: BackendResult<WorkspaceCommitPreview> };
  'workspace:git': { args: [scopeId: string, taskId: number]; result: BackendResult<WorkspaceGitSummary> };
  'workspace:git-action': { args: [scopeId: string, input: WorkspaceGitAction]; result: BackendResult<WorkspaceGitSummary> };
  'workspace:restore-project': { args: [scopeId: string, projectId: number]; result: BackendResult<{ readonly accepted: true }> };
  'workspace:delete-project': { args: [scopeId: string, projectId: number]; result: BackendResult<{ readonly accepted: true }> };
  'workspace:revision': { args: [scopeId: string]; result: BackendResult<{ readonly revision: number; readonly version: 1; readonly sessionArchive?: true; readonly sessionArchiveHistory?: true; readonly commitPanel?: true }> };
  'workspace:projects': { args: [scopeId: string, input: WorkspacePageQuery]; result: BackendResult<WorkspacePage<WorkspaceProject>> };
  'workspace:project-name-availability': { args: [scopeId: string, name: string]; result: BackendResult<{ readonly available: boolean }> };
  'workspace:project': { args: [scopeId: string, input: number]; result: BackendResult<WorkspaceProjectDetail> };
  'workspace:tasks': { args: [scopeId: string, input: WorkspaceTaskQuery]; result: BackendResult<WorkspacePage<WorkspaceTask>> };
  'workspace:task': { args: [scopeId: string, input: number]; result: BackendResult<WorkspaceTask> };
  'workspace:sessions': { args: [scopeId: string, input: WorkspaceSessionQuery]; result: BackendResult<WorkspacePage<WorkspaceSession>> };
  'workspace:create-project': { args: [scopeId: string, input: WorkspaceCreateProject]; result: BackendResult<WorkspaceProjectDetail> };
  'workspace:create-task': { args: [scopeId: string, input: WorkspaceCreateTask]; result: BackendResult<WorkspaceTask> };
  'workspace:archive-session': { args: [scopeId: string, input: WorkspaceArchiveSession]; result: BackendResult<{ readonly accepted: true }> };
  'workspace:restore-session': { args: [scopeId: string, input: WorkspaceRestoreSession]; result: BackendResult<WorkspaceSession> };
  'workspace:create-session': { args: [scopeId: string, input: WorkspaceCreateSession]; result: BackendResult<WorkspaceSession> };
  'workspace:rename-task': { args: [scopeId: string, input: WorkspaceRenameTask]; result: BackendResult<WorkspaceTask> };
  'workspace:finish-task': { args: [scopeId: string, input: WorkspaceFinishTask]; result: BackendResult<WorkspaceTask> };
  'workspace:retry-task': { args: [scopeId: string, taskId: number, recovery?: WorkspaceTaskRecovery]; result: BackendResult<WorkspaceTask> };
  'workspace:reopen-task': { args: [scopeId: string, input: number]; result: BackendResult<WorkspaceTask> };
  'workspace:update-project': { args: [scopeId: string, input: WorkspaceUpdateProject]; result: BackendResult<WorkspaceProjectDetail> };
  'workspace:archive-project': { args: [scopeId: string, input: number]; result: BackendResult<{ readonly accepted: true }> };
  'workspace:set-stage': { args: [scopeId: string, input: WorkspaceSetStage]; result: BackendResult<WorkspaceTask> };
  'workspace:branches': { args: [scopeId: string, input: WorkspaceBranchQuery]; result: BackendResult<readonly WorkspaceBranch[]> };
  'workspace:add-repository': { args: [scopeId: string, input: WorkspaceAddRepository]; result: BackendResult<WorkspaceProjectDetail> };
  'workspace:folders': { args: [scopeId: string, input: WorkspaceFolderQuery]; result: BackendResult<readonly WorkspaceFolder[]> };
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
  workspaceClosePreview(scopeId: string, taskId: number): Promise<BackendResult<WorkspaceClosePreview>>;
  workspaceCommitPreview(scopeId: string, query: WorkspaceCommitQuery): Promise<BackendResult<WorkspaceCommitPreview>>;
  workspaceGit(scopeId: string, taskId: number): Promise<BackendResult<WorkspaceGitSummary>>;
  workspaceGitAction(scopeId: string, input: WorkspaceGitAction): Promise<BackendResult<WorkspaceGitSummary>>;
  workspaceRestoreProject(scopeId: string, projectId: number): Promise<BackendResult<{ readonly accepted: true }>>;
  workspaceDeleteProject(scopeId: string, projectId: number): Promise<BackendResult<{ readonly accepted: true }>>;
  workspaceRevision(scopeId: string): Promise<BackendResult<{ readonly revision: number; readonly version: 1; readonly sessionArchive?: true; readonly sessionArchiveHistory?: true; readonly commitPanel?: true }>>;
  workspaceProjects(scopeId: string, input: WorkspacePageQuery): Promise<BackendResult<WorkspacePage<WorkspaceProject>>>;
  workspaceProjectNameAvailability(scopeId: string, name: string): Promise<BackendResult<{ readonly available: boolean }>>;
  workspaceProject(scopeId: string, input: number): Promise<BackendResult<WorkspaceProjectDetail>>;
  workspaceTasks(scopeId: string, input: WorkspaceTaskQuery): Promise<BackendResult<WorkspacePage<WorkspaceTask>>>;
  workspaceTask(scopeId: string, input: number): Promise<BackendResult<WorkspaceTask>>;
  workspaceSessions(scopeId: string, input: WorkspaceSessionQuery): Promise<BackendResult<WorkspacePage<WorkspaceSession>>>;
  workspaceCreateProject(scopeId: string, input: WorkspaceCreateProject): Promise<BackendResult<WorkspaceProjectDetail>>;
  workspaceCreateTask(scopeId: string, input: WorkspaceCreateTask): Promise<BackendResult<WorkspaceTask>>;
  workspaceArchiveSession(scopeId: string, input: WorkspaceArchiveSession): Promise<BackendResult<{ readonly accepted: true }>>;
  workspaceRestoreSession(scopeId: string, input: WorkspaceRestoreSession): Promise<BackendResult<WorkspaceSession>>;
  workspaceCreateSession(scopeId: string, input: WorkspaceCreateSession): Promise<BackendResult<WorkspaceSession>>;
  workspaceRenameTask(scopeId: string, input: WorkspaceRenameTask): Promise<BackendResult<WorkspaceTask>>;
  workspaceFinishTask(scopeId: string, input: WorkspaceFinishTask): Promise<BackendResult<WorkspaceTask>>;
  workspaceRetryTask(scopeId: string, taskId: number, recovery?: WorkspaceTaskRecovery): Promise<BackendResult<WorkspaceTask>>;
  workspaceReopenTask(scopeId: string, input: number): Promise<BackendResult<WorkspaceTask>>;
  workspaceUpdateProject(scopeId: string, input: WorkspaceUpdateProject): Promise<BackendResult<WorkspaceProjectDetail>>;
  workspaceArchiveProject(scopeId: string, input: number): Promise<BackendResult<{ readonly accepted: true }>>;
  workspaceSetStage(scopeId: string, input: WorkspaceSetStage): Promise<BackendResult<WorkspaceTask>>;
  workspaceBranches(scopeId: string, input: WorkspaceBranchQuery): Promise<BackendResult<readonly WorkspaceBranch[]>>;
  workspaceAddRepository(scopeId: string, input: WorkspaceAddRepository): Promise<BackendResult<WorkspaceProjectDetail>>;
  workspaceFolders(scopeId: string, input: WorkspaceFolderQuery): Promise<BackendResult<readonly WorkspaceFolder[]>>;
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
