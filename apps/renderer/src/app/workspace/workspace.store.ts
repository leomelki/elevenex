import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import type { BackendResult, EnvironmentContext, EnvironmentSelection, WorkspacePage, WorkspaceViewState, WorkspaceCreateProject, WorkspaceBranch, WorkspaceProject, WorkspaceProjectDetail, WorkspaceRepository, WorkspaceSession, WorkspaceTask, WorkspaceTaskRecovery } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import type { Machine } from '../machines';
import { projectFace, type CreateProjectIntent, type FolderProvider, type ProjectNameProvider, type ProjectAppearance } from '../projects';
import type { BranchInfo, CreatedTask, PlannedTask, Project, StatusCounts, SummaryStatus, TaskOutline, TaskSessionDisclosure, TaskRepository, TaskStage } from '../tasks';
import { workspaceSessionStatus, workspaceTaskStage, type WorkspaceSelection } from './workspace.models';
import { WorkspaceSessionArchives } from './workspace-session-archives';
import { WorkspaceNavigationObserver } from './workspace-navigation-observer';
import { WorkspaceResume } from './workspace-resume';
import { WorkspaceRestoration, projectWindowCursor, type RestoredTaskWindow } from './workspace-restoration';

/** A workspace owns bounded visible pages. Resource IDs never outlive their scope. */
@Injectable()
export class WorkspaceStore {
  private readonly backend = inject(BackendClientService);
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  private readonly document = inject(DOCUMENT);
  private readonly machineState = signal<Machine | null>(null);
  private readonly enabled = signal(false);
  private readonly projectRecords = signal<readonly WorkspaceProject[]>([]);
  private readonly taskRecords = signal<readonly WorkspaceTask[]>([]);
  private readonly sessionRecords = signal<ReadonlyMap<number, readonly WorkspaceSession[]>>(new Map());
  private readonly sessionCursors = signal<ReadonlyMap<number, string | null>>(new Map());
  private readonly detail = signal<WorkspaceProjectDetail | null>(null);
  private readonly chosen = signal<WorkspaceSelection | null>(null);
  private readonly resume = new WorkspaceResume(this.bridge);
  private readonly restoration = new WorkspaceRestoration(this.bridge);
  readonly resumeError = this.resume.error.asReadonly();
  readonly restoring = signal(false);
  readonly panelOpen = signal(false);
  readonly panel = signal<WorkspaceViewState['panel']>('changes');
  readonly wideReview = signal(false);
  private resumeContext: EnvironmentContext | null = null;
  private resumeLoaded = false;
  readonly commitPanelAvailable = signal(false);
  readonly sessionArchiveAvailable = signal(false);
  readonly sessionArchiveHistoryAvailable = signal(false);
  private readonly archives = new WorkspaceSessionArchives(this.bridge, scope => this.valid(scope));
  readonly sessionDisclosures = signal<ReadonlyMap<string, TaskSessionDisclosure>>(new Map());
  readonly sessionArchiveUndo = signal<{ readonly scopeId: string; readonly session: WorkspaceSession } | null>(null);
  readonly scopeId = signal<string | null>(null);
  readonly activeProject = signal('all');
  readonly filter = signal<SummaryStatus | null>(null);
  readonly closed = signal(false);
  readonly focused = signal(false);
  readonly loading = signal(false);
  readonly pendingTask = signal<WorkspaceTask | null>(null);
  readonly preparationPaused = signal(false);
  readonly busy = signal(false);
  readonly mutationUncertain = signal(false);
  readonly error = signal<string | null>(null);
  readonly dialog = signal<'project' | 'task' | 'settings' | 'delete' | null>(null);
  readonly dialogOpen = signal(false);
  readonly dialogFrom = signal<HTMLElement | null>(null);
  readonly dialogKey = signal(0);
  /** A successful creation asks the view to focus its visible next action. */
  readonly projectCreated = signal<number | null>(null);
  readonly settingsAdding = signal(false);
  readonly closeUndo = signal<{ readonly scopeId: string; readonly task: WorkspaceTask } | null>(null);
  readonly archiveUndo = signal<{ readonly scopeId: string; readonly project: WorkspaceProject } | null>(null);
  readonly projectsCursor = signal<string | null>(null);
  readonly projectPage = signal(false);
  readonly tasksCursor = signal<string | null>(null);
  readonly taskPage = signal(false);
  readonly branches = signal<ReadonlyMap<string, readonly BranchInfo[]>>(new Map());
  readonly baseBranches = signal<ReadonlyMap<string, readonly BranchInfo[]>>(new Map());
  readonly branchLoading = signal(false);
  private readonly defaultBranches = signal<ReadonlyMap<string, string>>(new Map());
  readonly machine = this.machineState.asReadonly();
  readonly selected = this.chosen.asReadonly();
  readonly projects = computed<readonly Project[]>(() => {
    const activity = new Map<number, { attention: number; running: number }>();
    for (const task of this.taskRecords()) {
      if (workspaceTaskStage(task) === 'closed') continue;
      const counts = activity.get(task.projectId) ?? { attention: 0, running: 0 };
      for (const session of this.sessionRecords().get(task.id) ?? []) {
        const status = workspaceSessionStatus(session);
        if (status === 'attention' || status === 'failed') counts.attention++;
        if (status === 'running') counts.running++;
      }
      activity.set(task.projectId, counts);
    }
    return this.projectRecords().map(project => ({ id: String(project.id), ...projectFace({ name: project.name, ...project.appearance }), ...activity.get(project.id), muted: this.focused() && this.activeProject() !== String(project.id) }));
  });
  readonly selectedProject = computed(() => this.projectRecords().find(project => String(project.id) === this.activeProject()) ?? null);
  readonly selectedTask = computed(() => this.taskRecords().find(task => task.id === this.chosen()?.taskId) ?? null);
  readonly selectedTaskStage = computed(() => { const task = this.selectedTask(); return task ? workspaceTaskStage(task) : 'active'; });
  readonly selectedSession = computed(() => {
    const selection = this.chosen();
    return selection ? this.sessionRecords().get(selection.taskId)?.find(session => session.id === selection.sessionId) ?? this.archives.pages().get(selection.taskId)?.sessions.find(session => session.id === selection.sessionId) ?? null : null;
  });
  readonly repositories = computed<readonly WorkspaceRepository[]>(() => this.detail()?.repositories.items ?? []);
  readonly taskRepositories = computed<readonly TaskRepository[]>(() => this.repositories().map(repo => ({ id: String(repo.id), name: repo.name, path: repo.path, base: this.defaultBranches().get(String(repo.id)) })));
  readonly tasks = computed<readonly TaskOutline[]>(() => this.taskRecords().map(task => ({
    id: String(task.id), title: task.name, stage: workspaceTaskStage(task),
    ...(this.sessionArchiveHistoryAvailable() && !this.closed() && task.state === 'ready' && this.hasArchivedSessions(task.id) ? { archive: {
      sessions: (this.archives.pages().get(task.id)?.sessions ?? []).map(session => ({ id: String(session.id), title: session.name, status: workspaceSessionStatus(session) })),
      loaded: this.archives.pages().get(task.id)?.loaded ?? false,
      loading: this.archives.pages().get(task.id)?.loading ?? false,
      error: this.archives.pages().get(task.id)?.error ?? null,
      more: !!this.archives.pages().get(task.id)?.nextCursor,
      earlier: !!this.archives.pages().get(task.id)?.cursor,
    } } : {}),
    moreSessions: !!this.sessionCursors().get(task.id),
    sessionsDirection: 'earlier',
    canAddSession: task.state === 'ready',
    project: this.projects().find(project => project.id === String(task.projectId)) ?? (task.projectName ? projectFace({ name: task.projectName }) : undefined),
    // Unknown cardinality from older runtimes keeps their existing repository hint.
    ...(task.repoName && task.projectRepositoryCount !== 1 ? { repo: task.repoName } : {}),
    sessions: (this.sessionRecords().get(task.id) ?? []).map(session => ({ id: String(session.id), title: session.name, status: workspaceSessionStatus(session) })),
  })));
  readonly counts = computed<StatusCounts>(() => {
    const counts = { attention: 0, running: 0, review: 0, done: 0 };
    for (const task of this.tasks()) {
      if (task.stage === 'closed') continue;
      for (const session of task.sessions) {
        const status = session.status === 'failed' ? 'attention' : session.status;
        if (status === 'attention' || status === 'running' || status === 'review' || status === 'done') counts[status]++;
      }
    }
    return counts;
  });
  private revision = 0;
  private listRevision = 0;
  private disposed = false;
  private preparationRevision = 0;
  private uncertainSetup: { readonly scope: string; readonly taskId: number } | null = null;
  private preparationTimer?: ReturnType<typeof setTimeout>;
  private branchTimer?: ReturnType<typeof setTimeout>;
  private branchRevision = 0;
  private taskRequestId = crypto.randomUUID();
  private observer?: WorkspaceNavigationObserver;
  private capable = false;
  private projectCompletion: { readonly scope: string; readonly projectId: number } | null = null;

  constructor() {
    effect(() => {
      const scope = this.backend.state().scope;
      const machine = this.machineState();
      const matches = machine && scope && (machine.kind === 'local' ? scope.environment.kind === 'local' : scope.environment.kind === 'remote' && scope.environment.hostId === machine.id);
      const next = this.enabled() && matches ? scope.id : null;
      untracked(() => {
        if (next === this.scopeId()) return;
        this.reset(next);
        if (next) {
          this.loading.set(true);
          this.observer = new WorkspaceNavigationObserver(this.document, async () => { const result = await this.bridge.workspaceRevision(next); if (this.valid(next) && result.ok) { this.commitPanelAvailable.set(result.value.commitPanel === true); this.sessionArchiveAvailable.set(result.value.sessionArchive === true); this.sessionArchiveHistoryAvailable.set(result.value.sessionArchiveHistory === true); } return result; }, () => this.valid(next) && !this.loading() && !this.busy() && !this.pendingTask(), () => { this.capable = true; return this.refreshVisible(); }, message => { if (this.valid(next)) { this.loading.set(false); this.error.set(message); } });
        }
      });
    });
    effect(() => {
      const scope = this.scopeId(), environment = this.backend.state().scope?.environment;
      if (!scope || !environment || this.restoring() || this.loading() || this.busy()) return;
      this.saveView(scope, environment);
    });
    inject(DestroyRef).onDestroy(() => { this.saveBeforeExit(); this.disposed = true; this.archives.reset(); this.revision++; this.listRevision++; this.stopPreparation(); clearTimeout(this.branchTimer); this.branchRevision++; this.observer?.dispose(); });
  }

  connect(machine: Machine, active: boolean): void {
    if (!active || this.machineState()?.id !== machine.id) this.saveBeforeExit();
    this.machineState.set(machine); this.enabled.set(active);
  }

  private saveBeforeExit(): void {
    const scope = this.scopeId(), environment = this.backend.state().scope?.environment;
    if (scope && environment && !this.restoring() && !this.loading()) {
      untracked(() => { this.saveView(scope, environment); this.resume.flushBeforeExit(); });
    }
  }

  selectPanel(panel: string): void {
    if (panel === 'terminal' || panel === 'actions' || panel === 'changes' || panel === 'code' || panel === 'browser') this.panel.set(panel);
  }

  async refresh(): Promise<void> {
    const scope = this.scopeId();
    if (!scope) return;
    const revision = ++this.revision;
    this.loading.set(true); this.error.set(null);
    if (!this.resumeLoaded) {
      const environment = this.backend.state().scope?.environment;
      if (!environment) return;
      const context = await this.resume.load(environment, () => this.current(scope, revision));
      if (!this.current(scope, revision)) return;
      this.resumeLoaded = context !== null;
      this.resumeContext = context;
      if (context) { this.restoring.set(true); this.applyView(context); }
    }
    if (!this.capable) {
      const capability = await this.read(scope, () => this.bridge.workspaceRevision(scope));
      if (this.valid(scope)) { this.commitPanelAvailable.set(capability?.commitPanel === true); this.sessionArchiveAvailable.set(capability?.sessionArchive === true); this.sessionArchiveHistoryAvailable.set(capability?.sessionArchiveHistory === true); }
      if (!this.current(scope, revision)) return;
      if (!capability || capability.version !== 1) { this.loading.set(false); this.error.set(this.error() ?? 'This backend needs an update before it can open the workspace.'); return; }
      this.capable = true;
    }
    const saved = this.restoring() ? this.resumeContext : null;
    let projects: WorkspacePage<WorkspaceProject> | null;
    if (saved) {
      const current = () => this.current(scope, revision);
      const window = await this.read(scope, () => this.restoration.projects(scope, saved, current), current);
      if (!this.current(scope, revision)) return;
      projects = window?.page ?? null;
      this.currentProjectCursor = window?.cursor;
    } else {
      projects = await this.read(scope, () => this.bridge.workspaceProjects(scope, { limit: 50 }));
      if (!this.current(scope, revision)) return;
      this.currentProjectCursor = undefined;
    }
    if (projects) {
      this.projectRecords.set(projects.items); this.projectsCursor.set(projects.nextCursor);
      this.projectPage.set(!!this.currentProjectCursor);
      if (this.activeProject() !== 'all' && !projects.items.some(project => String(project.id) === this.activeProject())) this.activeProject.set('all');
      if (saved) await this.restoreTasks(scope, revision, saved);
      else await this.loadTasks();
      if (this.current(scope, revision) && !this.error()) { this.resumeContext = null; this.restoring.set(false); }
      if (this.current(scope, revision) && !this.error()) { this.mutationUncertain.set(false); this.uncertainSetup = null; }
    }
    if (this.current(scope, revision)) this.loading.set(false);
  }

  private applyView(context: EnvironmentContext): void {
    this.activeProject.set(context.projectId === null ? 'all' : String(context.projectId));
    const view = context.workspace;
    if (!view) return;
    this.panel.set(view.panel); this.panelOpen.set(view.panelOpen); this.wideReview.set(view.panelOpen && view.wideReview);
    this.closed.set(view.closed); this.focused.set(view.focused); this.filter.set(view.filter);
    this.currentProjectCursor = view.projectCursor ?? undefined; this.currentTaskCursor = view.taskCursor ?? undefined;
  }

  private saveView(scope: string, environment: EnvironmentSelection): void {
    const selection = this.chosen(), pending = this.pendingTask();
    this.resume.save({ projectId: this.activeProject() === 'all' ? null : Number(this.activeProject()),
      taskId: selection?.taskId ?? pending?.id ?? null, sessionId: selection?.sessionId ?? null,
      workspace: { panel: this.panel(), panelOpen: this.panelOpen(), wideReview: this.panelOpen() && this.wideReview(),
        closed: this.closed(), focused: this.focused(), filter: this.filter(), projectCursor: this.currentProjectCursor ?? null, taskCursor: this.currentTaskCursor ?? null },
    }, environment, () => this.valid(scope));
  }

  private async restoreTasks(scope: string, revision: number, saved: EnvironmentContext): Promise<void> {
    const listRevision = ++this.listRevision;
    const current = () => this.current(scope, revision) && listRevision === this.listRevision && this.restoring();
    const projectId = this.activeProject() === 'all' ? null : Number(this.activeProject());
    const restored = await this.read(scope, () => this.restoration.tasks(scope, {
      saved, projectId, archiveHistory: this.sessionArchiveHistoryAvailable(),
    }, current), current);
    if (!restored || !current()) return;
    this.closed.set(restored.closed);
    this.currentTaskCursor = restored.cursor;
    await this.hydrateTasks(scope, listRevision, restored.page, restored.cursor, restored);
    if (!current() || this.error()) return;
    this.chosen.set(restored.selection ? { scopeId: scope, ...restored.selection } : null);
    this.pendingTask.set(restored.pendingTask ?? null);
    this.preparationPaused.set(!!restored.pendingTask);
  }

  private leaveResume(): void {
    if (!this.restoring()) return;
    this.restoring.set(false); this.resumeContext = null; this.revision++;
  }

  private async refreshVisible(): Promise<void> {
    // Keep later page cursors stable until the user explicitly returns to page one.
    if (this.projectPage() || this.taskPage()) {
      const scope = this.scopeId();
      if (!scope) return;
      const projects = await this.read(scope, () => this.bridge.workspaceProjects(scope, { limit: 50, ...(this.currentProjectCursor ? { cursor: this.currentProjectCursor } : {}) }));
      if (projects) { this.projectRecords.set(projects.items); this.projectsCursor.set(projects.nextCursor); }
      await this.loadTasks(this.currentTaskCursor); return;
    }
    await this.refresh();
  }
  private currentTaskCursor?: string;
  private currentProjectCursor?: string;

  async nextProjects(): Promise<void> {
    const scope = this.scopeId(), cursor = this.projectsCursor();
    if (!scope || !cursor || this.loading()) return;
    this.loading.set(true);
    const result = await this.read(scope, () => this.bridge.workspaceProjects(scope, { limit: 50, cursor }));
    if (result) { this.currentProjectCursor = cursor; this.projectRecords.set(result.items); this.projectsCursor.set(result.nextCursor); this.projectPage.set(true); this.activeProject.set('all'); await this.loadTasks(); }
    if (this.scopeId() === scope) this.loading.set(false);
  }

  async selectProject(id: string): Promise<void> {
    if (id !== 'all' && !this.projects().some(project => project.id === id)) return;
    this.leaveResume();
    const task = this.selectedTask();
    const retainedTask = task && workspaceTaskStage(task) !== 'closed' && (id === 'all' || String(task.projectId) === id) ? task : null;
    this.projectCreated.set(null);
    this.stopPreparation(); this.activeProject.set(id); this.focused.set(false); this.filter.set(null); this.closed.set(false); this.detail.set(null);
    if (!retainedTask) this.chosen.set(null);
    // Keep every matching row mounted while loading, including unselected tasks.
    // Removing survivors here makes Fold exit/re-enter and can lose local state
    // when the backend takes longer than the presence cleanup deadline.
    this.taskRecords.update(tasks => tasks.filter(task => workspaceTaskStage(task) !== 'closed' && (id === 'all' || String(task.projectId) === id)));
    this.tasksCursor.set(null); this.taskPage.set(false);
    await this.loadTasks();
  }

  async loadTasks(cursor?: string): Promise<void> {
    const scope = this.scopeId();
    if (!scope) return;
    this.leaveResume();
    const revision = ++this.listRevision;
    this.currentTaskCursor = cursor;
    this.loading.set(true); this.error.set(null);
    const projectId = this.activeProject() === 'all' ? null : Number(this.activeProject());
    const result = await this.read(scope, () => this.bridge.workspaceTasks(scope, { projectId, state: this.closed() ? 'finished' : 'active', limit: 20, ...(cursor ? { cursor } : {}) }), () => revision === this.listRevision);
    if (!result || revision !== this.listRevision || this.scopeId() !== scope) { if (revision === this.listRevision) this.loading.set(false); return; }
    await this.hydrateTasks(scope, revision, result, cursor);
  }

  private async hydrateTasks(scope: string, revision: number, result: WorkspacePage<WorkspaceTask>, cursor?: string, restored?: RestoredTaskWindow): Promise<void> {
    this.archives.retain(this.closed() ? [] : result.items.map(task => task.id));
    const archive = restored?.archive;
    if (archive) this.archives.acceptRestoredWindow(scope, archive.taskId, archive.page, archive.cursor);
    const sessions = new Map<number, readonly WorkspaceSession[]>();
    const cursors = new Map<number, string | null>();
    // Four workers bound both transport concurrency and first-paint memory.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, result.items.length) }, async () => {
      while (index < result.items.length && revision === this.listRevision && this.scopeId() === scope) {
        const task = result.items[index++];
        if (!task) continue;
        const page = restored?.sessions?.taskId === task.id ? restored.sessions.page
          : await this.read(scope, () => this.bridge.workspaceSessions(scope, { taskId: task.id, limit: 20, order: 'latest' }), () => revision === this.listRevision);
        if (page) { sessions.set(task.id, page.items); cursors.set(task.id, page.nextCursor); }
        if (revision === this.listRevision && this.sessionArchiveHistoryAvailable() && !this.closed() && task.state === 'ready' && archive?.taskId !== task.id) await this.archives.refresh(scope, task.id);
      }
    }));
    if (revision !== this.listRevision || this.scopeId() !== scope) return;
    const previous = this.selectedSession(), selection = this.chosen();
    if (previous && previous.status !== 'archived' && selection && sessions.has(selection.taskId) && !sessions.get(selection.taskId)?.some(session => session.id === previous.id)) sessions.set(selection.taskId, [...(sessions.get(selection.taskId) ?? []).slice(0, 19), previous].sort((a,b) => a.id - b.id));
    this.taskRecords.set(result.items); this.sessionRecords.set(sessions); this.sessionCursors.set(cursors); this.tasksCursor.set(result.nextCursor); this.taskPage.set(!!cursor);
    if (this.chosen() && !result.items.some(task => task.id === this.chosen()?.taskId)) this.chosen.set(null);
    if (!this.restoring()) this.loading.set(false);
  }

  selectSession(selection: { readonly taskId: string; readonly sessionId: string }): void {
    const scopeId = this.scopeId(), taskId = Number(selection.taskId), sessionId = Number(selection.sessionId);
    if (!scopeId || !this.taskRecords().some(task => task.id === taskId) || !this.sessionRecords().get(taskId)?.some(session => session.id === sessionId) && !this.archives.pages().get(taskId)?.sessions.some(session => session.id === sessionId)) return;
    this.leaveResume();
    this.stopPreparation();
    this.chosen.set({ scopeId, taskId, sessionId });
  }
  openEmptyTask(id: string): void {
    const task = this.taskRecords().find(task => String(task.id) === id), scope = this.scopeId();
    if (!task || !scope || this.busy()) return;
    this.leaveResume();
    if (task.state === 'ready') { void this.createSession(id); return; }
    this.stopPreparation(); this.chosen.set(null); this.pendingTask.set(task);
    if (task.state !== 'failed') void this.prepareTask(scope, task.id, this.preparationRevision, Date.now(), 0);
  }

  async createSession(id: string): Promise<void> {
    const scope = this.scopeId(), taskId = Number(id), revision = this.listRevision;
    if (!scope || this.busy() || !this.taskRecords().some(task => task.id === taskId)) return;
    this.busy.set(true);
    const session = await this.mutate(scope, () => this.bridge.workspaceCreateSession(scope, { taskId }));
    if (session && revision === this.listRevision) {
      this.sessionRecords.update(records => new Map(records).set(taskId, [...(records.get(taskId) ?? []).slice(-19), session]));
      this.chosen.set({ scopeId: scope, taskId, sessionId: session.id });
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }

  async archiveSession(intent: { readonly taskId: string; readonly session: { readonly id: string; readonly status: string } }): Promise<void> {
    const scope = this.scopeId(), taskId = Number(intent.taskId), sessionId = Number(intent.session.id), revision = this.listRevision;
    const session = this.sessionRecords().get(taskId)?.find(session => session.id === sessionId);
    if (!scope || !session || this.busy() || !this.sessionArchiveAvailable()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceArchiveSession(scope, { taskId, sessionId, confirmStop: intent.session.status === 'running' }));
    if (result) {
      this.closeUndo.set(null); this.archiveUndo.set(null);
      this.sessionArchiveUndo.set({ scopeId: scope, session });
      if (revision === this.listRevision) {
        const sessions = this.sessionRecords().get(taskId) ?? [], at = sessions.findIndex(session => session.id === sessionId);
        const remaining = sessions.filter(session => session.id !== sessionId);
        this.sessionRecords.update(records => new Map(records).set(taskId, remaining));
        const selection = this.chosen();
        if (selection?.taskId === taskId && selection.sessionId === sessionId) {
          const next = remaining[at] ?? remaining[0];
          this.chosen.set(next ? { scopeId: scope, taskId, sessionId: next.id } : null);
        }
      }
    }
    if (result && this.sessionArchiveHistoryAvailable()) await this.archives.changed(scope, taskId);
    if (this.valid(scope)) this.busy.set(false);
  }
  private hasArchivedSessions(taskId: number): boolean {
    const page = this.archives.pages().get(taskId);
    return !!page && !!(page.sessions.length || page.cursor || page.nextCursor || page.error);
  }
  async loadArchivedSessions(intent: { readonly taskId: string; readonly page: 'latest' | 'earlier' }): Promise<void> {
    const scope = this.scopeId(), taskId = Number(intent.taskId);
    if (!scope || !this.sessionArchiveHistoryAvailable() || this.closed() || this.busy() || !this.taskRecords().some(task => task.id === taskId)) return;
    const selection = this.chosen();
    const selectedArchive = selection?.taskId === taskId && this.archives.pages().get(taskId)?.sessions.some(session => session.id === selection.sessionId);
    await this.archives.load(scope, taskId, intent.page);
    if (this.valid(scope) && this.chosen() === selection && selectedArchive && !this.archives.pages().get(taskId)?.sessions.some(session => session.id === selection?.sessionId)) this.chosen.set(null);
  }
  async restoreSession(intent: { readonly taskId: string; readonly session: { readonly id: string } }): Promise<void> {
    const scope = this.scopeId(), taskId = Number(intent.taskId), sessionId = Number(intent.session.id);
    if (!scope || this.busy() || this.closed() || !this.archives.pages().get(taskId)?.sessions.some(session => session.id === sessionId)) return;
    await this.restoreArchivedSession(scope, taskId, sessionId);
    if (this.valid(scope) && this.sessionRecords().get(taskId)?.some(session => session.id === sessionId)) this.selectSession({ taskId: intent.taskId, sessionId: intent.session.id });
  }
  async undoSessionArchive(): Promise<void> {
    const undo = this.sessionArchiveUndo();
    if (!undo || !this.valid(undo.scopeId) || this.busy()) return;
    await this.restoreArchivedSession(undo.scopeId, undo.session.taskId, undo.session.id);
  }
  private async restoreArchivedSession(scope: string, taskId: number, sessionId: number): Promise<void> {
    this.busy.set(true);
    const revision = this.listRevision;
    const restored = await this.mutate(scope, () => this.bridge.workspaceRestoreSession(scope, { taskId, sessionId }));
    if (restored) {
      if (this.sessionArchiveUndo()?.session.id === sessionId) this.sessionArchiveUndo.set(null);
      if (revision === this.listRevision && this.taskRecords().some(task => task.id === taskId) && !this.closed()) {
        this.sessionRecords.update(records => new Map(records).set(taskId, [...(records.get(taskId) ?? []).filter(session => session.id !== sessionId), restored].sort((a, b) => a.id - b.id).slice(-100)));
      }
      if (this.sessionArchiveHistoryAvailable()) await this.archives.changed(scope, taskId, sessionId);
    }
    if (this.valid(scope)) this.busy.set(false);
  }

  async nextSessions(id: string): Promise<void> {
    const scope = this.scopeId(), taskId = Number(id), cursor = this.sessionCursors().get(taskId), revision = this.listRevision;
    if (!scope || !cursor || this.busy() || !this.taskRecords().some(task => task.id === taskId)) return;
    this.busy.set(true);
    const page = await this.read(scope, () => this.bridge.workspaceSessions(scope, { taskId, cursor, limit: 20, order: 'latest' }));
    if (page && revision === this.listRevision) {
      this.sessionRecords.update(records => new Map(records).set(taskId, page.items));
      this.sessionCursors.update(cursors => new Map(cursors).set(taskId, page.nextCursor));
      if (this.chosen()?.taskId === taskId) this.chosen.set(null);
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  reconcileTaskBranch(scope: string, taskId: number, branch: string): void { if (this.valid(scope)) this.taskRecords.update(tasks => tasks.map(task => task.id === taskId ? { ...task, branchName: branch } : task)); }
  openNewProject(from: HTMLElement | null = null): void {
    if (!this.capable || !this.scopeId() || this.busy()) return;
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(from); this.error.set(null);
    this.dialogKey.update(value => value + 1); this.dialog.set('project'); this.dialogOpen.set(true);
  }
  async openNewTask(projectId?: string): Promise<void> {
    const project = (projectId ? this.projectRecords().find(item => String(item.id) === projectId) : this.selectedProject()) ?? this.projectRecords()[0];
    const scope = this.scopeId();
    const selectionRevision = this.listRevision;
    if (!scope || !project || this.busy()) return;
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(null);
    this.error.set(null); this.busy.set(true);
    const detail = await this.read(scope, () => this.bridge.workspaceProject(scope, project.id));
    if (detail && selectionRevision === this.listRevision) {
      this.detail.set(detail);
      const branches = new Map<string, readonly BranchInfo[]>();
      for (const repo of detail.repositories.items.slice(0, 1)) {
        const page = await this.read(scope, () => this.bridge.workspaceBranches(scope, { repoId: repo.id, limit: 50 }));
        if (page) branches.set(String(repo.id), page.map(branchView));
      }
      if (this.scopeId() === scope && selectionRevision === this.listRevision) { this.branches.set(branches); this.baseBranches.set(branches); this.defaultBranches.set(new Map(detail.repositories.items.flatMap(repo => { const base = repo.defaultBase ?? branches.get(String(repo.id))?.find(item => item.isDefault)?.name; return base ? [[String(repo.id), base] as const] : []; }))); this.taskRequestId = crypto.randomUUID(); this.dialogKey.update(value => value + 1); this.dialog.set('task'); this.dialogOpen.set(true); }
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  readonly branchesFor = (repoId: string): readonly BranchInfo[] => this.branches().get(repoId) ?? [];
  readonly basesFor = (repoId: string): readonly BranchInfo[] => this.baseBranches().get(repoId) ?? [];
  searchBranches(query: { readonly repoId: string; readonly query: string; readonly kind: 'branch' | 'base' }): void {
    const scope = this.scopeId(), dialog = this.dialogKey(), revision = ++this.branchRevision;
    clearTimeout(this.branchTimer);
    if (!scope || !this.repositories().some(repo => String(repo.id) === query.repoId)) return;
    this.branchLoading.set(true);
    this.branchTimer = setTimeout(() => {
      this.branchTimer = undefined;
      void this.read(scope, () => this.bridge.workspaceBranches(scope, { repoId: Number(query.repoId), query: query.query, limit: 50 }), () => revision === this.branchRevision && this.dialogKey() === dialog && this.dialogOpen()).then(result => {
        if (revision !== this.branchRevision || this.dialogKey() !== dialog || !this.dialogOpen()) return;
        this.branchLoading.set(false);
        if (!result) return;
        const target = query.kind === 'base' ? this.baseBranches : this.branches;
        target.update(choices => new Map(choices).set(query.repoId, result.map(branchView)));
        const base = result[0]?.defaultBase;
        if (base && this.defaultBranches().get(query.repoId) !== base) this.defaultBranches.update(bases => new Map(bases).set(query.repoId, base));
      });
    }, 160);
  }
  /** Provider identity bounds the picker's cache to one backend scope. */
  readonly folderProvider = computed<FolderProvider>(() => {
    const scope = this.scopeId();
    return (query, signal) => this.readFolders(scope, query, signal);
  });
  readonly listFolders: FolderProvider = (query, signal) => this.readFolders(this.scopeId(), query, signal);
  readonly projectNameProvider = computed<ProjectNameProvider>(() => {
    const scope = this.scopeId();
    return async (name, signal) => {
      if (!scope || !this.valid(scope) || signal.aborted) throw new Error('Project name check interrupted.');
      const result = await this.bridge.workspaceProjectNameAvailability(scope, name);
      if (!this.valid(scope) || signal.aborted) throw new Error('Project name check interrupted.');
      if (!result.ok) throw new Error(result.error.message);
      return result.value.available;
    };
  });
  private async readFolders(scope: string | null, query: string, signal: AbortSignal) {
    if (!scope || !this.valid(scope) || signal.aborted) return [];
    // Abort superseded keystrokes before starting another directory read over IPC.
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 140);
      signal.addEventListener('abort', finish, { once: true });
    });
    if (signal.aborted || !this.valid(scope)) return [];
    const result = await this.bridge.workspaceFolders(scope, { query, limit: 50 });
    if (signal.aborted || !this.valid(scope)) return [];
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  readonly draftProject = computed(() => this.detail()?.project ?? this.selectedProject());
  readonly draftProjectMark = computed(() => { const project = this.draftProject(); return projectFace({ name: project?.name ?? '', ...project?.appearance }); });
  closeDialog(): void { if (!this.busy()) { this.projectCompletion = null; this.dialogOpen.set(false); } }
  dialogClosed(): void {
    const completed = this.projectCompletion;
    this.projectCompletion = null;
    if (completed && this.valid(completed.scope) && !this.dialogOpen() && this.activeProject() === String(completed.projectId)) this.projectCreated.set(completed.projectId);
  }

  async createTask(draft: CreatedTask, planned = false): Promise<void> {
    const scope = this.scopeId(), repo = this.repositories().find(repo => String(repo.id) === draft.repo) ?? this.repositories()[0], selectionRevision = this.listRevision;
    if (!scope || !repo || this.busy()) return;
    this.busy.set(true);
    const task = await this.mutate(scope, () => this.bridge.workspaceCreateTask(scope, { repoId: repo.id, name: draft.title, branchName: draft.branch, mode: draft.existing ? 'existing' : 'new', ...(draft.base ? { baseRef: draft.base } : {}), requestId: this.taskRequestId }));
    if (task && selectionRevision === this.listRevision) {
      if (planned) await this.mutate(scope, () => this.bridge.workspaceSetStage(scope, { taskId: task.id, stage: 'planned' }));
      this.dialogOpen.set(false); this.activeProject.set(String(task.projectId)); this.closed.set(false);
      this.stopPreparation(); this.chosen.set(null); this.pendingTask.set(task);
      this.taskRecords.update(tasks => [task, ...tasks.filter(item => item.id !== task.id)].slice(0, 20));
      const revision = this.preparationRevision;
      void this.prepareTask(scope, task.id, revision, Date.now(), 0);
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }

  async planTask(draft: PlannedTask): Promise<void> {
    const repo = this.repositories().find(repo => String(repo.id) === draft.repo) ?? this.repositories()[0];
    const base = draft.base ?? (repo ? this.branchesFor(String(repo.id)).find(branch => branch.isDefault)?.name : undefined);
    await this.createTask({ ...draft, branch: draft.branch || draft.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), existing: false, base: base ?? null }, true);
  }

  async setStage(stage: TaskStage): Promise<void> {
    if (stage === 'closed') { await this.closeTask(); return; }
    const scope = this.scopeId(), task = this.selectedTask();
    if (!scope || !task || this.busy()) return;
    this.busy.set(true);
    const changed = await this.mutate(scope, () => this.bridge.workspaceSetStage(scope, { taskId: task.id, stage }));
    if (changed) this.taskRecords.update(tasks => tasks.map(item => item.id === task.id ? changed : item));
    if (this.scopeId() === scope) this.busy.set(false);
  }

  async createProject(intent: CreateProjectIntent): Promise<void> {
    const scope = this.scopeId(), first = intent.project.repos[0];
    if (!scope || !first || this.busy()) return;
    const laterProject = this.dialog() === 'project' && this.dialogOpen() && this.projectRecords().length > 0;
    const dialogKey = this.dialogKey();
    this.busy.set(true);
    const draft = intent.project;
    const request: WorkspaceCreateProject = {
      name: draft.name,
      path: first.path,
      additionalPaths: draft.repos.slice(1).map(repo => repo.path),
      repositorySetup: draft.repos.map(repo => ({
        path: repo.path,
        ...(repo.clone ? { clone: repo.clone } : {}),
        ...(repo.initialize ? { initialize: true } : {}),
      })),
      appearance: {
        look: draft.look,
        hue: draft.hue,
        ...(draft.emoji ? { emoji: draft.emoji } : {}),
        ...(draft.icon ? { icon: draft.icon } : {}),
      },
    };
    const project = await this.mutate(scope, () => this.bridge.workspaceCreateProject(scope, request));
    if (project) {
      await this.refresh();
      if (!this.valid(scope)) return;
      if (!this.projectRecords().some(item => item.id === project.project.id)) {
        // Open a bounded window around the new resource; keep its cursor for revision refreshes.
        const cursor = projectWindowCursor(project.project.id);
        const page = await this.read(scope, () => this.bridge.workspaceProjects(scope, { limit: 50, cursor }));
        if (!this.valid(scope)) return;
        this.projectRecords.set(page?.items.some(item => item.id === project.project.id) ? page.items : [project.project]);
        this.projectsCursor.set(page?.nextCursor ?? null);
        this.currentProjectCursor = cursor; this.projectPage.set(true);
      }
      this.stopPreparation(); this.chosen.set(null);
      this.activeProject.set(String(project.project.id)); await this.loadTasks();
      if (!this.valid(scope)) return;
      this.busy.set(false);
      if (laterProject && this.dialogKey() === dialogKey && this.dialog() === 'project') this.projectCompletion = { scope, projectId: project.project.id };
      else this.projectCreated.set(project.project.id);
      this.dialogFrom.set(null); this.dialogOpen.set(false);
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }

  async showClosed(closed = !this.closed()): Promise<void> {
    this.leaveResume();
    this.stopPreparation(); this.closed.set(closed); this.chosen.set(null);
    this.taskRecords.set([]); this.tasksCursor.set(null); this.taskPage.set(false);
    await this.loadTasks();
  }
  async reconcilePreparation(): Promise<void> {
    const task = this.pendingTask(), scope = this.scopeId();
    if (!task || !scope || this.busy()) return;
    this.busy.set(true);
    this.stopPreparation(); this.pendingTask.set(task); this.error.set(null);
    const revision = this.preparationRevision;
    try {
      await this.prepareTask(scope, task.id, revision, Date.now(), 0);
      if (this.valid(scope) && revision === this.preparationRevision && !this.preparationPaused() && this.uncertainSetup?.scope === scope && this.uncertainSetup.taskId === task.id) {
        this.mutationUncertain.set(false); this.uncertainSetup = null;
      }
    } finally { if (this.valid(scope)) this.busy.set(false); }
  }
  async retryPreparation(recovery?: WorkspaceTaskRecovery): Promise<void> {
    const task = this.pendingTask(), scope = this.scopeId();
    if (!task || !scope || this.busy() || this.mutationUncertain()) return;
    if (recovery === 'use-existing' && task.setupIssue?.code !== 'external-checkout') return;
    if (recovery === 'snapshot' && !task.setupIssue?.canUseSnapshot) return;
    if (recovery === 'exceed-worktree-limit' && !task.setupIssue?.canExceedWorktreeLimit) return;
    const revision = this.preparationRevision;
    this.busy.set(true);
    const result = await this.mutate(scope, () => recovery === undefined ? this.bridge.workspaceRetryTask(scope, task.id) : this.bridge.workspaceRetryTask(scope, task.id, recovery));
    if (!result && this.valid(scope) && this.mutationUncertain()) this.uncertainSetup = { scope, taskId: task.id };
    if (result && revision === this.preparationRevision && this.pendingTask()?.id === task.id) { this.stopPreparation(); this.pendingTask.set(result); void this.prepareTask(scope, result.id, this.preparationRevision, Date.now(), 0); }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async openSettings(adding = false): Promise<void> {
    const project = this.selectedProject(), scope = this.scopeId();
    if (!scope || !project || this.busy()) return;
    const detail = await this.read(scope, () => this.bridge.workspaceProject(scope, project.id));
    if (detail && this.activeProject() === String(project.id)) { this.detail.set(detail); this.settingsAdding.set(adding); this.dialog.set('settings'); this.dialogOpen.set(true); }
  }
  async updateProject(patch: { readonly name?: string; readonly agentInstructions?: string; readonly appearance?: ProjectAppearance }): Promise<void> {
    const project = this.detail()?.project, scope = this.scopeId();
    if (!scope || !project || this.busy()) return;
    this.busy.set(true);
    const appearance = patch.appearance;
    const result = await this.mutate(scope, () => this.bridge.workspaceUpdateProject(scope, { projectId: project.id, ...(patch.name ? { name: patch.name } : {}), ...(patch.agentInstructions !== undefined ? { agentInstructions: patch.agentInstructions } : {}), ...(appearance ? { appearance: { look: appearance.look, hue: appearance.hue ?? undefined, emoji: appearance.emoji, icon: appearance.icon } } : {}) }));
    if (result) { this.detail.set(result); this.projectRecords.update(projects => projects.map(item => item.id === result.project.id ? result.project : item)); }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async archiveProject(): Promise<void> {
    const project = this.selectedProject(), scope = this.scopeId();
    if (!project || !scope || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceArchiveProject(scope, project.id));
    if (result) { this.sessionArchiveUndo.set(null); this.archiveUndo.set({ scopeId: scope, project }); this.activeProject.set('all'); this.dialogOpen.set(false); await this.refresh(); }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async restoreArchivedProject(): Promise<void> {
    const undo = this.archiveUndo();
    if (!undo || !this.valid(undo.scopeId) || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(undo.scopeId, () => this.bridge.workspaceRestoreProject(undo.scopeId, undo.project.id));
    if (result) { this.archiveUndo.set(null); await this.refresh(); await this.selectProject(String(undo.project.id)); }
    if (this.scopeId() === undo.scopeId) this.busy.set(false);
  }
  requestDeleteProject(): void { const project = this.selectedProject(); if (project && !this.busy()) { this.detail.set({ project, repositories: { items: [], nextCursor: null } }); this.dialog.set('delete'); this.dialogOpen.set(true); } }
  async deleteProject(): Promise<void> {
    const scope = this.scopeId(), project = this.draftProject();
    if (!scope || !project || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceDeleteProject(scope, project.id));
    if (result) { this.activeProject.set('all'); this.dialogOpen.set(false); await this.refresh(); }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async addRepository(path: string): Promise<void> {
    const scope = this.scopeId(), project = this.draftProject();
    if (!scope || !project || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceAddRepository(scope, { projectId: project.id, path }));
    if (result) this.detail.set(result);
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async closeTask(confirmStop = false): Promise<void> {
    const task = this.selectedTask(), scope = this.scopeId(), selection = this.chosen();
    if (!task || !scope || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceFinishTask(scope, { taskId: task.id, confirmStop }));
    if (result) {
      this.sessionArchiveUndo.set(null);
      this.closeUndo.set({ scopeId: scope, task });
      this.taskRecords.update(tasks => tasks.map(item => item.id === task.id ? result : item));
      if (this.chosen() === selection) { this.chosen.set(null); await this.loadTasks(); }
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  async undoClose(): Promise<void> {
    const undo = this.closeUndo();
    if (!undo || !this.valid(undo.scopeId) || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(undo.scopeId, () => this.bridge.workspaceReopenTask(undo.scopeId, undo.task.id));
    if (result) { this.closeUndo.set(null); this.closed.set(false); await this.loadTasks(); }
    if (this.scopeId() === undo.scopeId) this.busy.set(false);
  }
  async reopenTask(id: number): Promise<void> {
    const scope = this.scopeId(), revision = this.listRevision;
    if (!scope || this.busy() || !this.taskRecords().some(task => task.id === id)) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceReopenTask(scope, id));
    if (result && revision === this.listRevision) { this.closed.set(false); await this.loadTasks(); }
    if (this.scopeId() === scope) this.busy.set(false);
  }

  private async prepareTask(scope: string, taskId: number, revision: number, started: number, attempt: number): Promise<void> {
    const current = () => this.valid(scope) && revision === this.preparationRevision && this.pendingTask()?.id === taskId;
    if (!current()) return;
    const task = await this.read(scope, () => this.bridge.workspaceTask(scope, taskId));
    if (!current()) return;
    if (!task) { this.preparationPaused.set(true); return; }
    this.pendingTask.set(task); this.taskRecords.update(tasks => tasks.map(item => item.id === taskId ? task : item));
    if (task.state === 'finished') { this.error.set('This task has been closed. Select another task to continue.'); return; }
    if (task.state === 'failed') { this.error.set(task.setupIssue?.message ?? 'The task workspace could not be prepared. Check the task before creating another.'); return; }
    if (task.state === 'ready') {
      const sessions = await this.read(scope, () => this.bridge.workspaceSessions(scope, { taskId, limit: 20, order: 'latest' }));
      if (!current()) return;
      if (sessions?.items[0]) {
        this.sessionRecords.update(records => new Map(records).set(taskId, sessions.items));
        this.sessionCursors.update(cursors => new Map(cursors).set(taskId, sessions.nextCursor));
        this.chosen.set({ scopeId: scope, taskId, sessionId: sessions.items[0].id }); this.pendingTask.set(null); return;
      }
    }
    if (Date.now() - started > 5 * 60_000) { this.preparationPaused.set(true); this.error.set('The task is still preparing. Refresh to check its state.'); return; }
    this.preparationTimer = setTimeout(() => { this.preparationTimer = undefined; void this.prepareTask(scope, taskId, revision, started, attempt + 1); }, Math.min(400 * 2 ** Math.min(attempt, 4), 5000));
  }
  private stopPreparation(): void { this.preparationRevision++; clearTimeout(this.preparationTimer); this.preparationTimer = undefined; this.pendingTask.set(null); this.preparationPaused.set(false); }
  private async read<T>(scope: string, operation: () => Promise<BackendResult<T>>, accept: () => boolean = () => true): Promise<T | null> {
    if (!this.valid(scope) || !accept()) return null;
    try {
      const result = await operation();
      if (!this.valid(scope) || !accept()) return null;
      if (result.ok) return result.value;
      this.error.set(result.error.message);
    } catch { if (this.valid(scope) && accept()) this.error.set('The backend could not be reached. Refresh to reconnect.'); }
    return null;
  }
  private async mutate<T>(scope: string, operation: () => Promise<BackendResult<T>>): Promise<T | null> {
    if (!this.valid(scope) || !this.capable || this.mutationUncertain()) return null;
    this.error.set(null);
    try {
      const result = await operation();
      if (!this.valid(scope)) return null;
      if (result.ok) return result.value;
      if (result.error.code === 'outcome-unknown' || result.error.code === 'transport' || result.error.code === 'timeout') {
        this.mutationUncertain.set(true); this.error.set('The change could not be confirmed. Refresh to check its outcome before trying again.');
      } else this.error.set(result.error.message);
    } catch { if (this.valid(scope)) { this.mutationUncertain.set(true); this.error.set('The change could not be confirmed. Refresh to check its outcome before trying again.'); } }
    return null;
  }
  private valid(scope: string): boolean { return !this.disposed && this.scopeId() === scope && this.backend.state().scope?.id === scope; }
  private current(scope: string, revision: number): boolean { return this.valid(scope) && this.revision === revision; }
  private reset(scope: string | null): void {
    this.resume.reset(); this.resumeLoaded = false; this.resumeContext = null; this.restoring.set(scope !== null);
    this.panelOpen.set(false); this.panel.set('changes'); this.wideReview.set(false); this.closed.set(false); this.filter.set(null);
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(null);
    this.sessionDisclosures.set(new Map());
    this.capable = false; this.archives.reset(); this.sessionArchiveHistoryAvailable.set(false); this.commitPanelAvailable.set(false); this.sessionArchiveAvailable.set(false); this.sessionArchiveUndo.set(null); this.closeUndo.set(null);
    this.observer?.dispose(); this.observer = undefined; this.projectPage.set(false); this.currentTaskCursor = undefined; this.currentProjectCursor = undefined;
    this.stopPreparation();
    this.archiveUndo.set(null);
    this.mutationUncertain.set(false); this.uncertainSetup = null;
    clearTimeout(this.branchTimer); this.branchRevision++; this.branchLoading.set(false); this.baseBranches.set(new Map()); this.defaultBranches.set(new Map());
    this.revision++; this.listRevision++; this.scopeId.set(scope); this.projectRecords.set([]); this.taskRecords.set([]); this.sessionRecords.set(new Map()); this.sessionCursors.set(new Map()); this.detail.set(null); this.chosen.set(null); this.activeProject.set('all'); this.focused.set(false); this.dialogOpen.set(false); this.busy.set(false); this.error.set(null); this.loading.set(false); this.branches.set(new Map()); this.projectsCursor.set(null); this.tasksCursor.set(null); this.taskPage.set(false);
  }
}

function branchView(branch: WorkspaceBranch): BranchInfo { return { name: branch.name, isDefault: branch.isDefault, ...(branch.heldTaskName ? { task: branch.heldTaskName } : {}) }; }
