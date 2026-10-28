import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopPlatform, ElevenexBridge, Invoke, Subscribe } from '@elevenex/shared';

// Type-only workspace imports: a sandboxed preload may require Electron only.
const invoke: Invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const subscribe: Subscribe = (channel, listener) => {
  const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
  ipcRenderer.on(channel, handler);
  // EventEmitter returns ipcRenderer itself. Never return that privileged object
  // through contextBridge; unsubscribe is a void operation.
  return () => { ipcRenderer.removeListener(channel, handler); };
};

const bridge = Object.freeze<ElevenexBridge>({
  platform: process.platform as DesktopPlatform,
  machineState: () => invoke('machines:state'),
  editMachine: (selection, input) => invoke('machines:edit', selection, input),
  disconnectMachine: hostId => invoke('machines:disconnect', hostId),
  removeMachine: (hostId, confirmWindows) => invoke('machines:remove', hostId, confirmWindows),
  undoRemoveMachine: token => invoke('machines:undo-remove', token),
  dismissMachineRemoval: token => invoke('machines:dismiss-removal', token),
  markMachineOpened: selection => invoke('machines:opened', selection),
  openMachineWindow: selection => invoke('machines:new-window', selection),
  sshHostSuggestions: query => invoke('machines:ssh-hosts', query),
  onMachineStateChanged: listener => subscribe('machines:changed', listener),
  appVersion: () => invoke('app:version'),
  gitStatus: (path: string) => invoke('git:status', path),
  onThemeChanged: (listener) => subscribe('theme:changed', listener),
  backendStatus: () => invoke('backend:status'),
  retryBackend: () => invoke('backend:retry'),
  restartBackend: () => invoke('backend:restart'),
  onBackendChanged: (listener) => subscribe('backend:changed', listener),
  backendClientState: () => invoke('backend-client:state'),
  backendInfo: (scopeId) => invoke('backend-client:info', scopeId),
  workspaceClosePreview: (scopeId, taskId) => invoke('workspace:close-preview', scopeId, taskId),
  workspaceCommitPreview: (scopeId, query) => invoke('workspace:commit-preview', scopeId, query),
  workspaceGit: (scopeId, taskId) => invoke('workspace:git', scopeId, taskId),
  workspaceGitAction: (scopeId, input) => invoke('workspace:git-action', scopeId, input),
  workspaceRestoreProject: (scopeId, projectId) => invoke('workspace:restore-project', scopeId, projectId),
  workspaceDeleteProject: (scopeId, projectId) => invoke('workspace:delete-project', scopeId, projectId),
  workspaceRevision: scopeId => invoke('workspace:revision', scopeId),
  workspaceProjects: (scopeId, input) => invoke('workspace:projects', scopeId, input),
  workspaceProjectNameAvailability: (scopeId, name) => invoke('workspace:project-name-availability', scopeId, name),
  workspaceProject: (scopeId, input) => invoke('workspace:project', scopeId, input),
  workspaceTasks: (scopeId, input) => invoke('workspace:tasks', scopeId, input),
  workspaceTask: (scopeId, input) => invoke('workspace:task', scopeId, input),
  workspaceSessions: (scopeId, input) => invoke('workspace:sessions', scopeId, input),
  workspaceCreateProject: (scopeId, input) => invoke('workspace:create-project', scopeId, input),
  workspaceCreateTask: (scopeId, input) => invoke('workspace:create-task', scopeId, input),
  workspaceArchiveSession: (scopeId, input) => invoke('workspace:archive-session', scopeId, input),
  workspaceRestoreSession: (scopeId, input) => invoke('workspace:restore-session', scopeId, input),
  workspaceCreateSession: (scopeId, input) => invoke('workspace:create-session', scopeId, input),
  workspaceRenameTask: (scopeId, input) => invoke('workspace:rename-task', scopeId, input),
  workspaceFinishTask: (scopeId, input) => invoke('workspace:finish-task', scopeId, input),
  workspaceRetryTask: (scopeId, taskId, recovery) => recovery === undefined ? invoke('workspace:retry-task', scopeId, taskId) : invoke('workspace:retry-task', scopeId, taskId, recovery),
  workspaceReopenTask: (scopeId, input) => invoke('workspace:reopen-task', scopeId, input),
  workspaceUpdateProject: (scopeId, input) => invoke('workspace:update-project', scopeId, input),
  workspaceArchiveProject: (scopeId, input) => invoke('workspace:archive-project', scopeId, input),
  workspaceSetStage: (scopeId, input) => invoke('workspace:set-stage', scopeId, input),
  workspaceBranches: (scopeId, input) => invoke('workspace:branches', scopeId, input),
  workspaceAddRepository: (scopeId, input) => invoke('workspace:add-repository', scopeId, input),
  workspaceFolders: (scopeId, input) => invoke('workspace:folders', scopeId, input),
  onBackendClientChanged: (listener) => subscribe('backend-client:changed', listener),
  remoteHosts: () => invoke('remote:hosts'),
  chooseRemoteSshFile: kind => invoke('remote:choose-file', kind),
  saveRemoteHost: (host, id) => invoke('remote:save-host', host, id),
  removeRemoteHost: id => invoke('remote:remove-host', id),
  environmentStatus: () => invoke('environment:status'),
  environmentBackendStatus: () => invoke('environment:backend-status'),
  selectEnvironment: selection => invoke('environment:select', selection),
  saveEnvironmentContext: (context, expected) => invoke('environment:context', context, expected),
  retryRemote: () => invoke('remote:retry'),
  pauseRemoteRecovery: () => invoke('remote:pause'),
  disconnectRemote: () => invoke('remote:disconnect'),
  answerRemoteChallenge: (id, answer) => invoke('remote:answer', id, answer),
  addRemoteForward: forward => invoke('remote:add-forward', forward),
  retryRemoteForward: id => invoke('remote:retry-forward', id),
  removeRemoteForward: id => invoke('remote:remove-forward', id),
  remoteDiagnostics: () => invoke('remote:diagnostics'),
  onEnvironmentChanged: listener => subscribe('environment:changed', listener),
});

contextBridge.exposeInMainWorld('elevenex', bridge);
