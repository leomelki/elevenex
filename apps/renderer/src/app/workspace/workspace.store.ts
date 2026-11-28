import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { WorkspaceSessionCreation } from './workspace-session-creation';
import { WorkspaceSessionOutbox } from './workspace-session-outbox';
import { WorkspaceWritingJournal } from './workspace-writing-journal';
import { WorkspaceTaskOutbox, type WaitingTask } from './workspace-task-outbox';
import { SessionChatDrafts, SessionDraft } from '../session-chat/session-chat-drafts';
import { SessionChatOutbox } from '../session-chat/session-chat-outbox';
import { DOCUMENT } from '@angular/common';
import { isWorkspacePriorityStatus } from '@elevenex/shared';
import type { BackendResult, EnvironmentContext, EnvironmentSelection, WorkspacePage, WorkspaceViewState, WorkspaceCreateProject, WorkspaceBranch, WorkspaceProject, WorkspaceProjectDetail, WorkspaceRepository, WorkspaceRevision, WorkspaceSession, WorkspaceTask, WorkspaceTaskRecovery } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import type { Machine } from '../machines';
import type { ConversationMention } from '../conversation';
import type { SessionAgentReference } from '@elevenex/shared';
import { projectFace, type CreateProjectIntent, type FolderProvider, type ProjectNameProvider, type ProjectAppearance } from '../projects';
import { branchFromTitle, type BranchInfo, type CreatedTask, type PlannedTask, type Project, type StatusCounts, type SummaryStatus, type TaskBranchSearch, type TaskOutline, type TaskSession, type TaskSessionDisclosure, type TaskSessionHistoryRequest, type TaskRepository, type TaskStage } from '../tasks';
import { workspaceAgentRow, workspaceSessionStatus, workspaceTaskStage, type WorkspaceSelection } from './workspace.models';
import { workspaceTaskSignal } from './workspace-task-progress';
import { mergeNavigationSessions, readPrioritySessions, type WorkspacePrioritySessions } from './workspace-priority-sessions';
import { WorkspaceSessionHierarchy } from './workspace-session-hierarchy';
import { WorkspaceSessionArchives } from './workspace-session-archives';
import { WorkspaceNavigationObserver } from './workspace-navigation-observer';
import { WorkspaceAppReveal } from './workspace-app-reveal';
import { WorkspaceResume } from './workspace-resume';
import { WorkspaceRestoration, projectWindowCursor, type RestoredTaskWindow } from './workspace-restoration';

interface SessionRemovalIntent {
  readonly taskId: string;
  readonly session: Pick<TaskSession, 'id' | 'status' | 'activeChildAgents' | 'childStopRequired'>;
}

const rememberedAppsPanelLimit = 16;

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
  private readonly priorityRecords = signal<ReadonlyMap<number, WorkspacePrioritySessions>>(new Map());
  private readonly navigationSessions = computed(() => {
    const records = this.sessionRecords();
    const priority = this.closed() ? null : this.priorityRecords();
    const children = this.hierarchy.windows();
    return new Map([...records].map(([taskId, sessions]) => [taskId,
      mergeNavigationSessions(sessions, priority?.get(taskId), parentId => children.get(parentId)?.sessions ?? []),
    ]));
  });
  // Only explicitly expanded tasks extend the normal 20-row refresh.
  private readonly sessionHistoryDepth = new Map<number, number>();
  private navigationRefresh?: Promise<void>;
  private readonly loadingOlderSessions = signal<number | null>(null);
  private readonly sessionCursors = signal<ReadonlyMap<number, string | null>>(new Map());
  private readonly detail = signal<WorkspaceProjectDetail | null>(null);
  private readonly chosen = signal<WorkspaceSelection | null>(null);
  private linkedSessionRequest = 0;
  private readonly resume = new WorkspaceResume(this.bridge);
  private readonly restoration = new WorkspaceRestoration(this.bridge);
  readonly resumeError = this.resume.error.asReadonly();
  readonly restoring = signal(false);
  readonly panelOpen = signal(false);
  private readonly workspacePanel = signal<Exclude<WorkspaceViewState['panel'], 'apps'>>('changes');
  private readonly appsPanels = signal<readonly number[]>([]);
  readonly panel = computed<WorkspaceViewState['panel']>(() => {
    const taskId = this.taskSelection()?.taskId;
    return taskId && this.appsPanels().includes(taskId) ? 'apps' : this.workspacePanel();
  });
  readonly wideReview = signal(false);
  private resumeContext: EnvironmentContext | null = null;
  private resumeLoaded = false;
  private resumeNavigationCancelled = false;
  readonly taskRequestsAvailable = signal(false);
  readonly commitPanelAvailable = signal(false);
  readonly projectImagesAvailable = signal(false);
  private readonly chatStreamScope = signal<string | null>(null);
  readonly chatStreamAvailable = computed(() => !!this.chosen() && this.chosen()?.scopeId === this.chatStreamScope());
  readonly hierarchy = new WorkspaceSessionHierarchy();
  readonly taskAppsAvailable = signal(false);
  readonly appLink = signal<(WorkspaceSelection & { readonly runId: string }) | null>(null);
  private showingWorkspace = false;
  private readonly appReveal = new WorkspaceAppReveal(this.document, () =>
    this.showingWorkspace && !this.offline() && !this.selectedCreation() && !this.dialogOpen() ? this.selected() : null,
    target => this.openApp(target), () => { if (this.taskAppsAvailable()) this.observer?.restartWait(); });
  private readonly sessionPriorityAvailable = signal(false);
  readonly sessionNestingAvailable = signal(false);
  private readonly sessionNestingOrderAvailable = signal(false);
  readonly sessionArchiveAvailable = signal(false);
  private readonly sessionArchiveChildrenAvailable = signal(false);
  readonly sessionArchiveHistoryAvailable = signal(false);
  private readonly archives = new WorkspaceSessionArchives(this.bridge, scope => this.valid(scope));
  readonly sessionDisclosures = signal<ReadonlyMap<string, TaskSessionDisclosure>>(new Map());
  readonly sessionArchiveUndo = signal<{ readonly scopeId: string; readonly session: WorkspaceSession; readonly group?: boolean } | null>(null);
  readonly scopeId = signal<string | null>(null);
  readonly offline = computed(() => !!this.scopeId() && (this.backend.state().scope?.id !== this.scopeId() || this.restoring() && !!this.chosen() && this.chosen()?.scopeId !== this.scopeId()));
  readonly asOf = signal<number | null>(null);
  readonly asOfLabel = computed(() => { const at = this.asOf(); return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; });
  private readonly journal = inject(WorkspaceWritingJournal, { optional: true });
  private readonly taskOutbox = new WorkspaceTaskOutbox(this.bridge, scope => this.valid(scope), () => this.busy() ? Promise.resolve() : this.loadTasks(this.currentTaskCursor), this.journal);
  readonly waitingTasks = this.taskOutbox.items;
  private readonly sessionOutbox = new WorkspaceSessionOutbox(this.bridge, scope => this.valid(scope), () => this.busy() ? Promise.resolve() : this.loadTasks(this.currentTaskCursor), this.journal);
  readonly waitingSessions = this.sessionOutbox.items;
  removeWaitingSession(id: string): void { this.sessionOutbox.remove(id); }
  readonly editingTask = signal<CreatedTask | null>(null);
  private uncertainTaskRequest: string | null = null;
  private machineIdentity = '';
  private inFlightMutations = 0;
  private editingWaitingTask: WaitingTask | null = null;
  private outageTasks: readonly WorkspaceTask[] | null = null;
  private suspended = false;
  private readonly drafts = inject(SessionChatDrafts, { optional: true });
  private readonly outbox = inject(SessionChatOutbox, { optional: true });
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
  readonly branchSearchFailed = signal(false);
  readonly draftTaskRepository = signal<string | undefined>(undefined);
  private readonly defaultBranches = signal<ReadonlyMap<string, string>>(new Map());
  readonly machine = this.machineState.asReadonly();
  readonly selected = this.chosen.asReadonly();
  private readonly localSessionId = signal<string | null>(null);
  private readonly sessionRenderIds = signal<ReadonlyMap<number, string>>(new Map());
  private readonly sessionCreation = new WorkspaceSessionCreation(this.bridge, scope => this.valid(scope), (starting, session) => {
    this.drafts?.adopt({ scopeId: starting.scopeId, taskId: starting.taskId, sessionId: session.id }, starting.draft);
    this.sessionRenderIds.update(ids => new Map([...ids, [session.id, starting.id] as const].slice(-400)));
    if (!this.taskRecords().some(task => task.id === starting.taskId)) return;
    this.sessionRecords.update(records => new Map(records).set(session.taskId, [...(records.get(session.taskId) ?? []).filter(row => row.id !== session.id).slice(-19), session]));
    // Completing a background creation must never take selection back from navigation.
    if (this.selectedCreation()?.id === starting.id) {
      this.chosen.set({ scopeId: starting.scopeId, taskId: session.taskId, sessionId: session.id });
      this.localSessionId.set(null);
    }
  }, taskId => this.drafts?.start(taskId) ?? new SessionDraft());
  readonly selectedCreation = computed(() => this.sessionCreation.items().find(item => item.id === this.localSessionId() && !this.closed() && this.taskRecords().some(task => task.id === item.taskId)) ?? null);
  readonly selectedCreationKey = computed(() => this.selectedCreation()?.id ?? this.sessionRenderIds().get(this.chosen()?.sessionId ?? 0) ?? null);
  readonly selectedSessionId = computed(() => this.selectedCreation()?.id ?? this.chosen()?.sessionId.toString() ?? null);
  readonly chatOpen = computed(() => !!this.selectedCreation() || !!this.chosen());
  readonly taskSelection = computed(() => {
    const target = this.selectedCreation() ?? this.chosen();
    return target ? { scopeId: target.scopeId, taskId: target.taskId } : null;
  }, { equal: (a, b) => a?.scopeId === b?.scopeId && a?.taskId === b?.taskId });
  readonly projects = computed<readonly Project[]>(() => {
    const activity = new Map<number, { attention: number; running: number }>();
    for (const task of this.taskRecords()) {
      if (workspaceTaskStage(task) === 'closed') continue;
      const counts = activity.get(task.projectId) ?? { attention: 0, running: 0 };
      for (const session of this.navigationSessions().get(task.id) ?? []) {
        const status = workspaceSessionStatus(session);
        if (status === 'attention' || status === 'failed') counts.attention++;
        if (status === 'running') counts.running++;
      }
      activity.set(task.projectId, counts);
    }
    return this.projectRecords().map(project => ({ id: String(project.id), ...projectFace({ name: project.name, ...project.appearance }), ...activity.get(project.id), muted: this.focused() && this.activeProject() !== String(project.id) }));
  });
  readonly selectedProject = computed(() => this.projectRecords().find(project => String(project.id) === this.activeProject()) ?? null);
  readonly selectedTask = computed(() => this.taskRecords().find(task => task.id === (this.selectedCreation()?.taskId ?? this.chosen()?.taskId)) ?? null);
  readonly selectedTaskStage = computed(() => { const task = this.selectedTask(); return task ? workspaceTaskStage(task) : 'active'; });
  readonly selectedSession = computed(() => {
    const selection = this.chosen();
    return selection ? this.navigationSessions().get(selection.taskId)?.find(session => session.id === selection.sessionId) ?? this.archives.pages().get(selection.taskId)?.sessions.find(session => session.id === selection.sessionId) ?? null : null;
  });
  readonly repositories = computed<readonly WorkspaceRepository[]>(() => this.detail()?.repositories.items ?? []);
  readonly taskRepositories = computed<readonly TaskRepository[]>(() => this.repositories().map(repo => ({ id: String(repo.id), name: repo.name, path: repo.path, base: this.defaultBranches().get(String(repo.id)) ?? repo.defaultBase ?? undefined })));
  readonly tasks = computed<readonly TaskOutline[]>(() => this.taskRecords().map(task => ({
    id: String(task.id), title: task.name, stage: workspaceTaskStage(task),
    temporary: task.temporary,
    ...(this.closed() ? {} : { workspace: workspaceTaskSignal(task) ?? undefined }),
    ...(this.sessionArchiveHistoryAvailable() && !this.closed() && task.state === 'ready' && this.hasArchivedSessions(task.id) ? { archive: {
      sessions: (this.archives.pages().get(task.id)?.sessions ?? []).map(session => ({ ...workspaceAgentRow(session), id: String(session.id), canDelete: session.canDelete, mentionScope: this.scopeId() ?? undefined, title: session.name, status: workspaceSessionStatus(session) })),
      loaded: this.archives.pages().get(task.id)?.loaded ?? false,
      loading: this.archives.pages().get(task.id)?.loading ?? false,
      error: this.archives.pages().get(task.id)?.error ?? null,
      more: !!this.archives.pages().get(task.id)?.nextCursor,
      earlier: !!this.archives.pages().get(task.id)?.cursor,
    } } : {}),
    moreSessions: !!this.sessionCursors().get(task.id),
    loadingOlderSessions: this.loadingOlderSessions() === task.id,
    canAddSession: task.state === 'ready',
    project: this.projects().find(project => project.id === String(task.projectId)) ?? (task.projectName ? projectFace({ name: task.projectName }) : undefined),
    // Unknown cardinality from older runtimes keeps their existing repository hint.
    ...(task.repoName && task.projectRepositoryCount !== 1 ? { repo: task.repoName } : {}),
    sessions: [
      ...(this.navigationSessions().get(task.id) ?? []).map(session => ({ ...workspaceAgentRow(session), id: String(session.id), renderId: this.sessionRenderIds().get(session.id),
        ...(this.sessionArchiveChildrenAvailable() && session.childStopRequired ? { childStopRequired: true } : {}),
        ...(this.sessionNestingAvailable() && !this.closed() ? { childrenAppendOrder: this.sessionNestingOrderAvailable(), parentId: session.parentSessionId == null ? null : String(session.parentSessionId), childCount: session.childCount ?? 0,
          childrenLoading: this.hierarchy.windows().get(session.id)?.loading ?? false,
          childrenError: this.hierarchy.windows().get(session.id)?.error ?? null,
          earlierChildren: !!this.hierarchy.windows().get(session.id)?.cursor, moreChildren: !!this.hierarchy.windows().get(session.id)?.nextCursor } : {}), canDelete: session.canDelete, mentionScope: this.scopeId() ?? undefined, title: session.name, status: workspaceSessionStatus(session), ...(session.commandCount ? { commands: session.commandCount } : {}) })),
      ...this.sessionCreation.items().filter(item => item.taskId === task.id).map(item => ({ id: item.id, renderId: item.id, title: 'New session', status: 'queued' as const, local: true, fresh: true, meta: item.status === 'creating' ? 'Creating…' : item.status === 'unknown' ? 'Check creation' : 'Try again' })),
    ],
  })));
  /** Only loaded navigation windows participate; mentioning never scans the repository. */
  readonly sessionMentionItems = computed<readonly ConversationMention[]>(() => this.tasks()
    .flatMap(task => [...task.sessions, ...(task.archive?.sessions ?? [])].filter(session => !session.local).map(session => ({
      id: session.id, kind: 'session' as const, label: session.title, status: session.status, meta: task.title,
    }))).slice(0, 50));
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
  private taskRequestId: string = crypto.randomUUID();
  private observer?: WorkspaceNavigationObserver;
  private capable = false;
  private projectCompletion: { readonly scope: string; readonly projectId: number } | null = null;

  constructor() {
    effect(() => {
      this.selected(); this.selectedCreation(); this.dialogOpen();
      if (this.taskAppsAvailable()) untracked(() => { this.appReveal.reset(); this.observer?.restartWait(); });
    });
    const stopBrowserReveal = this.bridge.onTaskBrowserRevealTask?.(target => { if (this.scopeId() === target.scopeId && !this.offline()) void this.revealBrowserTask(target.taskId); });
    inject(DestroyRef).onDestroy(() => stopBrowserReveal?.());
    effect(() => { const saved = this.journal?.restored(); if (saved) untracked(() => { this.taskOutbox.restore(saved.tasks); this.sessionOutbox.restore(saved.sessions ?? []); }); });
    effect(() => {
      const scope = this.backend.state().scope;
      const machine = this.machineState();
      const matches = machine && scope && (machine.kind === 'local' ? scope.environment.kind === 'local' : scope.environment.kind === 'remote' && scope.environment.hostId === machine.id);
      const next = this.enabled() && matches ? scope.id : null;
      untracked(() => {
        if (next === this.scopeId() && !this.suspended) return;
        if (!next && this.scopeId() && (!scope || !this.enabled())) {
          this.suspend(); return;
        }
        if (next && this.suspended) this.recover(next);
        else this.reset(next);
        if (next) {
          this.loading.set(true);
          this.observer = new WorkspaceNavigationObserver(this.document, async () => {
            const result = await this.bridge.workspaceRevision(next);
            if (result.ok) this.applyCapabilities(next, result.value);
            return result;
          }, () => this.valid(next) && !this.loading() && !this.busy() && !this.pendingTask() && !this.sessionCreation.items().some(item => item.status === 'creating'), () => { this.capable = true; return this.refreshVisible(); }, message => { if (this.valid(next)) { this.loading.set(false); this.error.set(message); } }, { wait: (after, requestId) => {
            const wait = () => this.bridge.workspaceWait(next, { after, requestId });
            return this.taskAppsAvailable() ? this.appReveal.wait(next, after, () => this.bridge.workspaceRevision(next), wait) : wait();
          }, cancel: requestId => this.bridge.workspaceCancelWait(next, requestId) });
        }
      });
    });
    effect(() => {
      const scope = this.scopeId(), environment = this.backend.state().scope?.environment;
      if (!scope || !environment || this.restoring() || this.loading() || this.busy()) return;
      this.saveView(scope, environment);
    });
    inject(DestroyRef).onDestroy(() => { this.appReveal.dispose(); this.saveBeforeExit(); this.taskOutbox.dispose(); this.sessionOutbox.dispose(); this.sessionCreation.dispose(); this.disposed = true; this.archives.reset(); this.revision++; this.listRevision++; this.stopPreparation(); this.stopBranchSearch(); this.observer?.dispose(); });
  }

  private suspend(): void {
    if (this.suspended) return;
    this.suspended = true; this.asOf.set(Date.now()); this.outageTasks = this.taskRecords();
    this.outbox?.connect(null); this.taskOutbox.connect(null); this.sessionOutbox.connect(null);
    this.closeUndo.set(null); this.archiveUndo.set(null); this.sessionArchiveUndo.set(null);
    this.revision++; this.listRevision++; this.preparationRevision++;
    clearTimeout(this.preparationTimer); this.stopBranchSearch();
    this.observer?.dispose(); this.observer = undefined;
    if (this.inFlightMutations) { this.mutationUncertain.set(true); this.error.set('The last change is unconfirmed. Check its outcome when the machine is back.'); }
    this.busy.set(false); this.loading.set(false);
  }
  private recover(scope: string): void {
    const previous = this.scopeId()!;
    const selection = this.chosen(), pending = this.pendingTask();
    this.resumeContext = { projectId: this.activeProject() === 'all' ? null : Number(this.activeProject()), taskId: selection?.taskId ?? pending?.id ?? null,
      sessionId: selection?.sessionId ?? null, draft: '', cursor: null, workspace: { panel: this.panel(), panelOpen: this.panelOpen(), wideReview: this.wideReview(), closed: this.closed(), focused: this.focused(), filter: this.filter(), projectCursor: this.currentProjectCursor ?? null, taskCursor: this.currentTaskCursor ?? null } };
    this.suspended = false; this.capable = false; this.archives.reset();
    this.resume.reset(); this.resumeLoaded = true; this.restoring.set(true);
    this.drafts?.rebind(previous, scope);
    this.sessionCreation.rebind(previous, scope);
    this.scopeId.set(scope);
  }

  connect(machine: Machine, active: boolean, showingWorkspace = active): void {
    if (this.showingWorkspace !== showingWorkspace) this.appReveal.reset();
    this.showingWorkspace = showingWorkspace;
    if (!active || this.machineState()?.id !== machine.id) this.saveBeforeExit();
    const identity = JSON.stringify([machine.id, machine.address, machine.key]);
    if (this.machineIdentity && this.machineIdentity !== identity) { this.reset(null); this.outbox?.clear(); this.taskOutbox.clear(); this.sessionOutbox.clear(); }
    if (this.machineIdentity !== identity) {
      const environment: EnvironmentSelection = machine.kind === 'local' ? { kind: 'local' } : { kind: 'remote', hostId: machine.id };
      this.drafts?.selectMachine(environment);
      void this.journal?.open(environment);
    }
    this.machineIdentity = identity;
    this.machineState.set(machine); this.enabled.set(active);
  }

  private saveBeforeExit(): void {
    const scope = this.scopeId(), environment = this.backend.state().scope?.environment;
    if (scope && environment && !this.restoring() && !this.loading()) {
      untracked(() => { this.saveView(scope, environment); this.resume.flushBeforeExit(); });
    }
  }

  openApp(link: WorkspaceSelection & { readonly runId: string }): void {
    const selected = this.selected();
    if (!this.valid(link.scopeId) || this.offline() || selected?.scopeId !== link.scopeId ||
      selected.taskId !== link.taskId || selected.sessionId !== link.sessionId) return;
    this.appLink.set(link);
    this.selectPanel('apps');
    this.panelOpen.set(true);
  }
  selectPanel(panel: string): void {
    if (panel === 'terminal' || panel === 'actions' || panel === 'changes' || panel === 'code' || panel === 'browser' || panel === 'apps') {
      this.setPanel(panel, this.taskSelection()?.taskId);
    }
  }

  private setPanel(panel: WorkspaceViewState['panel'], taskId?: number): void {
    if (taskId) {
      if (panel === 'apps') this.appsPanels.update(tasks => [...tasks.filter(id => id !== taskId).slice(1 - rememberedAppsPanelLimit), taskId]);
      else if (this.appsPanels().includes(taskId)) this.appsPanels.update(tasks => tasks.filter(id => id !== taskId));
    }
    if (panel !== 'apps') this.workspacePanel.set(panel);
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
      if (context && !this.resumeNavigationCancelled) {
        this.resumeContext = context; this.restoring.set(true); this.applyView(context);
      }
    }
    if (!this.capable) {
      const capability = await this.read(scope, () => this.bridge.workspaceRevision(scope));
      this.applyCapabilities(scope, capability);
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
      else {
        // A failed settings read can be retried until the user navigates.
        this.leaveResume(false);
        await this.loadTaskWindow(undefined, false);
      }
      if (this.current(scope, revision) && !this.error()) { this.resumeContext = null; this.restoring.set(false); this.asOf.set(null); this.outbox?.connect(scope); this.taskOutbox.connect(scope); this.sessionOutbox.connect(scope); }
      if (this.current(scope, revision) && !this.error()) { this.mutationUncertain.set(false); this.uncertainSetup = null; }
    }
    if (this.current(scope, revision)) this.loading.set(false);
  }

  private applyView(context: EnvironmentContext): void {
    this.activeProject.set(context.projectId === null ? 'all' : String(context.projectId));
    const view = context.workspace;
    if (!view) return;
    this.setPanel(view.panel, context.taskId ?? undefined);
    this.panelOpen.set(view.panelOpen); this.wideReview.set(view.panelOpen && view.wideReview);
    this.focused.set(view.focused); this.filter.set(view.closed ? null : view.filter);
    this.currentProjectCursor = view.projectCursor ?? undefined;
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
      // Only navigation already visible in this store can survive a reconnect.
      view: this.closed() ? 'closed' : 'active',
    }, current), current);
    if (!restored || !current()) return;
    this.currentTaskCursor = restored.cursor;
    await this.hydrateTasks(scope, listRevision, restored.page, restored.cursor, restored);
    if (!current() || this.error()) return;
    this.chosen.set(!this.selectedCreation() && restored.selection ? { scopeId: scope, ...restored.selection } : null);
    this.pendingTask.set(restored.pendingTask ?? null);
    this.preparationPaused.set(!!restored.pendingTask);
  }

  private leaveResume(cancelSavedNavigation = true): void {
    if (cancelSavedNavigation) this.resumeNavigationCancelled = true;
    if (!this.restoring()) return;
    this.restoring.set(false); this.resumeContext = null; this.revision++;
  }

  private refreshVisible(): Promise<void> {
    const reading = this.readVisibleNavigation();
    this.navigationRefresh = reading;
    return reading.finally(() => {
      if (this.navigationRefresh === reading) this.navigationRefresh = undefined;
    });
  }

  private async readVisibleNavigation(): Promise<void> {
    if (this.restoring()) { await this.refresh(); return; }
    const scope = this.scopeId(), revision = this.revision, listRevision = this.listRevision;
    if (!scope) return;
    const current = () => this.current(scope, revision) && this.listRevision === listRevision;
    // Revalidate in place. Polling must not enter navigation's loading/error UI
    // or replace the visible page after the user has navigated elsewhere.
    const projects = await this.read(scope, () => this.bridge.workspaceProjects(scope, { limit: 50, ...(this.currentProjectCursor ? { cursor: this.currentProjectCursor } : {}) }), current, true);
    if (!projects || !current()) return;
    this.projectRecords.set(projects.items); this.projectsCursor.set(projects.nextCursor);
    if (!this.projectPage() && this.activeProject() !== 'all' && !projects.items.some(project => String(project.id) === this.activeProject())) this.activeProject.set('all');
    await this.loadTaskWindow(this.currentTaskCursor, true);
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
    this.localSessionId.set(null);
    if (this.offline() && this.outageTasks) {
      this.activeProject.set(id); this.taskRecords.set(this.outageTasks.filter(task => id === 'all' || String(task.projectId) === id));
      if (!this.taskRecords().some(task => task.id === this.chosen()?.taskId)) this.chosen.set(null);
      return;
    }
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
    this.leaveResume();
    await this.loadTaskWindow(cursor, false);
  }

  private async loadTaskWindow(cursor: string | undefined, background: boolean): Promise<void> {
    const scope = this.scopeId();
    if (!scope) return;
    const revision = ++this.listRevision;
    if (!background && cursor !== this.currentTaskCursor) this.localSessionId.set(null);
    this.currentTaskCursor = cursor;
    if (!background) { this.loading.set(true); this.error.set(null); }
    const projectId = this.activeProject() === 'all' ? null : Number(this.activeProject());
    const result = await this.read(scope, () => this.bridge.workspaceTasks(scope, { projectId, state: this.closed() ? 'finished' : 'active', limit: 20, ...(cursor ? { cursor } : {}) }), () => revision === this.listRevision, background);
    if (!result || revision !== this.listRevision || this.scopeId() !== scope) { if (!background && revision === this.listRevision) this.loading.set(false); return; }
    await this.hydrateTasks(scope, revision, result, cursor, undefined, background);
  }

  private async hydrateTasks(scope: string, revision: number, result: WorkspacePage<WorkspaceTask>, cursor?: string, restored?: RestoredTaskWindow, background = false): Promise<void> {
    // Keep the previous archived window until background hydration succeeds.
    this.archives.retain(this.closed() ? [] : [...result.items, ...(background ? this.taskRecords() : [])].map(task => task.id));
    const archive = restored?.archive;
    if (archive) this.archives.acceptRestoredWindow(scope, archive.taskId, archive.page, archive.cursor);
    const sessions = new Map<number, readonly WorkspaceSession[]>();
    const priority = new Map<number, WorkspacePrioritySessions>();
    const current = () => revision === this.listRevision && this.valid(scope);
    const cursors = new Map<number, string | null>();
    const missingSessionIds = new Set<number>();
    // Four workers bound both transport concurrency and first-paint memory.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, result.items.length) }, async () => {
      while (index < result.items.length && revision === this.listRevision && this.scopeId() === scope) {
        const task = result.items[index++];
        if (!task) continue;
        const page = restored?.sessions?.taskId === task.id ? restored.sessions.page
          : await this.readSessionHistory(scope, task.id, current, background);
        if (!current()) return;
        if (!page && this.sessionPriorityAvailable() && !this.closed()) {
          const retained = this.priorityRecords().get(task.id);
          if (retained) {
            priority.set(task.id, retained);
            sessions.set(task.id, this.sessionRecords().get(task.id) ?? []);
            cursors.set(task.id, this.sessionCursors().get(task.id) ?? null);
          }
        }
        if (page) {
          if (this.sessionPriorityAvailable() && !this.closed() && task.state === 'ready') {
            const snapshot = await readPrioritySessions(
              cursor => this.read(scope, () => this.bridge.workspaceSessions(scope, {
                taskId: task.id, state: 'priority', limit: 100, ...(cursor ? { cursor } : {}),
              }), current, background),
              current,
            );
            if (!current()) return;
            const retained = snapshot ?? this.priorityRecords().get(task.id);
            if (retained) priority.set(task.id, retained);
          }
          let rows = page.items;
          const pinned = this.selectedSession();
          // An older selected conversation can be pinned outside the latest
          // window. Revalidate that one ID, rather than retaining its old status
          // or scanning every intervening page.
          if ((background || this.sessionPriorityAvailable() || task.setupIssue?.closeFailed) &&
            pinned?.taskId === task.id && pinned.status !== 'archived' &&
            !rows.some(row => row.id === pinned.id) && !priority.get(task.id)?.items.some(row => row.id === pinned.id)) {
            const focused = await this.read(scope, () => this.bridge.workspaceSessions(scope, {
              taskId: task.id, ...(pinned.id > 1 ? { cursor: String(pinned.id - 1) } : {}), limit: 1,
            }), current, background);
            const updated = focused?.items.find(row => row.id === pinned.id);
            if (updated) rows = [...rows, updated].sort((a, b) => a.id - b.id);
            else if (focused) missingSessionIds.add(pinned.id);
          }
          const selectedId = restored?.selection?.taskId === task.id ? restored.selection.sessionId : pinned?.taskId === task.id ? pinned.id : undefined;
          const selectedChild = rows.find(row => row.id === selectedId);
          if (this.sessionNestingAvailable() && !this.closed() && selectedChild?.parentSessionId && !rows.some(row => row.id === selectedChild.parentSessionId)) {
            // Restored and live pinned children need their parent in the bounded root window.
            const parentId = selectedChild.parentSessionId;
            const context = await this.read(scope, () => this.bridge.workspaceSessions(scope, { taskId: task.id, ...(parentId > 1 ? { cursor: String(parentId - 1) } : {}), limit: 1, state: 'normal' }), () => revision === this.listRevision, background);
            const parent = context?.items.find(row => row.id === parentId);
            if (parent) rows = [...rows, parent].sort((a, b) => a.id - b.id);
          }
          if (revision !== this.listRevision || this.scopeId() !== scope) return;
          sessions.set(task.id, rows); cursors.set(task.id, page.nextCursor);
          // Live indicators must not wait for other tasks or archived history.
          // Preserve a pinned selection outside the latest page until final reconciliation.
          if (background) {
            const selected = this.selectedSession();
            this.priorityRecords.update(records => {
              const next = new Map(records);
              const snapshot = priority.get(task.id);
              if (snapshot) next.set(task.id, snapshot);
              else next.delete(task.id);
              return next;
            });
            this.sessionRecords.update(records => new Map(records).set(task.id,
              selected && selected.taskId === task.id && !missingSessionIds.has(selected.id) && !rows.some(item => item.id === selected.id) &&
                !priority.get(task.id)?.items.some(item => item.id === selected.id)
                ? [...rows, selected] : rows,
            ));
          }
        }
        if (revision === this.listRevision && this.sessionArchiveHistoryAvailable() && !this.closed() && task.state === 'ready' && archive?.taskId !== task.id) {
          const archived = this.archives.refresh(scope, task.id);
          // Archives own coalescing, stale replies and errors. Their latency
          // must not delay live status reconciliation or the next revision wait.
          if (background) void archived.catch(() => undefined);
          else await archived;
        }
      }
    }));
    if (revision !== this.listRevision || this.scopeId() !== scope) return;
    this.archives.retain(this.closed() ? [] : result.items.map(task => task.id));
    const recoveringClose = this.pendingTask();
    if (recoveringClose?.setupIssue?.closeFailed) {
      this.pendingTask.set(result.items.find(task => task.id === recoveringClose.id && task.setupIssue?.closeFailed) ?? null);
    }
    const previous = this.selectedSession(), selection = this.chosen();
    for (const id of missingSessionIds) this.hierarchy.removeSession(id);
    if (selection && missingSessionIds.has(selection.sessionId)) {
      this.chosen.set(null);
      const task = result.items.find(row => row.id === selection.taskId);
      if (task?.setupIssue?.closeFailed) this.pendingTask.set(task);
    } else if (previous && previous.status !== 'archived' && selection && sessions.has(selection.taskId) && !sessions.get(selection.taskId)?.some(session => session.id === previous.id) && !priority.get(selection.taskId)?.items.some(session => session.id === previous.id)) {
      const roots = sessions.get(selection.taskId) ?? [];
      const parent = previous.parentSessionId ? this.navigationSessions().get(selection.taskId)?.find(row => row.id === previous.parentSessionId) : undefined;
      // A retained selection supplements the history page. Evicting a history
      // row would hide it on both sides of the backend cursor.
      const missingParent = parent && !roots.some(row => row.id === parent.id) && !priority.get(selection.taskId)?.parents.some(row => row.id === parent.id);
      sessions.set(selection.taskId, [...roots, ...(missingParent ? [parent] : []), previous].sort((a, b) => a.id - b.id));
    }
    this.priorityRecords.set(priority);
    this.hierarchy.retain([...sessions.values()].flat().concat(
      [...priority.values()].flatMap(({ items, parents }) => [...items, ...parents]),
    ));
    this.taskRecords.set(result.items); this.sessionRecords.set(sessions); this.sessionCursors.set(cursors); this.tasksCursor.set(result.nextCursor); this.taskPage.set(!!cursor);
    for (const [parentId, window] of this.hierarchy.windows()) {
      void this.readChildWindow(window.taskId, parentId, 'refresh');
    }
    if (this.chosen() && !result.items.some(task => task.id === this.chosen()?.taskId)) this.chosen.set(null);
    if (!background && !this.restoring()) this.loading.set(false);
  }

  async revealBrowserTask(taskId: number): Promise<void> {
    const scope = this.scopeId(); if (!scope || this.offline()) return;
    if (this.selectedTask()?.id !== taskId) {
      this.leaveResume(); this.stopPreparation(); this.activeProject.set('all'); this.closed.set(false); this.filter.set(null);
      const navigation = this.listRevision + 1, selection = this.chosen();
      await this.loadTasks(taskId < Number.MAX_SAFE_INTEGER ? String(taskId + 1) : undefined);
      if (!this.valid(scope) || this.listRevision !== navigation || this.chosen() !== selection && this.chosen() !== null) return;
      const session = this.sessionRecords().get(taskId)?.[0];
      if (!session) return;
      this.selectSession({ taskId: String(taskId), sessionId: String(session.id) });
    }
    this.selectPanel('browser'); this.panelOpen.set(true);
  }

  selectSession(selection: { readonly taskId: string; readonly sessionId: string }): void {
    const local = this.sessionCreation.items().find(item => item.id === selection.sessionId && String(item.taskId) === selection.taskId);
    if (local && this.taskRecords().some(task => task.id === local.taskId)) {
      this.leaveResume(); this.stopPreparation(); this.chosen.set(null); this.localSessionId.set(local.id); return;
    }
    const scopeId = this.scopeId(), taskId = Number(selection.taskId), sessionId = Number(selection.sessionId);
    if (!scopeId || !this.taskRecords().some(task => task.id === taskId) || !this.navigationSessions().get(taskId)?.some(session => session.id === sessionId) && !this.archives.pages().get(taskId)?.sessions.some(session => session.id === sessionId)) return;
    this.leaveResume();
    this.stopPreparation();
    this.localSessionId.set(null);
    this.chosen.set({ scopeId, taskId, sessionId });
  }

  /** A chat link may point outside the loaded outline. Resolve its exact scoped row first. */
  async openLinkedSession(source: WorkspaceSelection, target: SessionAgentReference): Promise<WorkspaceSelection | null> {
    const { scopeId } = source;
    const taskId = target.taskId ?? source.taskId, sessionId = target.sessionId;
    if (!this.valid(scopeId) || this.offline() || this.chosen() !== source) return null;
    if (taskId === source.taskId && sessionId === source.sessionId) return source;

    const request = ++this.linkedSessionRequest;
    const project = this.activeProject(), closed = this.closed();
    const current = () => this.valid(scopeId) && this.chosen() === source && project === this.activeProject() &&
      closed === this.closed() && request === this.linkedSessionRequest;
    const task = this.taskRecords().find(row => row.id === taskId);
    if (!task) {
      const result = await this.restoration.tasks(scopeId, {
        saved: { taskId, sessionId, projectId: null, cursor: null, draft: '' },
        projectId: null, archiveHistory: this.sessionArchiveHistoryAvailable(), view: 'linked',
      }, current);
      if (!current()) return null;
      if (!result.ok || !result.value.selection) {
        this.error.set(result.ok ? 'This session is no longer available.' : result.error.message);
        return null;
      }
      const window = result.value;
      this.leaveResume(); this.stopPreparation();
      this.activeProject.set('all'); this.filter.set(null); this.closed.set(window.closed);
      this.currentTaskCursor = window.cursor;
      const revision = ++this.listRevision;
      await this.hydrateTasks(scopeId, revision, window.page, window.cursor, window);
      if (!this.valid(scopeId) || request !== this.linkedSessionRequest || revision !== this.listRevision ||
          (this.chosen() !== source && this.chosen() !== null)) return null;
    } else if (!this.navigationSessions().get(taskId)?.some(row => row.id === sessionId) &&
        !this.archives.pages().get(taskId)?.sessions.some(row => row.id === sessionId)) {
      const exact = async (id: number, state?: 'normal' | 'archived') => this.read(scopeId, () =>
        this.bridge.workspaceSessions(scopeId, { taskId, limit: 1, ...(id > 1 ? { cursor: String(id - 1) } : {}), state }), current);
      const normal = await exact(sessionId);
      if (!normal || !current()) return null;
      let row = normal.items.find(item => item.id === sessionId);
      if (!row && this.sessionArchiveHistoryAvailable()) {
        const archive = await exact(sessionId, 'archived');
        if (!archive || !current()) return null;
        row = archive.items.find(item => item.id === sessionId);
        if (row) this.archives.acceptRestoredWindow(scopeId, taskId, archive, sessionId > 1 ? String(sessionId - 1) : undefined);
      }
      if (!row) { this.error.set('This session is no longer available.'); return null; }
      if (row.status !== 'archived' || closed) {
        const parentId = row.parentSessionId;
        const parent = parentId && !closed && !this.navigationSessions().get(taskId)?.some(item => item.id === parentId)
          ? (await exact(parentId, 'normal'))?.items.find(item => item.id === parentId) : undefined;
        if (!current()) return null;
        this.sessionRecords.update(records => {
          const loaded = (records.get(taskId) ?? []).filter(item => item.id !== sessionId && item.id !== parent?.id);
          const pinned = [...(parent ? [parent] : []), row];
          return new Map(records).set(taskId, [...loaded.slice(-(20 - pinned.length)), ...pinned].sort((a, b) => a.id - b.id));
        });
      }
    }
    this.selectSession({ taskId: String(taskId), sessionId: String(sessionId) });
    const selected = this.chosen();
    if (selected?.sessionId !== sessionId || selected.taskId !== taskId || selected.scopeId !== scopeId) return null;
    const parentId = this.selectedSession()?.parentSessionId;
    if (parentId && !this.closed() && this.sessionNestingAvailable())
      void this.loadSessionChildren({ taskId: String(taskId), sessionId: String(parentId) });
    return selected;
  }
  openEmptyTask(id: string): void {
    const task = this.taskRecords().find(task => String(task.id) === id), scope = this.scopeId();
    if (!task || !scope || this.busy()) return;
    this.leaveResume();
    if (task.state === 'ready') { void this.createSession(id); return; }
    this.stopPreparation(); this.localSessionId.set(null); this.chosen.set(null); this.pendingTask.set(task);
    if (task.state !== 'failed' && task.state !== 'released') void this.prepareTask(scope, task.id, this.preparationRevision, Date.now(), 0);
  }

  async createSession(id: string): Promise<void> {
    const scope = this.scopeId(), taskId = Number(id);
    const task = this.taskRecords().find(task => task.id === taskId);
    if (!scope || this.busy() || !task || task.state !== 'ready' || task.archivedAt) return;
    const existing = this.sessionCreation.items().find(item => item.scopeId === scope && item.taskId === taskId);
    if (existing) { this.selectSession({ taskId: id, sessionId: existing.id }); return; }
    if (this.offline()) {
      if (this.journal && !this.journal.restored()) { this.error.set('Restoring waiting writing. Try again in a moment.'); return; }
      if (!this.sessionOutbox.enqueue(taskId, task.name)) this.error.set('Up to 10 sessions can wait in this window. Remove one first.');
      return;
    }
    if (!this.valid(scope) || !this.capable || this.restoring() || this.mutationUncertain()) return;
    const starting = this.sessionCreation.start(scope, taskId);
    if (!starting) { this.error.set('Up to 10 unfinished sessions can stay open. Resolve or discard one first.'); return; }
    this.leaveResume(); this.stopPreparation(); this.filter.set(null); this.chosen.set(null); this.localSessionId.set(starting.id);
    await this.sessionCreation.send(starting.id);
  }

  async retrySessionCreation(): Promise<void> {
    const starting = this.selectedCreation();
    if (!starting || this.offline() || this.restoring() || this.busy() || this.mutationUncertain()) return;
    await this.sessionCreation.retry(starting.id);
  }
  discardSessionCreation(): void {
    const starting = this.selectedCreation();
    if (!starting || starting.status === 'creating') return;
    this.sessionCreation.discard(starting.id); this.localSessionId.set(null);
    const previous = this.navigationSessions().get(starting.taskId)?.at(-1);
    if (previous) this.chosen.set({ scopeId: starting.scopeId, taskId: starting.taskId, sessionId: previous.id });
  }

  async deleteSession(intent: SessionRemovalIntent): Promise<boolean> {
    return this.removeSession(intent, true);
  }
  async archiveSession(intent: SessionRemovalIntent): Promise<boolean> {
    return this.removeSession(intent, false);
  }
  private async removeSession(intent: SessionRemovalIntent, deleting: boolean): Promise<boolean> {
    const scope = this.scopeId(), taskId = Number(intent.taskId), sessionId = Number(intent.session.id), revision = this.listRevision;
    const session = this.navigationSessions().get(taskId)?.find(session => session.id === sessionId);
    if (!scope || !session || this.busy() || !this.sessionArchiveAvailable() || (deleting && !session.canDelete)) return false;
    const includeChildren = !deleting && this.sessionArchiveChildrenAvailable();
    const { status, activeChildAgents, childStopRequired } = intent.session;
    const confirmStop = status === 'running' || !!session.commandCount ||
      (includeChildren && (!!childStopRequired || !!activeChildAgents?.length));
    this.busy.set(true);
    const result = await this.mutate(scope, () => deleting
      ? this.bridge.workspaceDeleteSession(scope, { taskId, sessionId })
      : this.bridge.workspaceArchiveSession(scope, { taskId, sessionId, confirmStop,
        ...(includeChildren ? { includeChildren: true } : {}),
        ...(activeChildAgents?.length ? { stopAgents: activeChildAgents } : {}) }));
    if (result) {
      if (deleting) this.drafts?.entry({ scopeId: scope, taskId, sessionId }).discard();
      this.closeUndo.set(null); this.archiveUndo.set(null);
      this.sessionArchiveUndo.set(deleting ? null : { scopeId: scope, session, group: includeChildren && !!session.childCount });
      if (revision === this.listRevision) {
        const sessions = this.navigationSessions().get(taskId) ?? [], at = sessions.findIndex(session => session.id === sessionId);
        const removed = (row: WorkspaceSession) => row.id === sessionId || (includeChildren && row.parentSessionId === sessionId);
        const remaining = sessions.filter(row => !removed(row)).map(row => row.parentSessionId === sessionId ? { ...row, parentSessionId: null } : row);
        this.hierarchy.removeSession(sessionId);
        const updateParent = (row: WorkspaceSession) => row.id === session.parentSessionId
          ? { ...row, childCount: Math.max(0, (row.childCount ?? 0) - 1) }
          : row;
        this.priorityRecords.update(records => {
          const snapshot = records.get(taskId);
          if (!snapshot) return records;
          return new Map(records).set(taskId, {
            items: snapshot.items.filter(row => !removed(row)).map(row =>
              row.parentSessionId === sessionId ? { ...row, parentSessionId: null } : updateParent(row),
            ),
            parents: snapshot.parents.filter(row => !removed(row)).map(updateParent),
          });
        });
        this.sessionRecords.update(records => {
          const roots = (records.get(taskId) ?? []).filter(row => !removed(row)).map(updateParent);
          const rootIds = new Set(roots.map(row => row.id));
          const promoted = remaining.filter(row => sessions.find(previous => previous.id === row.id)?.parentSessionId === sessionId && !rootIds.has(row.id));
          return new Map(records).set(taskId, [...roots, ...promoted].sort((a,b) => a.id - b.id));
        });
        const selection = this.chosen();
        if (selection?.taskId === taskId && sessions.some(row => row.id === selection.sessionId && removed(row))) {
          const next = remaining[at] ?? remaining[0];
          this.chosen.set(next ? { scopeId: scope, taskId, sessionId: next.id } : null);
        }
      }
    }
    if (result && !deleting && this.sessionArchiveHistoryAvailable()) await this.archives.changed(scope, taskId);
    if (this.valid(scope)) this.busy.set(false);
    return !!result;
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
    if (this.valid(scope) && this.navigationSessions().get(taskId)?.some(session => session.id === sessionId)) this.selectSession({ taskId: intent.taskId, sessionId: intent.session.id });
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

  async loadSessionChildren(intent: { readonly taskId: string; readonly sessionId: string; readonly earlier?: boolean }): Promise<void> {
    await this.readChildWindow(Number(intent.taskId), Number(intent.sessionId), intent.earlier ? 'earlier' : 'latest');
  }

  private async readChildWindow(taskId: number, parentId: number, page: 'latest' | 'earlier' | 'refresh'): Promise<void> {
    const scope = this.scopeId();
    const current = () => this.sessionNestingAvailable() && !this.closed() &&
      this.taskRecords().some(task => task.id === taskId) &&
      !!this.navigationSessions().get(taskId)?.some(row => row.id === parentId && row.parentSessionId == null);
    if (!scope || !current()) return;
    await this.hierarchy.load(taskId, parentId, page,
      cursor => this.bridge.workspaceSessions(scope, { taskId, parentSessionId: parentId, limit: 20, order: 'latest', ...(this.sessionNestingOrderAvailable() ? { childOrder: 'nested' } : {}), ...(cursor ? { cursor } : {}) }),
      () => this.valid(scope) && current());
  }
  async moveSession(intent: { readonly taskId: string; readonly sessionId: string; readonly parentSessionId: string | null }): Promise<void> {
    const scope = this.scopeId(), taskId = Number(intent.taskId), sessionId = Number(intent.sessionId);
    if (!scope || this.busy() || !this.sessionNestingAvailable() || this.closed()) return;
    const sessions = this.navigationSessions().get(taskId) ?? [], source = sessions.find(row => row.id === sessionId);
    const parentSessionId = intent.parentSessionId === null ? null : Number(intent.parentSessionId);
    if (!source || (parentSessionId !== null && !sessions.some(row => row.id === parentSessionId))) return;
    this.busy.set(true);
    const moved = await this.mutate(scope, () => this.bridge.workspaceMoveSession(scope, { taskId, sessionId, parentSessionId }));
    if (moved && this.valid(scope)) {
      // Update confirmed data only. An uncertain mutation must be reconciled, never replayed.
      this.sessionRecords.update(records => new Map(records).set(taskId, [...(records.get(taskId) ?? []).filter(row => row.id !== sessionId), moved].sort((a,b) => a.id - b.id)));
      this.hierarchy.reset();
      await this.loadTasks(this.currentTaskCursor);
      if (parentSessionId !== null) await this.loadSessionChildren({ taskId: intent.taskId, sessionId: String(parentSessionId) });
    }
    if (this.valid(scope)) this.busy.set(false);
  }

  setSessionDisclosure(taskId: string, disclosure: TaskSessionDisclosure | null): void {
    this.sessionDisclosures.update(records => {
      const next = new Map(records);
      next.delete(taskId);
      if (disclosure) next.set(taskId, disclosure);
      while (next.size > 200) {
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      return next;
    });
  }

  /** Keep the expanded history depth across navigation revisions. The first
   * page stays small, and all deeper reads still use bounded keyset pages. */
  private async readSessionHistory(
    scope: string, taskId: number, current: () => boolean, background: boolean,
  ): Promise<WorkspacePage<WorkspaceSession> | null> {
    const root = this.sessionNestingAvailable() && !this.closed() ? { parentSessionId: null } : {};
    let page = await this.read(scope, () => this.bridge.workspaceSessions(scope, {
      taskId, limit: 20, order: 'latest', ...root,
    }), current, background);
    if (!page) return null;
    let remaining = (this.sessionHistoryDepth.get(taskId) ?? 20) - 20;
    const pages = [page.items];
    while (remaining > 0 && page.nextCursor) {
      const cursor: string = page.nextCursor;
      const limit = Math.min(100, remaining);
      page = await this.read(scope, () => this.bridge.workspaceSessions(scope, {
        taskId, cursor, limit, order: 'latest', ...root,
      }), current, background);
      if (!page) return null;
      pages.push(page.items);
      remaining -= limit;
    }
    return { items: pages.reverse().flat(), nextCursor: page.nextCursor };
  }

  async loadOlderSessions(request: TaskSessionHistoryRequest): Promise<void> {
    const { taskId: id, cap } = request;
    const scope = this.scopeId(), taskId = Number(id);
    if (!scope || !this.sessionCursors().get(taskId) || this.busy() || this.loading() ||
      !this.taskRecords().some(task => task.id === taskId)) return;
    const project = this.activeProject(), closed = this.closed(), taskCursor = this.currentTaskCursor;
    const disclosure = this.sessionDisclosures().get(id);
    const limit = Math.min(100, request.limit);
    this.busy.set(true);
    this.loadingOlderSessions.set(taskId);
    try {
      // An already-running refresh can replace the cursor. Finish it before
      // paging so its older snapshot cannot overwrite a successful append.
      if (this.navigationRefresh) await this.navigationRefresh.catch(() => undefined);
      const cursor = this.sessionCursors().get(taskId), revision = this.listRevision;
      if (!cursor || !this.valid(scope) || this.loading() || this.activeProject() !== project ||
        this.closed() !== closed || this.currentTaskCursor !== taskCursor ||
        !this.taskRecords().some(task => task.id === taskId)) return;
      const current = () => revision === this.listRevision && this.valid(scope);
      const page = await this.read(scope, () => this.bridge.workspaceSessions(scope, {
        taskId, cursor, limit, order: 'latest',
        ...(this.sessionNestingAvailable() && !this.closed() ? { parentSessionId: null } : {}),
      }), current);
      if (!page || !current()) return;
      const visibleIds = new Set(this.navigationSessions().get(taskId)?.map(row => row.id));
      const existing = this.sessionRecords().get(taskId) ?? [];
      const existingIds = new Set(existing.map(row => row.id));
      this.sessionRecords.update(records => new Map(records).set(taskId,
        [...page.items.filter(row => !existingIds.has(row.id)), ...existing].sort((a, b) => a.id - b.id),
      ));
      this.sessionCursors.update(cursors => new Map(cursors).set(taskId, page.nextCursor));
      const depth = (this.sessionHistoryDepth.get(taskId) ?? 20) + limit;
      this.sessionHistoryDepth.delete(taskId);
      this.sessionHistoryDepth.set(taskId, depth);
      if (this.sessionHistoryDepth.size > 200) {
        const oldest = this.sessionHistoryDepth.keys().next().value;
        if (oldest !== undefined) this.sessionHistoryDepth.delete(oldest);
      }
      if (cap === null || this.sessionDisclosures().get(id) !== disclosure) return;
      const ids = page.items.filter(row => !visibleIds.has(row.id) &&
        !isWorkspacePriorityStatus(workspaceSessionStatus(row))).map(row => String(row.id));
      if (ids.length) this.setSessionDisclosure(id, {
        taskId: id, cap, hiddenIds: disclosure?.cap === cap ? disclosure.hiddenIds : [],
        batches: [...(disclosure?.cap === cap ? disclosure.batches ?? [] : []), ids],
      });
    } finally {
      if (this.scopeId() === scope) {
        this.loadingOlderSessions.set(null);
        this.busy.set(false);
      }
    }
  }
  reconcileTaskBranch(scope: string, taskId: number, branch: string): void { if (this.valid(scope)) this.taskRecords.update(tasks => tasks.map(task => task.id === taskId ? { ...task, branchName: branch } : task)); }
  openNewProject(from: HTMLElement | null = null): void {
    if (!this.capable || !this.scopeId() || this.busy()) return;
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(from); this.error.set(null);
    this.dialogKey.update(value => value + 1); this.dialog.set('project'); this.dialogOpen.set(true);
  }
  async openNewTask(projectId?: string): Promise<void> {
    if (this.editingWaitingTask) { this.taskOutbox.enqueue(this.editingWaitingTask); this.editingWaitingTask = null; this.editingTask.set(null); }
    const project = (projectId ? this.projectRecords().find(item => String(item.id) === projectId) : this.selectedProject()) ?? this.projectRecords()[0];
    const scope = this.scopeId();
    const selectionRevision = this.listRevision;
    if (!scope || !project || this.busy()) return;
    this.stopBranchSearch();
    this.editingTask.set(null);
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(null);
    this.error.set(null);
    if (this.offline()) {
      if (this.detail()?.project.id !== project.id || !this.repositories().length) { this.error.set(`New task opens when ${this.machine()?.name ?? 'the machine'} is back. Repository choices have not loaded yet.`); return; }
      this.draftTaskRepository.set(this.initialTaskRepository(this.repositories()));
      this.taskRequestId = crypto.randomUUID(); this.editingTask.set(null); this.dialogKey.update(value => value + 1); this.dialog.set('task'); this.dialogOpen.set(true); return;
    }
    this.busy.set(true);
    const accept = () => this.valid(scope) && selectionRevision === this.listRevision;
    const detail = await this.read(scope, () => this.bridge.workspaceProject(scope, project.id), accept);
    if (detail && accept()) {
      const repoId = this.initialTaskRepository(detail.repositories.items);
      const page = repoId
        ? await this.read(scope, () => this.bridge.workspaceBranches(scope, { repoId: Number(repoId), limit: 50, includeRemote: true }), accept, true).catch(() => null)
        : null;
      if (accept()) {
        const branches = new Map<string, readonly BranchInfo[]>();
        if (repoId && page) branches.set(repoId, page.map(branchView));
        const base = page && defaultBranchRef(page);
        this.detail.set(detail);
        this.branches.set(branches);
        this.baseBranches.set(branches);
        this.defaultBranches.set(repoId && base ? new Map([[repoId, base]]) : new Map());
        this.draftTaskRepository.set(repoId);
        this.taskRequestId = crypto.randomUUID();
        this.dialogKey.update(value => value + 1);
        this.dialog.set('task');
        this.dialogOpen.set(true);
      }
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }
  readonly branchesFor = (repoId: string): readonly BranchInfo[] => this.branches().get(repoId) ?? [];
  readonly basesFor = (repoId: string): readonly BranchInfo[] => this.baseBranches().get(repoId) ?? [];
  searchBranches(query: TaskBranchSearch | null): void {
    this.stopBranchSearch();
    const scope = this.scopeId(), dialog = this.dialogKey(), revision = this.branchRevision;
    if (!query || !scope || this.offline() || !this.dialogOpen() || !this.repositories().some(repo => String(repo.id) === query.repoId)) return;
    const accept = () => this.valid(scope) && revision === this.branchRevision && this.dialogKey() === dialog && this.dialogOpen();
    this.branchLoading.set(true);
    this.branchTimer = setTimeout(() => {
      this.branchTimer = undefined;
      void this.read(scope, () => this.bridge.workspaceBranches(scope, { repoId: Number(query.repoId), query: query.query.trim(), limit: 50, includeRemote: true }), accept, true).then(result => {
        if (!result || !accept()) return;
        const target = query.kind === 'base' ? this.baseBranches : this.branches;
        target.update(choices => new Map(choices).set(query.repoId, result.map(branchView)));
        const base = defaultBranchRef(result);
        if (base && this.defaultBranches().get(query.repoId) !== base) this.defaultBranches.update(bases => new Map(bases).set(query.repoId, base));
      }, () => {
        if (accept()) this.branchSearchFailed.set(true);
      }).finally(() => {
        if (accept()) this.branchLoading.set(false);
      });
    }, 160);
  }
  private initialTaskRepository(repos: readonly WorkspaceRepository[]): string | undefined {
    const selected = this.selectedTask()?.repoId;
    return (repos.find(repo => repo.id === selected) ?? repos[0])?.id.toString();
  }
  private stopBranchSearch(): void {
    clearTimeout(this.branchTimer);
    this.branchTimer = undefined;
    this.branchRevision++;
    this.branchLoading.set(false);
    this.branchSearchFailed.set(false);
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
  closeDialog(): void {
    if (this.busy()) return;
    this.stopBranchSearch();
    if (this.editingWaitingTask) {
      this.taskOutbox.enqueue(this.editingWaitingTask);
      this.editingWaitingTask = null;
      this.taskOutbox.connect(this.offline() ? null : this.scopeId());
    }
    this.editingTask.set(null);
    this.projectCompletion = null;
    this.dialogOpen.set(false);
  }
  dialogClosed(): void {
    const completed = this.projectCompletion;
    this.projectCompletion = null;
    if (completed && this.valid(completed.scope) && !this.dialogOpen() && this.activeProject() === String(completed.projectId)) this.projectCreated.set(completed.projectId);
  }

  async checkWaitingTask(id: string): Promise<void> { const scope = this.scopeId(); if (scope && this.taskRequestsAvailable() && await this.taskOutbox.check(scope, id) && this.uncertainTaskRequest === id) { this.mutationUncertain.set(false); this.error.set(null); this.uncertainTaskRequest = null; } }
  removeWaitingTask(id: string): void { this.taskOutbox.remove(id); }
  editWaitingTask(id: string): void {
    if (this.busy()) return;
    const waiting = this.waitingTasks().find(item => item.id === id);
    if (waiting && !this.repositories().some(repo => repo.id === waiting.repoId)) { this.error.set('Open this task’s repository when the machine is back to edit it.'); return; }
    const item = this.taskOutbox.take(id);
    if (!item) return;
    this.editingWaitingTask = item; this.editingTask.set(item.draft); this.taskRequestId = item.id;
    this.dialogKey.update(value => value + 1); this.dialog.set('task'); this.dialogOpen.set(true);
  }

  async createTask(draft: CreatedTask, planned = false): Promise<void> {
    if (this.journal && !this.journal.restored()) { this.error.set('Restoring waiting writing. Keep this draft here until it is ready.'); return; }
    planned ||= this.editingWaitingTask?.planned ?? false;
    const scope = this.scopeId(), repo = draft.repo ? this.repositories().find(repo => String(repo.id) === draft.repo) : this.repositories()[0], selectionRevision = this.listRevision;
    if (!scope || !repo || this.busy()) return;
    if (this.offline() || this.editingWaitingTask) {
      if (this.waitingTasks().length >= 10) { this.error.set('Up to 10 tasks can wait in this window. Remove one first.'); return; }
      if (!this.taskOutbox.enqueue({ id: this.taskRequestId, draft, repoId: repo.id, projectId: repo.projectId, planned })) return;
      this.taskRequestId = crypto.randomUUID(); this.editingWaitingTask = null; this.editingTask.set(null); this.dialogOpen.set(false); this.taskOutbox.connect(this.offline() ? null : scope); return;
    }
    this.editingWaitingTask = null;
    this.busy.set(true);
    const requestId = this.taskRequestId, machineIdentity = this.machineIdentity;
    let dispatched = false;
    const task = await this.mutate(scope, () => {
      dispatched = true;
      return this.bridge.workspaceCreateTask(scope, { repoId: repo.id, name: draft.title, branchName: draft.branch, mode: draft.existing ? 'existing' : 'new', ...(draft.base ? { baseRef: draft.base } : {}), requestId });
    });
    if (!task && dispatched && !this.disposed && machineIdentity === this.machineIdentity && (this.mutationUncertain() || !this.valid(scope))) {
      this.uncertainTaskRequest = requestId;
      this.taskOutbox.rememberUnknown({ id: requestId, draft, repoId: repo.id, projectId: repo.projectId, planned });
    }
    if (task && selectionRevision === this.listRevision) {
      if (planned) await this.mutate(scope, () => this.bridge.workspaceSetStage(scope, { taskId: task.id, stage: 'planned' }));
      this.dialogOpen.set(false); this.activeProject.set(String(task.projectId)); this.closed.set(false);
      this.stopPreparation(); this.localSessionId.set(null); this.chosen.set(null); this.pendingTask.set(task);
      this.taskRecords.update(tasks => [task, ...tasks.filter(item => item.id !== task.id)].slice(0, 20));
      const revision = this.preparationRevision;
      void this.prepareTask(scope, task.id, revision, Date.now(), 0);
    }
    if (this.scopeId() === scope) this.busy.set(false);
  }

  async planTask(draft: PlannedTask): Promise<void> {
    const repo = this.repositories().find(repo => String(repo.id) === draft.repo) ?? this.repositories()[0];
    const existing = !!draft.existing && !!draft.branch;
    const base = draft.base ?? (repo ? this.defaultBranches().get(String(repo.id)) ?? repo.defaultBase : null);
    const branch = draft.branch || branchFromTitle(draft.title) || 'task';
    await this.createTask({ ...draft, branch, existing, base: existing ? null : base ?? null }, true);
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
        ...(draft.image && this.projectImagesAvailable() ? { image: draft.image } : {}),
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
      this.stopPreparation(); this.localSessionId.set(null); this.chosen.set(null);
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
    this.stopPreparation(); this.localSessionId.set(null); this.closed.set(closed); this.chosen.set(null);
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
    if (!task || task.setupIssue?.closeFailed || !scope || this.busy() || this.mutationUncertain()) return;
    if (recovery === 'use-existing' && task.setupIssue?.code !== 'external-checkout') return;
    if (recovery === 'snapshot' && !task.setupIssue?.canUseSnapshot) return;
    if (recovery === 'exceed-worktree-limit' && !task.setupIssue?.canExceedWorktreeLimit) return;
    if ((recovery === 'restore-branch' || recovery === 'new-workspace') && task.setupIssue?.workspaceRecovery !== recovery) return;
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
    const result = await this.mutate(scope, () => this.bridge.workspaceUpdateProject(scope, {
      projectId: project.id,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.agentInstructions !== undefined ? { agentInstructions: patch.agentInstructions } : {}),
      ...(appearance ? { appearance: {
        look: appearance.look, hue: appearance.hue ?? undefined, emoji: appearance.emoji, icon: appearance.icon,
        ...(this.projectImagesAvailable() && appearance.image !== undefined ? { image: appearance.image } : {}),
      } } : {}),
    }));
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
  async keepTaskOpen(): Promise<void> {
    const task = this.selectedTask(), scope = this.scopeId();
    if (!task?.temporary || !scope || this.busy() || this.offline()) return;
    this.busy.set(true);
    try {
      const result = await this.mutate(scope, () => this.bridge.workspaceKeepTaskOpen(scope, task.id));
      if (result) this.taskRecords.update(tasks => tasks.map(item => item.id === task.id ? result : item));
    } finally {
      if (this.scopeId() === scope) this.busy.set(false);
    }
  }
  async closeTask(confirmStop = false, confirmedApps = 0): Promise<void> {
    const selected = this.selectedTask(), pending = selected ? null : this.pendingTask();
    const task = selected ?? (pending?.setupIssue?.closeFailed ? pending : null);
    const scope = this.scopeId(), selection = this.chosen();
    if (!task || !scope || this.busy()) return;
    this.busy.set(true);
    const result = await this.mutate(scope, () => this.bridge.workspaceFinishTask(scope, { taskId: task.id, confirmStop, ...(confirmedApps ? { confirmedApps } : {}) }));
    if (result) {
      this.sessionArchiveUndo.set(null);
      this.closeUndo.set({ scopeId: scope, task });
      const stillSelected = pending ? this.pendingTask() === pending
        : this.chosen() === selection && this.selectedTask()?.id === task.id;
      if (!this.closed()) this.taskRecords.update(tasks => tasks.filter(item => item.id !== task.id));
      if (stillSelected) {
        if (pending) this.stopPreparation();
        this.chosen.set(null);
        await this.loadTasks();
      }
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
    if (task.state === 'released') return;
    if (task.state === 'failed') { this.error.set(task.setupIssue?.message ?? 'The task workspace could not be prepared. Check the task before creating another.'); return; }
    if (task.state === 'ready') {
      const sessions = await this.read(scope, () => this.bridge.workspaceSessions(scope, { taskId, limit: 20, order: 'latest', ...(this.sessionNestingAvailable() && !this.closed() ? { parentSessionId: null } : {}) }));
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
  private async read<T>(scope: string, operation: () => Promise<BackendResult<T>>, accept: () => boolean = () => true, background = false): Promise<T | null> {
    if (!this.valid(scope) || !accept()) return null;
    try {
      const result = await operation();
      if (!this.valid(scope) || !accept()) return null;
      if (result.ok) return result.value;
      if (background) throw new Error(result.error.message);
      this.error.set(result.error.message);
    } catch (error) {
      // The observer retries this revision; a partial refresh never removes the
      // last good session window or creates a transient error banner.
      if (background) throw error;
      if (this.valid(scope) && accept()) this.error.set('The backend could not be reached. Refresh to reconnect.');
    }
    return null;
  }
  private async mutate<T>(scope: string, operation: () => Promise<BackendResult<T>>): Promise<T | null> {
    if (!this.valid(scope) || this.restoring()) { this.error.set(`This action needs ${this.machine()?.name ?? 'the machine'}. Nothing was sent. Try again once it is back.`); return null; }
    if (!this.capable || this.mutationUncertain()) return null;
    this.error.set(null);
    this.inFlightMutations++;
    try {
      const result = await operation();
      if (!this.valid(scope)) return null;
      if (result.ok) return result.value;
      if (result.error.code === 'outcome-unknown' || result.error.code === 'transport' || result.error.code === 'timeout') {
        this.mutationUncertain.set(true); this.error.set('The change could not be confirmed. Refresh to check its outcome before trying again.');
      } else this.error.set(result.error.message);
    } catch { if (this.valid(scope)) { this.mutationUncertain.set(true); this.error.set('The change could not be confirmed. Refresh to check its outcome before trying again.'); } }
    finally { this.inFlightMutations--; }
    return null;
  }
  private valid(scope: string): boolean { return !this.disposed && this.scopeId() === scope && this.backend.state().scope?.id === scope; }
  private applyCapabilities(scope: string, capability: WorkspaceRevision | null): void {
    if (!this.valid(scope)) return;
    this.chatStreamScope.set(capability?.chatStream ? scope : null);
    this.taskRequestsAvailable.set(capability?.taskRequests === true);
    this.commitPanelAvailable.set(capability?.commitPanel === true);
    this.projectImagesAvailable.set(capability?.projectImages === true);
    this.taskAppsAvailable.set(capability?.taskApps === true);
    this.sessionPriorityAvailable.set(capability?.sessionPriority === true);
    this.sessionNestingAvailable.set(capability?.sessionNesting === true);
    this.sessionNestingOrderAvailable.set(capability?.sessionNestingOrder === true);
    this.sessionArchiveAvailable.set(capability?.sessionArchive === true);
    this.sessionArchiveChildrenAvailable.set(capability?.sessionArchiveChildren === true);
    this.sessionArchiveHistoryAvailable.set(capability?.sessionArchiveHistory === true);
  }
  private current(scope: string, revision: number): boolean { return this.valid(scope) && this.revision === revision; }
  private reset(scope: string | null): void {
    this.chatStreamScope.set(null);
    this.taskAppsAvailable.set(false); this.appLink.set(null); this.appReveal.reset();
    this.sessionArchiveChildrenAvailable.set(false);
    this.projectImagesAvailable.set(false);
    this.priorityRecords.set(new Map()); this.sessionPriorityAvailable.set(false);
    this.sessionHistoryDepth.clear(); this.loadingOlderSessions.set(null); this.navigationRefresh = undefined;
    this.hierarchy.reset(); this.sessionNestingAvailable.set(false); this.sessionNestingOrderAvailable.set(false);
    this.sessionCreation.reset(); this.localSessionId.set(null); this.sessionRenderIds.set(new Map());
    this.uncertainTaskRequest = null; this.editingWaitingTask = null; this.editingTask.set(null); this.outageTasks = null;
    this.suspended = false; this.asOf.set(null); this.outbox?.connect(null); this.taskOutbox.connect(null); this.sessionOutbox.connect(null);
    this.resume.reset(); this.resumeLoaded = false; this.resumeContext = null; this.resumeNavigationCancelled = false; this.restoring.set(scope !== null);
    this.panelOpen.set(false); this.workspacePanel.set('changes'); this.appsPanels.set([]); this.wideReview.set(false); this.closed.set(false); this.filter.set(null);
    this.projectCompletion = null; this.projectCreated.set(null); this.dialogFrom.set(null);
    this.sessionDisclosures.set(new Map());
    this.capable = false; this.archives.reset(); this.sessionArchiveHistoryAvailable.set(false); this.taskRequestsAvailable.set(false); this.commitPanelAvailable.set(false); this.sessionArchiveAvailable.set(false); this.sessionArchiveUndo.set(null); this.closeUndo.set(null);
    this.observer?.dispose(); this.observer = undefined; this.projectPage.set(false); this.currentTaskCursor = undefined; this.currentProjectCursor = undefined;
    this.stopPreparation();
    this.archiveUndo.set(null);
    this.mutationUncertain.set(false); this.uncertainSetup = null;
    this.stopBranchSearch(); this.baseBranches.set(new Map()); this.defaultBranches.set(new Map());
    this.revision++; this.listRevision++; this.scopeId.set(scope); this.projectRecords.set([]); this.taskRecords.set([]); this.sessionRecords.set(new Map()); this.sessionCursors.set(new Map()); this.detail.set(null); this.chosen.set(null); this.activeProject.set('all'); this.focused.set(false); this.dialogOpen.set(false); this.busy.set(false); this.error.set(null); this.loading.set(false); this.branches.set(new Map()); this.projectsCursor.set(null); this.tasksCursor.set(null); this.taskPage.set(false);
  }
}

function branchView(branch: WorkspaceBranch): BranchInfo {
  return {
    name: branch.name,
    isDefault: branch.isDefault,
    ...(branch.ref ? { ref: branch.ref, remote: branch.ref.startsWith('refs/remotes/') } : {}),
    ...(branch.remoteBranch ? { remoteBranch: branch.remoteBranch } : {}),
    ...(branch.heldTaskName ? { task: branch.heldTaskName } : {}),
  };
}
function defaultBranchRef(branches: readonly WorkspaceBranch[]): string | undefined {
  const preferred = branches.find(branch => branch.isDefault);
  return preferred?.ref ?? branches[0]?.defaultBase ?? preferred?.name;
}
