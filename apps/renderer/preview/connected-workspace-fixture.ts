import { DestroyRef, Injectable, inject } from '@angular/core';
import type { BackendResult, WorkspaceArchiveSession, WorkspaceRestoreSession, WorkspaceAddRepository, WorkspaceCreateProject, WorkspaceCreateSession, WorkspaceCreateTask, WorkspaceFinishTask, WorkspaceCommitQuery, WorkspaceGitAction, WorkspaceGitSummary, WorkspacePage, WorkspaceProject, WorkspaceProjectDetail, WorkspaceSession, WorkspaceSessionQuery, WorkspaceSetStage, WorkspaceTask, WorkspaceTaskQuery, WorkspaceTaskRecovery, WorkspaceUpdateProject } from '@elevenex/shared';
import { MachineStartupFixture } from './machine-startup-fixture';
import { SessionChatFixture } from './session-chat-fixture';

const stamp = '2026-10-26T12:30:00.000Z';
const success = <T>(value: T): BackendResult<T> => ({ ok: true, value });
const page = <T>(items: readonly T[]): WorkspacePage<T> => ({ items, nextCursor: null });

/** Isolated platform data for exercising the production workspace; never shipped. */
@Injectable()
export class ConnectedWorkspaceFixture extends MachineStartupFixture {
  readonly chat = new SessionChatFixture(inject(DestroyRef));
  sessionChatCatalog = (_scope: string, input: import('@elevenex/shared').SessionChatCatalogRead) => this.chat.catalog(input);
  sessionChatRead = (_scope: string, input: import('@elevenex/shared').SessionChatRead) => this.chat.read(input);
  sessionChatCommand = (_scope: string, input: import('@elevenex/shared').SessionChatCommand) => this.chat.command(input);
  sessionChatContent = (_scope: string, input: import('@elevenex/shared').SessionChatContentRead) => this.chat.content(input);
  sessionChatCancel = async (_scope: string, requestId: string) => this.chat.cancel(requestId);
  private projectRows: WorkspaceProject[] = [
    { id: 1, name: 'Payments', agentInstructions: '', appearance: { hue: 'pine', look: 'icon', icon: 'repo' } },
    { id: 2, name: 'Storefront', agentInstructions: '', appearance: { hue: 'ocean', look: 'letters' } },
  ];
  private taskRows: WorkspaceTask[] = [
    { id: 11, projectId: 1, repoId: 1, name: 'Make retries safe', branchName: 'fix/idempotent-retries', stage: 'active', state: 'ready', archivedAt: null, updatedAt: stamp },
    { id: 12, projectId: 1, repoId: 1, name: 'Review settlement window', branchName: 'review/settlement-window', stage: 'waiting', state: 'ready', archivedAt: null, updatedAt: stamp },
    { id: 13, projectId: 2, repoId: 2, name: 'Improve checkout accessibility', branchName: 'feat/checkout-focus', stage: 'planned', state: 'ready', archivedAt: null, updatedAt: stamp },
  ];
  private sessionRows: WorkspaceSession[] = [
    { id: 101, taskId: 11, repoId: 1, name: 'Guard concurrent requests', provider: 'codex', status: 'running', updatedAt: stamp },
    { id: 102, taskId: 11, repoId: 1, name: 'Review the race condition', provider: 'codex', status: 'idle', updatedAt: stamp },
    { id: 103, taskId: 12, repoId: 1, name: 'Confirm the cutoff', provider: 'codex', status: 'waiting', updatedAt: stamp },
    { id: 104, taskId: 13, repoId: 2, name: 'Keyboard path through checkout', provider: 'codex', status: 'idle', updatedAt: stamp },
  ];
  private failReads = false;
  private taskSetupFailure: boolean | 'worktree-limit' = false;
  private sidebarRepositoryCount = 1;
  /** Bounded sidebar edge cases, isolated from the production import graph. */
  sidebarState(mode: 'single' | 'multiple' | 'empty' | 'many'): void {
    this.sidebarRepositoryCount = mode === 'multiple' ? 2 : 1;
    const count = mode === 'empty' ? 0 : mode === 'many' ? 20 : 2;
    this.taskRows = Array.from({ length: count }, (_, index) => ({
      id: 11 + index, projectId: 1, repoId: mode === 'multiple' && index === 1 ? 3 : 1,
      name: index ? `Review settlement window ${index}` : 'Make retries safe when a payment provider returns a delayed response',
      branchName: `task/sidebar-${index}`, stage: 'active', state: 'ready', archivedAt: null, updatedAt: stamp,
    }));
    this.sessionRows = this.taskRows.flatMap((task, index) => [
      { id: 101 + index * 2, taskId: task.id, repoId: task.repoId, name: index ? 'Confirm the cutoff' : 'Guard concurrent requests across the entire payment processing pipeline', provider: 'codex', status: index === 1 ? 'failed' : index === 0 ? 'waiting' : 'running', updatedAt: stamp },
      { id: 102 + index * 2, taskId: task.id, repoId: task.repoId, name: 'Review the race condition', provider: 'codex', status: 'idle', updatedAt: stamp },
    ]);
  }
  private navigationTask(task: WorkspaceTask): WorkspaceTask {
    return { ...task, repoName: task.repoId === 3 ? 'payments-settlement-service' : task.projectId === 1 ? 'payments-api' : 'storefront', projectRepositoryCount: task.projectId === 1 ? this.sidebarRepositoryCount : 1 };
  }
  readonly taskRecoveries: { readonly taskId: number; readonly recovery?: WorkspaceTaskRecovery }[] = [];
  setTaskSetupFailure(enabled: boolean | 'worktree-limit'): void { this.taskSetupFailure = enabled; }
  private createFailure: 'rejected' | 'uncertain' | null = null;
  private foldersState: 'ready' | 'empty' | 'error' = 'ready';
  private folderDelay = 0;
  private readonly pendingFolderReads = new Set<() => void>();
  private taskDelay = 0;
  private readonly pendingTaskReads = new Set<() => void>();
  setTaskDelay(milliseconds: number): void { this.taskDelay = Math.max(0, Math.min(2000, milliseconds)); }
  setFolderDelay(milliseconds: number): void { this.folderDelay = Math.max(0, Math.min(2000, milliseconds)); }
  setProjectFailure(value: 'rejected' | 'uncertain' | null): void { this.createFailure = value; }
  setFolderState(value: 'ready' | 'empty' | 'error'): void { this.foldersState = value; }
  private readonly git = new Map<number, WorkspaceGitSummary>();
  private archived: WorkspaceProject | null = null;

  constructor() {
    super(); this.ready();
    inject(DestroyRef).onDestroy(() => { for (const finish of this.pendingFolderReads) finish(); });
    inject(DestroyRef).onDestroy(() => { for (const finish of this.pendingTaskReads) finish(); });
  }
  empty(): void { this.projectRows = []; this.taskRows = []; this.sessionRows = []; this.failReads = false; this.ready(); }
  failure(): void { this.failReads = true; this.ready(); }
  recoverWorkspace(): void { this.failReads = false; this.ready(); }
  override workspaceRevision = async () => success({ revision: 0, version: 1 as const, commitPanel: true as const, sessionArchive: true as const, sessionArchiveHistory: true as const });
  override workspaceProjects = async () => this.failReads
    ? { ok: false as const, error: { code: 'transport' as const, message: 'The workspace could not be loaded.' } }
    : success(page(this.projectRows));
  workspaceProject = async (_scope: string, id: number) => success(this.detail(id));
  override workspaceProjectNameAvailability = async (_scope: string, name: string) => success({ available: !this.projectRows.some(project => project.name === name) && name !== 'Archived project' });
  override workspaceTasks = async (_scope: string, query: WorkspaceTaskQuery) => {
    if (this.taskDelay) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.pendingTaskReads.delete(finish); resolve(); };
      const timer = setTimeout(finish, this.taskDelay);
      this.pendingTaskReads.add(finish);
    });
    return success(page(this.taskRows.filter(task => (query.projectId === null || task.projectId === query.projectId) && (query.state === 'finished' ? task.state === 'finished' : task.state !== 'finished')).map(task => this.navigationTask(task))));
  };
  override workspaceSessions = async (_scope: string, query: WorkspaceSessionQuery) => {
    const rows = this.sessionRows.filter(session => session.taskId === query.taskId && (query.state === 'archived' ? session.status === 'archived' : session.status !== 'archived') && (!query.cursor || session.id < Number(query.cursor))).sort((a,b) => b.id - a.id);
    const limit = query.limit ?? 20;
    return success({ items: rows.slice(0,limit).reverse(), nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null });
  };
  workspaceTask = async (_scope: string, id: number) => success(this.navigationTask(this.taskRows.find(task => task.id === id)!));
  workspaceRetryTask = async (scope: string, id: number, recovery?: WorkspaceTaskRecovery) => {
    this.taskRecoveries.push({ taskId: id, recovery });
    if (this.taskRecoveries.length > 20) this.taskRecoveries.shift();
    if (recovery) {
      this.taskRows = this.taskRows.map(task => task.id === id ? { ...task, state: 'ready', setupIssue: undefined } : task);
      if (!this.sessionRows.some(session => session.taskId === id)) await this.workspaceCreateSession(scope, { taskId: id });
    }
    return this.workspaceTask(scope, id);
  };
  workspaceBranches = async () => success([{ name: 'main', current: true, isDefault: true, defaultBase: 'main', heldTaskName: null }, { name: 'release/stable', current: false, isDefault: false, defaultBase: 'main', heldTaskName: null }]);
  override workspaceFolders = async (_scope?: string, input?: import('@elevenex/shared').WorkspaceFolderQuery) => {
    if (this.folderDelay) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.pendingFolderReads.delete(finish); resolve(); };
      const timer = setTimeout(finish, this.folderDelay);
      this.pendingFolderReads.add(finish);
    });
    if (this.foldersState === 'error') return { ok: false as const, error: { code: 'http' as const, status: 400, message: 'The folder could not be opened.' } };
    if (this.foldersState === 'empty') return success([]);
    if (input?.query.startsWith('https://')) return success([{ path: '/preview/code/analytics', name: 'analytics', git: null, dir: false, clone: input.query }]);
    const entries = [
      { path: '/preview/payments-api', name: 'payments-api', git: 'main', dir: true },
      { path: '/preview/storefront', name: 'storefront', git: 'main', dir: true },
      { path: '/preview/design', name: 'design', git: null, dir: true },
      { path: '/preview/design/assets', name: 'assets', git: null, dir: true },
    ];
    const query = (input?.query ?? '~/').replace(/^~\/code/, '/preview').replace(/^~\//, '/preview/');
    const exact = !query.endsWith('/') && entries.find(entry => entry.path === query);
    if (exact) return success([exact]);
    const separator = query.lastIndexOf('/'), parent = query.slice(0, separator + 1), prefix = query.slice(separator + 1);
    return success(entries.filter(entry => entry.path.slice(0, entry.path.lastIndexOf('/') + 1) === parent && entry.name.startsWith(prefix)));
  };
  workspaceCreateProject = async (_scope: string, input: WorkspaceCreateProject) => {
    if (this.createFailure) return { ok: false as const, error: { code: this.createFailure === 'uncertain' ? 'outcome-unknown' as const : 'http' as const, status: 400, message: 'Project could not be created. Check the repository folders and Git access.' } };
    const project = { id: Math.max(0, ...this.projectRows.map(project => project.id)) + 1, name: input.name, appearance: input.appearance, agentInstructions: '' };
    this.projectRows = [...this.projectRows, project]; return success(this.detail(project.id));
  };
  workspaceCreateTask = async (_scope: string, input: WorkspaceCreateTask) => {
    let task: WorkspaceTask = { id: Math.max(0, ...this.taskRows.map(task => task.id)) + 1, projectId: input.repoId, repoId: input.repoId, name: input.name, branchName: input.branchName ?? 'task/new-task', stage: 'active', state: 'ready', archivedAt: null, updatedAt: stamp };
    if (this.taskSetupFailure === 'worktree-limit') {
      task = { ...task, state: 'failed', setupIssue: { code: 'other', message: 'This repository has 23 workspaces, meeting or exceeding the configured limit of 5. Your task has been saved. Free a workspace and retry, or create one above the limit for this task.', canUseSnapshot: false, canExceedWorktreeLimit: true } };
    } else if (this.taskSetupFailure && input.mode === 'existing') {
      task = { ...task, state: 'failed', setupIssue: { code: 'external-checkout', message: 'This branch is already checked out in another workspace. Your task has been saved.', workspacePath: '/preview/existing-workspace', canUseSnapshot: true } };
    }
    this.taskRows = [task, ...this.taskRows];
    if (task.state === 'ready') await this.workspaceCreateSession(_scope, { taskId: task.id });
    return success(task);
  };
  workspaceArchiveSession = async (_scope: string, input: WorkspaceArchiveSession) => {
    this.sessionRows = this.sessionRows.map(session => session.taskId === input.taskId && session.id === input.sessionId ? { ...session, status: 'archived' } : session);
    return success({ accepted: true as const });
  };
  workspaceRestoreSession = async (_scope: string, input: WorkspaceRestoreSession) => {
    const session = this.sessionRows.find(session => session.taskId === input.taskId && session.id === input.sessionId);
    if (!session) throw new Error('Unknown session');
    const restored = { ...session, status: 'stopped' };
    this.sessionRows = this.sessionRows.map(session => session.id === input.sessionId ? restored : session);
    return success(restored);
  };
  busyTask(): void {
    this.sessionRows = Array.from({ length: 19 }, (_, index) => ({ id: 200 + index, taskId: 11, repoId: 1, name: `Investigate retry behavior ${index + 1}`, status: index === 0 ? 'attention' : index === 3 ? 'failed' : index === 18 ? 'review' : 'running', provider: 'codex', updatedAt: stamp }));
  }
  archivedHistory(): void {
    this.sessionRows = this.sessionRows.filter(session => session.id < 300).concat(Array.from({ length: 45 }, (_, index) => ({
      id: 300 + index, taskId: 11, repoId: 1, name: `Archived investigation ${index + 1}`, status: 'archived', provider: 'codex', updatedAt: stamp,
    })));
  }
  workspaceCreateSession = async (_scope: string, input: WorkspaceCreateSession) => {
    const task = this.taskRows.find(task => task.id === input.taskId)!;
    const session: WorkspaceSession = { id: Math.max(0, ...this.sessionRows.map(session => session.id)) + 1, taskId: task.id, repoId: task.repoId, name: input.name ?? 'Explore the task', provider: 'codex', status: 'idle', updatedAt: stamp };
    this.sessionRows = [...this.sessionRows, session]; return success(session);
  };
  workspaceSetStage = async (_scope: string, input: WorkspaceSetStage) => {
    this.taskRows = this.taskRows.map(task => task.id === input.taskId ? { ...task, stage: input.stage } : task); return success(this.taskRows.find(task => task.id === input.taskId)!);
  };
  workspaceFinishTask = async (_scope: string, input: WorkspaceFinishTask) => {
    this.taskRows = this.taskRows.map(task => task.id === input.taskId ? { ...task, state: 'finished' as const, archivedAt: stamp } : task); return success(this.taskRows.find(task => task.id === input.taskId)!);
  };
  workspaceReopenTask = async (_scope: string, id: number) => {
    this.taskRows = this.taskRows.map(task => task.id === id ? { ...task, state: 'ready' as const, archivedAt: null } : task); return success(this.taskRows.find(task => task.id === id)!);
  };
  workspaceUpdateProject = async (_scope: string, input: WorkspaceUpdateProject) => {
    this.projectRows = this.projectRows.map(project => project.id === input.projectId ? { ...project, ...(input.name ? { name: input.name } : {}), ...(input.appearance ? { appearance: input.appearance } : {}), ...(input.agentInstructions !== undefined ? { agentInstructions: input.agentInstructions } : {}) } : project); return success(this.detail(input.projectId));
  };
  workspaceArchiveProject = async (_scope: string, id: number) => { this.archived = this.projectRows.find(project => project.id === id) ?? null; this.projectRows = this.projectRows.filter(project => project.id !== id); return success({ accepted: true as const }); };
  workspaceRestoreProject = async () => { if (this.archived) this.projectRows = [...this.projectRows, this.archived]; this.archived = null; return success({ accepted: true as const }); };
  workspaceDeleteProject = async (_scope: string, id: number) => { this.projectRows = this.projectRows.filter(project => project.id !== id); return success({ accepted: true as const }); };
  workspaceAddRepository = async (_scope: string, input: WorkspaceAddRepository) => success(this.detail(input.projectId));
  workspaceGit = async (_scope: string, taskId: number) => success(this.git.get(taskId) ?? { taskId, branch: this.taskRows.find(task => task.id === taskId)?.branchName ?? '', upstream: 'origin/main', ahead: 0, behind: 0, files: 48, additions: 3288, deletions: 1128, conflicted: false });
  workspaceClosePreview = async (_scope: string, taskId: number) => success({ taskId, sessions: this.sessionRows.filter(session => session.taskId === taskId).length, running: this.sessionRows.filter(session => session.taskId === taskId && session.status === 'running').length, terminals: 0, actions: 0, unpushed: this.git.get(taskId)?.ahead ?? 0, uncommitted: this.git.get(taskId)?.files ?? 3 });
  workspaceCommitPreview = async (_scope: string, query: WorkspaceCommitQuery) => {
    const files = Array.from({length: 48}, (_, index) => ({path: index === 0 ? '.env.local' : index < 4 ? 'src/payments/retry-' + index + '.ts' : 'src/payments/test-' + index + '.spec.ts', status: index === 0 ? 'A' : 'M', add: 92 - index, del: index, staged: index > 0 && index < 15, ...(index === 0 ? {flag: 'secrets' as const} : {}) }));
    const selected = files.filter(file => (query.includeUnstaged || file.staged) && !query.excluded.includes(file.path) && (!file.flag || query.includedSecrets.includes(file.path)));
    const matches = files.filter(file => file.path.includes(query.query ?? '')).sort((a,b) => Number(query.includeUnstaged || b.staged) - Number(query.includeUnstaged || a.staged));
    return success({ taskId: query.taskId, revision: 'a'.repeat(64), items: matches, nextCursor: null, total: files.length, matches: matches.length, unstaged: 34, selected: { files: selected.length, add: selected.reduce((n,file) => n + file.add,0), del: selected.reduce((n,file) => n + file.del,0), staged: selected.filter(file=>file.staged).length, unstaged: selected.filter(file=>!file.staged).length }, running: ['Guard concurrent requests'] });
  };
  workspaceGitAction = async (scope: string, input: WorkspaceGitAction) => {
    const previous = (await this.workspaceGit(scope, input.taskId));
    if (!previous.ok) return previous;
    const summary = { ...previous.value, ...(input.type === 'commit' ? { files: input.selection?.includedSecrets.includes('.env.local') ? 0 : 1, additions: 31, deletions: 0, ahead: input.push ? 0 : 1 } : {}), ...(input.type === 'push' ? { ahead: 0 } : {}), ...(input.type === 'sync' ? { behind: 0 } : {}), ...(input.type === 'rename-branch' ? { branch: input.branchName } : {}) };
    this.git.set(input.taskId, summary); return success(summary);
  };
  private detail(id: number): WorkspaceProjectDetail { return { project: this.projectRows.find(project => project.id === id)!, repositories: page([{ id, projectId: id, name: id === 1 ? 'payments-api' : 'storefront', path: `/preview/project-${id}`, defaultBase: 'main' }]) }; }
}
