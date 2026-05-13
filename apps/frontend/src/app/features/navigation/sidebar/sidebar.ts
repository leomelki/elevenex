import { Component, inject, OnInit, OnDestroy, signal, ViewChild, ElementRef, effect, input, HostListener, computed, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFolder,
  lucideGitBranch,
  lucideTerminal,
  lucideCircleDashed,
  lucideAlertCircle,
  lucideChevronRight,
  lucideChevronDown,
  lucidePlus,
  lucideRefreshCw,
  lucideTrash2,
  lucideArchive,
  lucideArchiveRestore,
  lucideCircleMinus,
  lucideServer,
  lucideSquareArrowOutUpRight,
  lucideCheckSquare,
  lucideInfo,
  lucideMoon,
  lucideSun,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { NavigationService } from '../../../shared/services/navigation.service';
import { WorktreesService } from '../../../shared/services/worktrees.service';
import { SessionsService } from '../../../shared/services/sessions.service';
import { TabColorService } from '../../../shared/services/tab-color.service';
import { TabService } from '../../session/tab-service';
import { NavigationProject, NavigationRepo, NavigationBranch } from '../../../shared/models/navigation-tree.model';
import { SessionInTree } from '../../../shared/models/session.model';
import { WorktreeSheet } from '../worktree-sheet/worktree-sheet';
import { BranchSearch } from '../branch-search/branch-search';
import { BranchInfo } from '../../../shared/models/branch.model';
import { ZardInputDirective } from '@/shared/components/input';
import { PlannotatorStateService } from '@/features/plannotator';
import { VSCodeWebStateService, buildVSCodeIframeKey } from '@/features/vscode-web/vscode-web-state.service';
import { ClaudeStatusService } from '@/shared/services/claude-status.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';
import { SshForward } from '@/shared/models/ssh-forward.model';
import { CursorService } from '@/shared/services/cursor.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { SshRuntimeRecoveryService } from '@/shared/services/ssh-runtime-recovery.service';
import { TodosService } from '@/features/productivity/todos.service';
import { getElectronWindowControlsApi } from '@/shared/runtime/electron-window-controls';
import { Project } from '@/shared/models/project.model';
import { ProjectOnboardingWizard } from '@/features/projects/project-onboarding-wizard/project-onboarding-wizard';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { ReposService } from '@/shared/services/repos.service';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { PendingWorktreeCreationsService } from '@/shared/services/pending-worktree-creations.service';
import { EnvironmentSwitcherComponent } from '../environment-switcher/environment-switcher.component';
import { ThemeService } from '@/shared/services/theme.service';

@Component({
  selector: 'app-sidebar',
  imports: [NgIcon, RouterLink, WorktreeSheet, BranchSearch, ZardInputDirective, ProjectOnboardingWizard, PathAutocompleteInputComponent, TrackNativeModalDirective, EnvironmentSwitcherComponent],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
  viewProviders: [
    provideIcons({
      lucideFolder,
      lucideGitBranch,
      lucideTerminal,
      lucideCircleDashed,
      lucideAlertCircle,
      lucideChevronRight,
      lucideChevronDown,
      lucidePlus,
      lucideRefreshCw,
      lucideTrash2,
      lucideArchive,
      lucideArchiveRestore,
      lucideCircleMinus,
      lucideServer,
      lucideSquareArrowOutUpRight,
      lucideCheckSquare,
      lucideInfo,
      lucideMoon,
      lucideSun,
    }),
  ],
})
export class Sidebar implements OnInit, OnDestroy {
  private static readonly SESSION_DELETE_CONFIRM_DELAY_MS = 300;
  private static readonly SESSION_DELETE_AUTO_DISMISS_MS = 3000;
  private static readonly SESSION_TIME_TICK_MS = 60_000;

  desktopMode = input(false);
  macNativeChrome = input(false);
  macTrafficLightsVisible = input(false);
  navService = inject(NavigationService);
  private router = inject(Router);
  private worktreesService = inject(WorktreesService);
  private sessionsService = inject(SessionsService);
  private tabService = inject(TabService);
  private vscodeWebState = inject(VSCodeWebStateService);
  private colorService = inject(TabColorService);
  plannotatorState = inject(PlannotatorStateService);
  claudeStatus = inject(ClaudeStatusService);
  private sshForwardsService = inject(SshForwardsService);
  private reposService = inject(ReposService);
  private cursorService = inject(CursorService);
  private onboardingState = inject(OnboardingStateService);
  private sshRuntimeRecovery = inject(SshRuntimeRecoveryService);
  private todosService = inject(TodosService);
  readonly theme = inject(ThemeService);
  pendingWorktreeCreations = inject(PendingWorktreeCreationsService);
  private windowControls = getElectronWindowControlsApi();
  private host = inject(ElementRef<HTMLElement>);
  readonly timeTick = signal(Date.now());

  activeSessionId = this.tabService.activeSessionId;
  sshProjectStats = signal<Map<number, { active: number; saved: number; error: number }>>(new Map());
  private sshStatsTimer: number | null = null;
  private sessionTimeTickTimer: number | null = null;
  private readonly sshStatsEffect = effect(() => {
    const projects = this.navService.tree();
    void this.refreshSshProjectStats(projects);
  });

  private readonly todosLoadEffect = effect(() => {
    const projects = this.navService.tree();
    for (const project of projects) {
      this.todosService.getTodos(project.id).subscribe();
    }
  });
  private wasConnecting = false;
  private readonly remoteConnectingEffect = effect(() => {
    const connecting = this.sshRuntimeRecovery.remoteConnecting();
    if (connecting) {
      this.wasConnecting = true;
      return;
    }
    if (this.wasConnecting) {
      this.wasConnecting = false;
      this.navService.refreshTree();
    }
  });

  private readonly sessionTitleEffect = effect(() => {
    const sessionTitles = this.claudeStatus.sessionTitles();
    if (sessionTitles.size === 0) {
      return;
    }

    untracked(() => this.navService.refreshTree());
  });

  private readonly projectRevealEffect = effect(() => {
    const projectId = this.navService.revealProjectId();
    const projects = this.navService.tree();

    if (!projectId || projects.every(project => project.id !== projectId)) {
      return;
    }

    if (this.projectRevealTimer !== null) {
      window.clearTimeout(this.projectRevealTimer);
    }

    this.projectRevealTimer = window.setTimeout(() => this.revealProjectRow(projectId), 60);
  });

  @ViewChild('worktreeSheet') worktreeSheet!: WorktreeSheet;
  @ViewChild('branchSearch') branchSearch!: BranchSearch;
  @ViewChild('removeFromProjectDialog') removeFromProjectDialogRef!: TrackNativeModalDirective;
  @ViewChild('deleteWorktreeDialog') deleteWorktreeDialogRef!: TrackNativeModalDirective;
  @ViewChild('sessionTitleInput') sessionTitleInputRef!: ElementRef<HTMLInputElement>;

  editingSessionTitleId = signal<number | null>(null);
  showCreateWizard = signal(false);
  addRepoProject = signal<NavigationProject | null>(null);
  addRepoPath = signal('');
  addRepoSubmitting = signal(false);
  addRepoError = signal('');
  showPortForwardStep = computed(() => this.onboardingState.snapshotState().mode !== 'local');

  deleteWorktreeRepoId = signal(0);
  deleteWorktreePath = signal('');
  deleteWorktreeBranch = signal('');
  deleting = signal(false);
  removeFromProjectRepoId = signal(0);
  removeFromProjectPath = signal('');
  removeFromProjectBranch = signal('');
  removingFromProject = signal(false);
  openingWorktreeBranchKey = signal<string | null>(null);

  armedDeleteSessionId = signal<number | null>(null);
  deleteSessionConfirmEnabled = signal(false);
  deletingSessionId = signal<number | null>(null);
  archivingSessionId = signal<number | null>(null);
  unarchivingSessionId = signal<number | null>(null);
  private sessionDeleteEnableTimer: number | null = null;
  private sessionDeleteDismissTimer: number | null = null;
  private projectRevealTimer: number | null = null;
  private projectHighlightTimer: number | null = null;
  private openWorktreeTimer: number | null = null;

  private getOpenWorktreePathForSession(sessionId: number): string | null {
    return this.tabService.tabs().find(tab => tab.sessionId === sessionId)?.worktreePath ?? null;
  }

  private getProjectIdForSession(sessionId: number): number | null {
    return this.tabService.tabs().find(tab => tab.sessionId === sessionId)?.projectId ?? null;
  }

  private getIframeKeyForSession(sessionId: number): string | null {
    const tab = this.tabService.tabs().find(currentTab => currentTab.sessionId === sessionId);
    if (!tab) {
      return null;
    }

    return buildVSCodeIframeKey(tab.projectId, tab.worktreePath);
  }

  ngOnInit() {
    if (!this.sshRuntimeRecovery.remoteConnecting()) {
      this.navService.loadTree();
    }
    this.sshStatsTimer = window.setInterval(() => {
      void this.refreshSshProjectStats(this.navService.tree());
    }, 4000);
    this.sessionTimeTickTimer = window.setInterval(() => {
      this.timeTick.set(Date.now());
    }, Sidebar.SESSION_TIME_TICK_MS);
  }

  ngOnDestroy() {
    if (this.sshStatsTimer !== null) {
      window.clearInterval(this.sshStatsTimer);
    }

    if (this.sessionTimeTickTimer !== null) {
      window.clearInterval(this.sessionTimeTickTimer);
    }

    this.clearSessionDeleteTimers();

    if (this.projectRevealTimer !== null) {
      window.clearTimeout(this.projectRevealTimer);
    }

    if (this.projectHighlightTimer !== null) {
      window.clearTimeout(this.projectHighlightTimer);
    }

    if (this.openWorktreeTimer !== null) {
      window.clearTimeout(this.openWorktreeTimer);
    }
  }

  openCreateProjectWizard() {
    this.showCreateWizard.set(true);
  }

  closeCreateProjectWizard() {
    this.showCreateWizard.set(false);
  }

  handleProjectCreated(project: Project) {
    this.showCreateWizard.set(false);
    void this.router.navigate(['/projects', project.id]);
  }

  openAddRepoWizard(project: NavigationProject, event: Event) {
    event.stopPropagation();
    this.navService.expandKey(`project-${project.id}`);
    this.addRepoPath.set('');
    this.addRepoError.set('');
    this.addRepoSubmitting.set(false);
    this.addRepoProject.set(project);
  }

  onAddRepoDialogClosed() {
    if (this.addRepoSubmitting()) {
      return;
    }
    this.addRepoProject.set(null);
    this.addRepoPath.set('');
    this.addRepoError.set('');
  }

  preferredAddRepoStartDirectory() {
    const path = this.addRepoPath();
    if (path.startsWith('~/')) {
      return '~';
    }
    if (!path.includes('/')) {
      return undefined;
    }
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }

  submitAddRepo(project: NavigationProject) {
    if (this.addRepoSubmitting()) {
      return;
    }

    const path = this.addRepoPath().trim();
    if (!path) {
      return;
    }

    this.addRepoSubmitting.set(true);
    this.addRepoError.set('');

    this.reposService.add(project.id, path).subscribe({
      next: () => {
        this.addRepoSubmitting.set(false);
        this.addRepoProject.set(null);
        this.addRepoPath.set('');
        toast.success('Repository added');
        this.navService.refreshTree();
        this.navService.revealProject(project.id);
      },
      error: (err) => {
        const msg = err?.error?.message || err?.message || 'Could not add repository.';
        this.addRepoError.set(msg);
        this.addRepoSubmitting.set(false);
      },
    });
  }

  onProjectClick(project: NavigationProject) {
    this.navService.toggleExpand(`project-${project.id}`);
    this.clearDeleteSessionConfirmationIfHidden();
  }

  async openProjectSsh(project: NavigationProject, event: Event) {
    event.stopPropagation();
    const currentPath = this.router.url.split('#')[0];
    const targetPath = `/projects/${project.id}`;

    if (currentPath.startsWith('/projects/') && currentPath !== targetPath) {
      await this.router.navigateByUrl('/projects', { skipLocationChange: true });
    }

    await this.router.navigate(['/projects', project.id], { fragment: 'ssh-forwarding' });
  }

  onRepoClick(repo: NavigationRepo) {
    this.navService.toggleExpand(`repo-${repo.id}`);
    this.clearDeleteSessionConfirmationIfHidden();
  }

  onBranchClick(repo: NavigationRepo, branch: NavigationBranch) {
    this.navService.toggleExpand(`branch-${repo.id}-${branch.name}`);
    this.clearDeleteSessionConfirmationIfHidden();
  }

  onSessionClick(session: SessionInTree) {
    // Just navigate - SessionContainer will load the full session and open the tab
    this.router.navigate(['/sessions', session.id]);
  }

  onRefresh() {
    this.clearDeleteSessionConfirmation();
    this.navService.refreshTree();
  }

  async onHeaderDoubleClick(event: MouseEvent) {
    if (!this.macNativeChrome()) {
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest('.sidebar-brand__link, .sidebar-brand__refresh')) {
      return;
    }

    const state = await this.windowControls?.toggleMaximize();
    if (state) {
      event.preventDefault();
    }
  }

  isExpanded(key: string): boolean {
    return this.navService.isExpanded(key);
  }

  getProjectSshStats(projectId: number) {
    return this.sshProjectStats().get(projectId) ?? { active: 0, saved: 0, error: 0 };
  }

  hasProjectSsh(projectId: number) {
    return this.getProjectSshStats(projectId).saved > 0;
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent) {
    if (this.armedDeleteSessionId() === null || this.deletingSessionId() !== null) {
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest('[data-session-delete-controls="true"]')) {
      return;
    }

    this.clearDeleteSessionConfirmation();
  }

  getProjectSshBadgeClass(projectId: number) {
    const stats = this.getProjectSshStats(projectId);
    if (stats.error > 0) return 'ssh-badge-error';
    if (stats.active > 0) return 'ssh-badge-active';
    return 'ssh-badge-idle';
  }

  getProjectTodoCount(projectId: number): number {
    // Read the signal for reactivity
    this.todosService.pendingCountsSignal();
    return this.todosService.getPendingCount(projectId);
  }

  getSessionStatus(session: SessionInTree): string {
    return this.claudeStatus.getSessionStatus(session.id) ?? session.status;
  }

  getSessionActionLabel(session: SessionInTree): string | null {
    const activity = this.claudeStatus.getActivity(session.id);
    return activity.activityStatus === 'waiting' ? activity.actionLabel : null;
  }

  getSessionActivityTitle(session: SessionInTree): string {
    const activity = this.claudeStatus.getActivity(session.id);
    if (activity.actionLabel) {
      return activity.actionLabel;
    }
    if (activity.activityStatus === 'running') {
      return 'Claude is working';
    }
    if (activity.activityStatus === 'waiting') {
      return 'Claude is awaiting input';
    }
    return 'Claude is idle';
  }

  getSessionLastStateChangeLabel(session: SessionInTree): string | null {
    this.timeTick();

    const timestamp = this.getSessionLastStateChangeAt(session);
    if (timestamp === null) {
      return null;
    }

    const diffMs = Math.max(0, Date.now() - timestamp);
    const diffMinutes = Math.floor(diffMs / 60_000);

    if (diffMinutes < 1) {
      return 'now';
    }

    if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours}h`;
    }

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) {
      return `${diffDays}d`;
    }

    const diffWeeks = Math.floor(diffDays / 7);
    if (diffWeeks < 5) {
      return `${diffWeeks}w`;
    }

    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) {
      return `${diffMonths}mo`;
    }

    const diffYears = Math.floor(diffDays / 365);
    return `${diffYears}y`;
  }

  getSessionLastStateChangeTooltip(session: SessionInTree): string | null {
    const timestamp = this.getSessionLastStateChangeAt(session);
    if (timestamp === null) {
      return null;
    }

    return `Last interaction ${new Date(timestamp).toLocaleString()}`;
  }

  hasUnreviewedCompletion(session: SessionInTree): boolean {
    return this.claudeStatus.getSessionCompletion(session.id)?.hasUnreviewedCompletion
      ?? session.hasUnreviewedCompletion;
  }

  private getSessionLastStateChangeAt(session: SessionInTree): number | null {
    const value = this.claudeStatus.getSessionCompletion(session.id)?.lastStateChangeAt
      ?? session.lastStateChangeAt;

    if (!value) {
      return null;
    }

    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  /**
   * Get color for a repo (fallback if backend doesn't provide one).
   */
  getRepoColor(repoId: number): string {
    return this.colorService.getRepoColor(repoId);
  }

  private async refreshSshProjectStats(projects: NavigationProject[]) {
    if (projects.length === 0) {
      this.sshProjectStats.set(new Map());
      return;
    }

    const entries = await Promise.all(projects.map(async (project) => {
      const forwards = await this.loadProjectForwards(project.id);
      return [
        project.id,
        {
          saved: forwards.length,
          active: forwards.filter(forward => forward.status === 'active').length,
          error: forwards.filter(forward => forward.status === 'error').length,
        },
      ] as const;
    }));

    this.sshProjectStats.set(new Map(entries));
  }

  private loadProjectForwards(projectId: number): Promise<SshForward[]> {
    return new Promise((resolve) => {
      this.sshForwardsService.getByProject(projectId).subscribe({
        next: (forwards) => resolve(forwards),
        error: () => resolve([]),
      });
    });
  }

  createSessionOnBranch(repo: NavigationRepo, branch: NavigationBranch) {
    if (this.openingWorktreeBranchKey() !== null) {
      return;
    }

    if (branch.hasWorktree) {
      // Branch has worktree - create session directly
      this.sessionsService.create({
        repoId: repo.id,
        branchName: branch.name,
        worktreePath: branch.worktreePath!,
      }).subscribe({
        next: (session) => {
          this.navService.refreshTree();
          this.navService.openSession(session.id);
        },
        error: (err) => {
          const msg = err?.error?.message || 'Unknown error';
          toast.error(`Could not create session. ${msg}`);
        },
      });
    } else {
      // Branch has no worktree - prompt worktree creation first
      this.openCreateWorktreeSheet(repo, branch.name, true);
    }
  }

  openCreateWorktree(repo: NavigationRepo, branch: NavigationBranch) {
    this.openCreateWorktreeSheet(repo, branch.name, false);
  }

  isOpeningWorktree(repo: NavigationRepo, branch: NavigationBranch): boolean {
    return this.openingWorktreeBranchKey() === this.getWorktreeBranchKey(repo.id, branch.name);
  }

  async openInCursor(repo: NavigationRepo, branch: NavigationBranch) {
    if (!branch.worktreePath) return;

    const snapshot = this.onboardingState.readSnapshot();
    const activeServer = snapshot.mode === 'ssh' && snapshot.remoteConnectionReady
      ? this.onboardingState.getActiveServer(snapshot)
      : null;

    if (activeServer) {
      this.cursorService.saveSettings({
        mode: 'remote',
        sshHost: activeServer.sshHost,
        sshUser: activeServer.sshUser ?? undefined,
      });
    } else {
      this.cursorService.saveSettings({ mode: 'local' });
    }

    const result = await this.cursorService.open(branch.worktreePath);
    if (!result.ok) {
      toast.error(result.error || 'Could not open Cursor');
    }
  }

  openDeleteWorktree(repo: NavigationRepo, branch: NavigationBranch) {
    this.deleteWorktreeRepoId.set(repo.id);
    this.deleteWorktreePath.set(branch.worktreePath!);
    this.deleteWorktreeBranch.set(branch.name);
    this.deleteWorktreeDialogRef.open();
  }

  openRemoveFromProject(repo: NavigationRepo, branch: NavigationBranch) {
    this.removeFromProjectRepoId.set(repo.id);
    this.removeFromProjectPath.set(branch.worktreePath!);
    this.removeFromProjectBranch.set(branch.name);
    this.removeFromProjectDialogRef.open();
  }

  confirmRemoveFromProject() {
    this.removingFromProject.set(true);
    const worktreePath = this.removeFromProjectPath();

    this.worktreesService.removeFromProject(
      this.removeFromProjectRepoId(),
      worktreePath,
    ).subscribe({
      next: () => {
        this.handleWorktreeSessionsRemoved(
          worktreePath,
          'Worktree removed from project',
        );
        this.removingFromProject.set(false);
        this.removeFromProjectDialogRef.close();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not remove worktree from project. ${msg}`);
        this.removingFromProject.set(false);
      },
    });
  }

  confirmDeleteWorktree() {
    this.deleting.set(true);
    const worktreePath = this.deleteWorktreePath();
    this.worktreesService.remove(this.deleteWorktreeRepoId(), this.deleteWorktreePath()).subscribe({
      next: () => {
        this.handleWorktreeSessionsRemoved(worktreePath, 'Worktree deleted');
        this.deleting.set(false);
        this.deleteWorktreeDialogRef.close();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not delete worktree. ${msg}`);
        this.deleting.set(false);
      },
    });
  }

  private handleWorktreeSessionsRemoved(worktreePath: string, successMessage: string) {
    toast.success(successMessage);

    const openTabs = this.tabService.getTabsByWorktree(worktreePath);
    const activeWasInRemovedWorktree = openTabs.some(
      tab => tab.sessionId === this.activeSessionId(),
    );

    for (const tab of openTabs) {
      this.tabService.closeTab(tab.sessionId);
    }

    if (openTabs.length > 0) {
      this.vscodeWebState.destroyIframe(
        buildVSCodeIframeKey(openTabs[0].projectId, worktreePath),
      );
    }

    if (activeWasInRemovedWorktree) {
      const newActiveId = this.tabService.activeSessionId();
      if (newActiveId) {
        this.router.navigate(['/sessions', newActiveId], { replaceUrl: true });
      } else {
        this.router.navigate(['/projects']);
      }
    }

    this.navService.refreshTree();
  }

  startEditSessionTitle(sessionId: number, currentName: string, event: Event) {
    event.stopPropagation();
    this.editingSessionTitleId.set(sessionId);
    setTimeout(() => {
      const input = this.sessionTitleInputRef?.nativeElement;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  saveSessionTitle(sessionId: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();

    if (!name) {
      this.cancelEditSessionTitle();
      return;
    }

    this.sessionsService.update(sessionId, { name }).subscribe({
      next: () => {
        this.tabService.updateTabName(sessionId, name);
        this.navService.refreshTree();
        this.editingSessionTitleId.set(null);
      },
      error: () => {
        toast.error('Could not update session title');
        this.cancelEditSessionTitle();
      },
    });
  }

  cancelEditSessionTitle() {
    this.editingSessionTitleId.set(null);
  }

  armDeleteSession(session: SessionInTree, event: Event) {
    event.stopPropagation();
    if (this.deletingSessionId() !== null || this.armedDeleteSessionId() === session.id) {
      return;
    }

    this.clearSessionDeleteTimers();
    this.armedDeleteSessionId.set(session.id);
    this.deleteSessionConfirmEnabled.set(false);

    this.sessionDeleteEnableTimer = window.setTimeout(() => {
      if (this.armedDeleteSessionId() === session.id && this.deletingSessionId() === null) {
        this.deleteSessionConfirmEnabled.set(true);
      }
    }, Sidebar.SESSION_DELETE_CONFIRM_DELAY_MS);

    this.sessionDeleteDismissTimer = window.setTimeout(() => {
      if (this.armedDeleteSessionId() === session.id && this.deletingSessionId() === null) {
        this.clearDeleteSessionConfirmation();
      }
    }, Sidebar.SESSION_DELETE_AUTO_DISMISS_MS);
  }

  cancelDeleteSession(event?: Event) {
    event?.stopPropagation();
    if (this.deletingSessionId() !== null) {
      return;
    }

    this.clearDeleteSessionConfirmation();
  }

  isSessionDeleteArmed(sessionId: number): boolean {
    return this.armedDeleteSessionId() === sessionId;
  }

  isSessionDeleteConfirmReady(sessionId: number): boolean {
    return this.armedDeleteSessionId() === sessionId
      && this.deleteSessionConfirmEnabled()
      && this.deletingSessionId() === null;
  }

  isDeletingSession(sessionId: number): boolean {
    return this.deletingSessionId() === sessionId;
  }

  isArchivingSession(sessionId: number): boolean {
    return this.archivingSessionId() === sessionId;
  }

  isUnarchivingSession(sessionId: number): boolean {
    return this.unarchivingSessionId() === sessionId;
  }

  archiveSession(session: SessionInTree, event: Event) {
    event.stopPropagation();
    if (this.archivingSessionId() !== null || session.status === 'archived') {
      return;
    }

    this.clearDeleteSessionConfirmation();
    this.archivingSessionId.set(session.id);
    this.sessionsService.archive(session.id).subscribe({
      next: (updated) => {
        toast.success('Session archived');
        this.archivingSessionId.set(null);
        this.tabService.updateTabStatus(session.id, updated.status);
        this.navService.refreshTree();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not archive session. ${msg}`);
        this.archivingSessionId.set(null);
      },
    });
  }

  unarchiveSession(session: SessionInTree, event: Event) {
    event.stopPropagation();
    if (this.unarchivingSessionId() !== null || session.status !== 'archived') {
      return;
    }

    this.clearDeleteSessionConfirmation();
    this.unarchivingSessionId.set(session.id);
    this.sessionsService.unarchive(session.id).subscribe({
      next: (updated) => {
        toast.success('Session unarchived');
        this.unarchivingSessionId.set(null);
        this.tabService.updateTabStatus(session.id, updated.status);
        this.navService.refreshTree();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not unarchive session. ${msg}`);
        this.unarchivingSessionId.set(null);
      },
    });
  }

  confirmDeleteSession(session: SessionInTree, event: Event) {
    event.stopPropagation();
    if (!this.isSessionDeleteConfirmReady(session.id)) {
      return;
    }

    this.deleteSessionConfirmEnabled.set(false);
    this.performDeleteSession(session.id);
  }

  private performDeleteSession(sessionId: number) {
    const worktreePath = this.getOpenWorktreePathForSession(sessionId);
    const projectId = this.getProjectIdForSession(sessionId);
    const iframeKey = this.getIframeKeyForSession(sessionId);
    this.deletingSessionId.set(sessionId);
    this.sessionsService.delete(sessionId).subscribe({
      next: () => {
        toast.success('Session deleted');
        this.deletingSessionId.set(null);
        this.clearDeleteSessionConfirmation();
        // Close the tab if open and handle navigation
        const wasActive = this.activeSessionId() === sessionId;
        const newActiveId = this.tabService.closeTab(sessionId);
        if (iframeKey && worktreePath && projectId !== null &&
            this.tabService.tabs().every(tab => tab.worktreePath !== worktreePath || tab.projectId !== projectId)) {
          this.vscodeWebState.destroyIframe(iframeKey);
        }
        if (wasActive) {
          if (newActiveId) {
            this.router.navigate(['/sessions', newActiveId], { replaceUrl: true });
          } else {
            this.router.navigate(['/projects']);
          }
        }
        this.navService.refreshTree();
      },
      error: (err) => {
        const msg = err?.error?.message || 'Unknown error';
        toast.error(`Could not delete session. ${msg}`);
        this.deletingSessionId.set(null);
        if (this.armedDeleteSessionId() === sessionId) {
          this.deleteSessionConfirmEnabled.set(true);
        }
      },
    });
  }

  private clearDeleteSessionConfirmationIfHidden() {
    const sessionId = this.armedDeleteSessionId();
    if (sessionId === null || this.deletingSessionId() !== null) {
      return;
    }

    if (!this.isSessionVisible(sessionId)) {
      this.clearDeleteSessionConfirmation();
    }
  }

  private isSessionVisible(sessionId: number): boolean {
    for (const project of this.navService.tree()) {
      if (!this.navService.isExpanded(`project-${project.id}`)) {
        continue;
      }

      for (const repo of project.repos) {
        if (!this.navService.isExpanded(`repo-${repo.id}`)) {
          continue;
        }

        for (const branch of repo.branches) {
          if (!this.navService.isExpanded(`branch-${repo.id}-${branch.name}`)) {
            continue;
          }

          if (branch.sessions.some(session => session.id === sessionId)) {
            return true;
          }

          const archiveKey = `archive-${repo.id}-${branch.name}`;
          if (
            this.navService.isExpanded(archiveKey) &&
            branch.archivedSessions?.some(session => session.id === sessionId)
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private clearDeleteSessionConfirmation() {
    this.clearSessionDeleteTimers();
    this.armedDeleteSessionId.set(null);
    this.deleteSessionConfirmEnabled.set(false);
  }

  private clearSessionDeleteTimers() {
    if (this.sessionDeleteEnableTimer !== null) {
      window.clearTimeout(this.sessionDeleteEnableTimer);
      this.sessionDeleteEnableTimer = null;
    }

    if (this.sessionDeleteDismissTimer !== null) {
      window.clearTimeout(this.sessionDeleteDismissTimer);
      this.sessionDeleteDismissTimer = null;
    }
  }

  filterBranches(repo: NavigationRepo): Array<NavigationBranch & { isPendingCreation?: boolean }> {
    const persistedBranches = repo.branches.filter((branch) =>
      (branch.sessions && branch.sessions.length > 0)
      || ((branch.archivedSessions?.length ?? 0) > 0),
    );
    const existingNames = new Set(persistedBranches.map((branch) => branch.name));
    const pendingBranches = this.pendingWorktreeCreations.getByRepo(repo.id)
      .filter((job) => !existingNames.has(job.branchName))
      .map((job) => ({
        name: job.branchName,
        commit: '',
        label: job.branchName,
        current: false,
        isRemote: false,
        hasWorktree: false,
        worktreePath: job.worktreePath,
        sessions: [],
        archivedSessions: [],
        isPendingCreation: true,
      }));

    return [...persistedBranches, ...pendingBranches];
  }

  openBranchSearchForRepo(repo: NavigationRepo) {
    this.branchSearch.open([repo]);
  }

  onBranchSearchSelect(event: { repo: NavigationRepo; branch: BranchInfo }) {
    const { repo, branch } = event;
    if (branch.hasWorktree) {
      this.sessionsService.create({
        repoId: repo.id,
        branchName: branch.name,
        worktreePath: branch.worktreePath!,
      }).subscribe({
        next: (session) => {
          this.navService.refreshTree();
          this.navService.openSession(session.id);
        },
        error: (err) => {
          const msg = err?.error?.message || 'Unknown error';
          toast.error(`Could not create session. ${msg}`);
        },
      });
    } else {
      this.openCreateWorktreeSheet(repo, branch.name, true);
    }
  }

  private openCreateWorktreeSheet(repo: NavigationRepo, branchName: string, autoCreateSession: boolean) {
    if (this.openingWorktreeBranchKey() !== null) {
      return;
    }

    this.openingWorktreeBranchKey.set(this.getWorktreeBranchKey(repo.id, branchName));
    this.openWorktreeTimer = window.setTimeout(() => {
      this.openWorktreeTimer = null;
      try {
        this.worktreeSheet.open(repo.id, branchName, repo.path, repo.name, autoCreateSession);
      } finally {
        this.openingWorktreeBranchKey.set(null);
      }
    }, 0);
  }

  private getWorktreeBranchKey(repoId: number, branchName: string): string {
    return `${repoId}:${branchName}`;
  }

  private revealProjectRow(projectId: number) {
    const row = this.host.nativeElement.querySelector(`[data-project-row-id="${projectId}"]`) as HTMLElement | null;
    if (!row) {
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.navService.clearRevealProject(projectId);

    if (this.projectHighlightTimer !== null) {
      window.clearTimeout(this.projectHighlightTimer);
    }

    this.projectHighlightTimer = window.setTimeout(() => {
      this.navService.clearHighlightedProject(projectId);
    }, 1800);
  }
}
