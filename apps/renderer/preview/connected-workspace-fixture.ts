import { DestroyRef, Injectable, inject } from '@angular/core';
import type { BackendResult, WorkspaceArchiveSession, WorkspaceDeleteSession, WorkspaceRestoreSession, WorkspaceAddRepository, WorkspaceBranch, WorkspaceBranchQuery, WorkspaceCreateProject, WorkspaceCreateSession, WorkspaceCreateTask, WorkspaceFinishTask, WorkspaceCommitQuery, WorkspaceGitAction, WorkspaceGitSummary, WorkspacePage, WorkspaceProject, WorkspaceProjectDetail, WorkspaceSession, WorkspaceSessionQuery, WorkspaceSetStage, WorkspaceTask, WorkspaceTaskQuery, WorkspaceTaskRecovery, WorkspaceUpdateProject } from '@elevenex/shared';
import { MachineStartupFixture } from './machine-startup-fixture';
import { SessionChatFixture } from './session-chat-fixture';

const stamp = '2026-10-26T12:30:00.000Z';
const success = <T>(value: T): BackendResult<T> => ({ ok: true, value });
const page = <T>(items: readonly T[]): WorkspacePage<T> => ({ items, nextCursor: null });

/** Isolated platform data for exercising the production workspace; never shipped. */
@Injectable()
export class ConnectedWorkspaceFixture extends MachineStartupFixture {
  readonly chat = new SessionChatFixture(inject(DestroyRef));
  readonly sentChatActions: import('@elevenex/shared').SessionChatCommand[] = [];
  readonly sentTaskCreates: WorkspaceCreateTask[] = [];
  readonly sentSessionCreates: WorkspaceCreateSession[] = [];
  readonly sentGitActions: WorkspaceGitAction[] = [];
  sessionChatCatalog = (_scope: string, input: import('@elevenex/shared').SessionChatCatalogRead) => this.chat.catalog(input);
  sessionChatChanges = (_scope: string, input: import('@elevenex/shared').SessionChatChangesRead) => this.chat.changes(input);
  sessionChatAgent = (_scope: string, input: import('@elevenex/shared').SessionChatAgentRead) => this.chat.agent(input);
  sessionChatRead = (_scope: string, input: import('@elevenex/shared').SessionChatRead) => this.chat.read(input);
  sessionChatCommand = async (_scope: string, input: import('@elevenex/shared').SessionChatCommand) => {
    this.sentChatActions.push(input);
    const result = await this.chat.command(input);
    if (result.ok && input.action.type === 'send') {
      this.sessionRows = this.sessionRows.map(row => row.id === input.sessionId ? { ...row, canDelete: false, status: 'running' } : row);
      this.navigationRevision++;
    }
    if (result.ok && input.action.type === 'mark-seen' && !this.chat.unseenCompletionAt(input.sessionId)) {
      this.sessionRows = this.sessionRows.map(row => row.id === input.sessionId ? { ...row, status: 'done' } : row);
      this.navigationRevision++;
    }
    return result;
  };
  sessionChatUpload = (_scope: string, input: import("@elevenex/shared").ChatAttachmentUpload) => this.chat.upload(input);
  sessionChatMedia = (_scope: string, input: import('@elevenex/shared').SessionChatMediaRead) => this.chat.media(input);
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
  private readonly nestingRanks = new Map<number, number>();
  private nestingSequence = 0;
  private sessionRows: WorkspaceSession[] = [
    { id: 101, taskId: 11, repoId: 1, name: 'Guard concurrent requests', provider: 'codex', status: 'running', updatedAt: stamp },
    { id: 102, taskId: 11, repoId: 1, name: 'Review the race condition', provider: 'codex', status: 'idle', updatedAt: stamp },
    { id: 103, taskId: 12, repoId: 1, name: 'Confirm the cutoff', provider: 'codex', status: 'waiting', updatedAt: stamp },
    { id: 104, taskId: 13, repoId: 2, name: 'Keyboard path through checkout', provider: 'codex', status: 'idle', updatedAt: stamp },
  ];
  private failReads = false;
  private revisionWaitEnabled = false;
  private readonly revisionWaits = new Map<string, () => void>();
  private revisionValue = 0;
  private get navigationRevision(): number { return this.revisionValue; }
  private set navigationRevision(value: number) {
    this.revisionValue = value;
    for (const finish of [...this.revisionWaits.values()]) finish();
  }
  /** Opt-in event-driven fixture for native status regression captures. */
  liveSessionStatus(sessionId: number, status: WorkspaceSession['status']): void {
    this.revisionWaitEnabled = true;
    this.sessionRows = this.sessionRows.map(row => row.id === sessionId ? { ...row, status } : row);
    this.navigationRevision++;
  }
  override workspaceWait = async (_scope: string, input: import('@elevenex/shared').WorkspaceRevisionWait) => {
    if (input.after === this.navigationRevision) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.revisionWaits.delete(input.requestId); resolve(); };
      const timer = setTimeout(finish, 25000);
      this.revisionWaits.set(input.requestId, finish);
    });
    return this.workspaceRevision();
  };
  override workspaceCancelWait = async (_scope: string, requestId: string): Promise<void> => { this.revisionWaits.get(requestId)?.(); };
  private childReadsHeld = false;
  private childReadsFailed = false;
  private readonly pendingChildReads = new Set<() => void>();
  setChildReads(mode: 'ready' | 'held' | 'failed'): void {
    this.childReadsHeld = mode === 'held'; this.childReadsFailed = mode === 'failed';
    if (!this.childReadsHeld) { for (const finish of this.pendingChildReads) finish(); this.pendingChildReads.clear(); }
  }
  /** Stable roots/children for zero-reflow drag feedback and ordering checks. */
  nestingScene(): void {
    this.sessionRows = this.sessionRows.filter(row => row.taskId !== 11).concat([
      {id:101,taskId:11,repoId:1,name:'Plan session nesting',provider:'codex',status:'done',updatedAt:stamp},
      {id:102,taskId:11,repoId:1,name:'Update docs',provider:'codex',status:'done',updatedAt:stamp},
      {id:105,taskId:11,repoId:1,name:'Backend migration',provider:'codex',status:'done',updatedAt:stamp},
      {id:106,taskId:11,repoId:1,name:'Fix tooltip overlap',provider:'codex',status:'done',updatedAt:stamp},
      {id:107,taskId:11,repoId:1,parentSessionId:101,name:'Keyboard support',provider:'codex',status:'done',updatedAt:stamp},
      {id:108,taskId:11,repoId:1,parentSessionId:101,name:'Screen reader feedback',provider:'codex',status:'done',updatedAt:stamp},
    ]);
    this.nestingRanks.clear(); this.nestingSequence = 0;
    this.navigationRevision++;
  }
  manyChildren(): void {
    this.sessionRows = this.sessionRows.filter(row => row.id < 400).concat(Array.from({length:45},(_,index)=>({id:400+index,taskId:11,repoId:1,parentSessionId:101,name:`Child investigation ${index + 1}`,provider:'codex',status:'done',updatedAt:stamp})));
    this.navigationRevision++;
  }
  /** Older engine activity replies alongside real queued/live/unseen states. */
  legacySessionActivity(): void {
    this.taskRows = this.taskRows.filter(task => task.id === 11);
    this.sessionRows = [
      { id: 101, taskId: 11, repoId: 1, name: 'Previously completed conversation', provider: 'codex', status: 'idle', updatedAt: stamp },
      { id: 102, taskId: 11, repoId: 1, name: 'Restored conversation', provider: 'codex', status: 'active', updatedAt: stamp },
      { id: 103, taskId: 11, repoId: 1, name: 'Finished while you were away', provider: 'codex', status: 'review', updatedAt: stamp },
      { id: 104, taskId: 11, repoId: 1, name: 'New conversation', provider: 'codex', status: 'created', canDelete: true, updatedAt: stamp },
      { id: 105, taskId: 11, repoId: 1, name: 'Agent currently working', provider: 'codex', status: 'running', updatedAt: stamp },
    ];
    this.chat.scenario('reply-only', 101);
    this.chat.completeUnseen(103, '2026-11-15T00:00:00.000Z');
    this.navigationRevision++;
  }
  completeUnseen(sessionId: number, at: string): void {
    this.chat.completeUnseen(sessionId, at);
    this.sessionRows = this.sessionRows.map(row => row.id === sessionId ? { ...row, status: 'review' } : row);
    this.navigationRevision++;
  }
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
  private commitPreviewHeld = false;
  private readonly pendingCommitPreviews = new Set<() => void>();
  setCommitPreviewHeld(held: boolean): void {
    this.commitPreviewHeld = held;
    if (!held) for (const finish of this.pendingCommitPreviews) finish();
  }
  setTaskDelay(milliseconds: number): void { this.taskDelay = Math.max(0, Math.min(2000, milliseconds)); }
  setFolderDelay(milliseconds: number): void { this.folderDelay = Math.max(0, Math.min(2000, milliseconds)); }
  setProjectFailure(value: 'rejected' | 'uncertain' | null): void { this.createFailure = value; }
  setFolderState(value: 'ready' | 'empty' | 'error'): void { this.foldersState = value; }
  private readonly git = new Map<number, WorkspaceGitSummary>();
  private archived: WorkspaceProject | null = null;

  constructor() {
    super(); this.ready();
    inject(DestroyRef).onDestroy(() => { for (const finish of [...this.revisionWaits.values()]) finish(); });
    inject(DestroyRef).onDestroy(() => { for (const finish of this.pendingFolderReads) finish(); });
    inject(DestroyRef).onDestroy(() => { for (const finish of this.pendingTaskReads) finish(); for (const finish of this.pendingSessionCreates.values()) finish('unknown'); this.pendingSessionCreates.clear(); });
    inject(DestroyRef).onDestroy(() => { this.setCommitPreviewHeld(false); this.setGitActionHeld(false); this.setChildReads('ready'); });
  }
  empty(): void { this.projectRows = []; this.taskRows = []; this.sessionRows = []; this.failReads = false; this.ready(); }
  failure(): void { this.failReads = true; this.ready(); }
  recoverWorkspace(): void { this.failReads = false; this.ready(); }
  override workspaceRevision = async () => success({ revision: this.navigationRevision, version: 1 as const, ...(this.revisionWaitEnabled ? { revisionWait: true as const } : {}), taskRequests: true as const, commitPanel: true as const, sessionArchive: true as const, sessionArchiveHistory: true as const, sessionNesting: true as const, sessionNestingOrder: true as const });
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
    if (typeof query.parentSessionId === 'number') {
      if (this.childReadsHeld) await new Promise<void>(resolve => this.pendingChildReads.add(resolve));
      if (this.childReadsFailed) return { ok: false as const, error: { code: 'transport' as const, message: 'Could not load child sessions. Try again.' } };
    }
    const nested = query.childOrder === 'nested';
    const [rank, cursorId] = query.cursor?.split(':').map(Number) ?? [];
    const rows = this.sessionRows.filter(session => session.taskId === query.taskId && (query.parentSessionId === undefined || (session.parentSessionId ?? null) === query.parentSessionId) && (query.state === 'archived' ? session.status === 'archived' : session.status !== 'archived') && (!query.cursor || (nested ? (this.nestingRanks.get(session.id) ?? 0) < rank! || ((this.nestingRanks.get(session.id) ?? 0) === rank && session.id < cursorId!) : session.id < Number(query.cursor)))).sort((a,b) => (nested ? (this.nestingRanks.get(b.id) ?? 0) - (this.nestingRanks.get(a.id) ?? 0) : 0) || b.id - a.id);
    const limit = query.limit ?? 20;
    const last = rows[limit - 1];
    return success({ items: rows.slice(0,limit).reverse().map(session => ({ ...session, childCount: this.sessionRows.filter(child => child.parentSessionId === session.id && child.status !== 'archived').length })), nextCursor: rows.length > limit ? nested ? `${this.nestingRanks.get(last!.id) ?? 0}:${last!.id}` : String(last!.id) : null });
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
  private branchSearchFails = false;
  setBranchSearchFailure(enabled: boolean): void { this.branchSearchFails = enabled; }
  workspaceBranches = async (_scope: string, input: WorkspaceBranchQuery): Promise<BackendResult<readonly WorkspaceBranch[]>> => {
    if (this.branchSearchFails) return { ok: false, error: { code: 'http', status: 503, message: 'Could not load branches.' } };
    const defaultBase = input.repoId === 1 ? 'refs/remotes/origin/main' : 'refs/heads/main';
    const refs = input.repoId === 1 ? [
      defaultBase, 'refs/heads/main', 'refs/remotes/origin/release/candidate',
      'refs/heads/fix/idempotent-retries', 'refs/heads/release/stable',
      'refs/remotes/origin/fix/idempotent-retries', 'refs/remotes/upstream/review/payments',
      'refs/remotes/upstream/review/settlement',
      'refs/heads/release/maintenance', 'refs/heads/release/canary', 'refs/heads/release/next',
    ] : [defaultBase, 'refs/heads/release/stable'];
    const query = input.query?.trim().toLowerCase() ?? '';
    const words = query.split(/[\s/_-]+/).filter(Boolean);
    return success(refs.flatMap(ref => {
      const name = ref.replace(/^refs\/(heads|remotes)\//, '');
      if (query.startsWith('refs/') ? !ref.startsWith(query) : !words.every(word => name.includes(word))) return [];
      const remoteBranch = ref.startsWith('refs/remotes/') ? name.slice(name.indexOf('/') + 1) : undefined;
      const held = this.taskRows.find(task => task.repoId === input.repoId && !task.archivedAt && task.branchName === (remoteBranch ?? name));
      return [{ name, ref, remoteBranch, current: ref === 'refs/heads/main', isDefault: ref === defaultBase, defaultBase, heldTaskName: held?.name ?? null }];
    }).slice(0, input.limit ?? 50));
  };
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
  workspaceTaskRequest = async (_scope: string, input: { readonly requestId: string; readonly repoId: number }) => { const request = this.sentTaskCreates.findIndex(item => item.requestId === input.requestId && item.repoId === input.repoId); return success({ task: request < 0 ? null : this.taskRows.find(task => task.name === this.sentTaskCreates[request]?.name) ?? null }); };
  workspaceCreateTask = async (_scope: string, input: WorkspaceCreateTask) => {
    this.sentTaskCreates.push(input);
    const branchName = input.branchName?.replace(/^refs\/(heads\/|remotes\/[^/]+\/)/, '') ?? 'task/new-task';
    let task: WorkspaceTask = { id: Math.max(0, ...this.taskRows.map(task => task.id)) + 1, projectId: input.repoId, repoId: input.repoId, name: input.name, branchName, stage: 'active', state: 'ready', archivedAt: null, updatedAt: stamp };
    if (this.taskSetupFailure === 'worktree-limit') {
      task = { ...task, state: 'failed', setupIssue: { code: 'other', message: 'This repository has 23 workspaces, meeting or exceeding the configured limit of 5. Your task has been saved. Free a workspace and retry, or create one above the limit for this task.', canUseSnapshot: false, canExceedWorktreeLimit: true } };
    } else if (this.taskSetupFailure && input.mode === 'existing') {
      task = { ...task, state: 'failed', setupIssue: { code: 'external-checkout', message: 'This branch is already checked out in another workspace. Your task has been saved.', workspacePath: '/preview/existing-workspace', canUseSnapshot: true } };
    }
    this.taskRows = [task, ...this.taskRows];
    if (task.state === 'ready') await this.workspaceCreateSession(_scope, { taskId: task.id });
    return success(task);
  };
  workspaceDeleteSession = async (_scope: string, input: WorkspaceDeleteSession) => {
    const session = this.sessionRows.find(row => row.taskId === input.taskId && row.id === input.sessionId);
    if (!session?.canDelete) return { ok: false as const, error: { code: 'http' as const, message: 'This session has started. Archive it instead.' } };
    this.sessionRows = this.sessionRows.filter(row => row.id !== session.id).map(row => row.parentSessionId === session.id ? { ...row, parentSessionId: null } : row);
    this.navigationRevision++;
    return success({ accepted: true as const });
  };
  workspaceArchiveSession = async (_scope: string, input: WorkspaceArchiveSession) => {
    this.sessionRows = this.sessionRows.map(session => session.taskId === input.taskId && session.id === input.sessionId ? { ...session, status: 'archived' } : session.parentSessionId === input.sessionId ? { ...session, parentSessionId: null } : session);
    return success({ accepted: true as const });
  };
  workspaceMoveSession = async (_scope: string, input: import('@elevenex/shared').WorkspaceMoveSession) => {
    const source = this.sessionRows.find(row => row.id === input.sessionId && row.taskId === input.taskId);
    if (!source) throw new Error('Unknown session');
    if (source.parentSessionId !== input.parentSessionId) this.nestingRanks.set(source.id, ++this.nestingSequence);
    const moved = { ...source, parentSessionId: input.parentSessionId };
    this.sessionRows = this.sessionRows.map(row => row.id === source.id ? moved : row);
    this.navigationRevision++;
    return success(moved);
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
  private sessionCreationHeld = false;
  private readonly pendingSessionCreates = new Map<number, (outcome: 'success' | 'failed' | 'unknown') => void>();
  holdSessionCreation(held: boolean): void { this.sessionCreationHeld = held; }
  finishSessionCreation(taskId: number, outcome: 'success' | 'failed' | 'unknown' = 'success'): void {
    this.pendingSessionCreates.get(taskId)?.(outcome); this.pendingSessionCreates.delete(taskId);
  }
  workspaceCreateSession = async (_scope: string, input: WorkspaceCreateSession): Promise<BackendResult<WorkspaceSession>> => {
    this.sentSessionCreates.push(input);
    if (this.sessionCreationHeld) {
      const outcome = await new Promise<'success' | 'failed' | 'unknown'>(resolve => this.pendingSessionCreates.set(input.taskId, resolve));
      if (outcome !== 'success') return { ok: false, error: outcome === 'failed' ? { code: 'http', status: 409, message: 'The task is still preparing. Try again shortly.' } : { code: 'outcome-unknown', message: 'Lost creation reply.' } };
    }
    const task = this.taskRows.find(task => task.id === input.taskId)!;
    const session: WorkspaceSession = { id: Math.max(0, ...this.sessionRows.map(session => session.id)) + 1, taskId: task.id, repoId: task.repoId, name: input.name ?? 'Explore the task', provider: 'codex', status: 'created', canDelete: true, updatedAt: stamp };
    this.sessionRows = [...this.sessionRows, session]; this.chat.scenario('new', session.id); return success(session);
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
  workspaceGit = async (_scope: string, taskId: number) => success(this.git.get(taskId) ?? { taskId, branch: this.taskRows.find(task => task.id === taskId)?.branchName ?? '', upstream: 'origin/main', ahead: 0, behind: 0, files: 48, additions: 3288, deletions: 1128, conflicted: false, changesRevision: 'c'.repeat(64) });
  workspaceClosePreview = async (_scope: string, taskId: number) => success({ taskId, sessions: this.sessionRows.filter(session => session.taskId === taskId).length, running: this.sessionRows.filter(session => session.taskId === taskId && session.status === 'running').length, terminals: 0, actions: 0, unpushed: this.git.get(taskId)?.ahead ?? 0, uncommitted: this.git.get(taskId)?.files ?? 3 });
  workspaceCommitPreview = async (_scope: string, query: WorkspaceCommitQuery) => {
    if (this.commitPreviewHeld) await new Promise<void>(resolve => {
      const finish = () => { this.pendingCommitPreviews.delete(finish); resolve(); };
      this.pendingCommitPreviews.add(finish);
    });
    const files = Array.from({length: 48}, (_, index) => ({path: index === 0 ? '.env.local' : index < 4 ? 'src/payments/retry-' + index + '.ts' : 'src/payments/test-' + index + '.spec.ts', status: index === 0 ? 'A' : 'M', add: 92 - index, del: index, staged: index > 0 && index < 15, ...(index === 0 ? {flag: 'secrets' as const} : {}) }));
    const selected = files.filter(file => (query.includeUnstaged || file.staged) && !query.excluded.includes(file.path) && (!file.flag || query.includedSecrets.includes(file.path)));
    const matches = files.filter(file => file.path.includes(query.query ?? '')).sort((a,b) => Number(query.includeUnstaged || b.staged) - Number(query.includeUnstaged || a.staged));
    return success({ taskId: query.taskId, revision: 'a'.repeat(64), items: matches, nextCursor: null, total: files.length, matches: matches.length, unstaged: 34, selected: { files: selected.length, add: selected.reduce((n,file) => n + file.add,0), del: selected.reduce((n,file) => n + file.del,0), staged: selected.filter(file=>file.staged).length, unstaged: selected.filter(file=>!file.staged).length }, running: ['Guard concurrent requests'] });
  };
  private gitFailure: 'message' | 'unknown' | null = null;
  private gitActionHeld = false;
  private readonly pendingGitActions = new Set<() => void>();
  setGitFailure(value: 'message' | 'unknown' | null): void { this.gitFailure = value; }
  setGitActionHeld(held: boolean): void {
    this.gitActionHeld = held;
    if (!held) for (const finish of this.pendingGitActions) finish();
  }
  workspaceGitAction = async (scope: string, input: WorkspaceGitAction) => {
    this.sentGitActions.push(input);
    if (this.gitActionHeld) await new Promise<void>(resolve => {
      const finish = () => { this.pendingGitActions.delete(finish); resolve(); };
      this.pendingGitActions.add(finish);
    });
    const failure = this.gitFailure; this.gitFailure = null;
    if (failure) return { ok: false as const, error: failure === 'unknown'
      ? { code: 'outcome-unknown' as const, message: 'The operation may have completed. Refresh status before trying again.' }
      : { code: 'http' as const, status: 409, message: 'Elevenex could not write a commit message. Enter a message above and try again.' } };
    const previous = (await this.workspaceGit(scope, input.taskId));
    if (!previous.ok) return previous;
    const summary = { ...previous.value, ...(input.type === 'commit' ? { files: input.selection?.includedSecrets.includes('.env.local') ? 0 : 1, additions: 31, deletions: 0, ahead: input.push ? 0 : 1 } : {}), ...(input.type === 'push' ? { ahead: 0 } : {}), ...(input.type === 'sync' ? { behind: 0 } : {}), ...(input.type === 'rename-branch' ? { branch: input.branchName } : {}) };
    this.git.set(input.taskId, summary); return success(summary);
  };
  private detail(id: number): WorkspaceProjectDetail { return { project: this.projectRows.find(project => project.id === id)!, repositories: page([{ id, projectId: id, name: id === 1 ? 'payments-api' : 'storefront', path: `/preview/project-${id}`, defaultBase: 'main' }]) }; }
}
