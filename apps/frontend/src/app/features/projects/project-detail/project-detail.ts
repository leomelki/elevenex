import { Component, inject, OnInit, OnDestroy, signal, viewChild, ElementRef, computed } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideTrash2, lucideGitBranch, lucideFileText, lucideCheckSquare, lucidePlay, lucideSquare, lucidePlus, lucideServer, lucideGlobe, lucideShield, lucideX } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { Subscription, firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { ZardSkeletonComponent } from '@/shared/components/skeleton';
import { Project } from '@/shared/models/project.model';
import { Repo } from '@/shared/models/repo.model';
import { SshForward } from '@/shared/models/ssh-forward.model';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { CreateSshForwardPayload, SshForwardDefaults, SshForwardsService } from '@/shared/services/ssh-forwards.service';
import { HttpErrorResponse } from '@angular/common/http';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { BrowserIsolationConfig } from '@/shared/models/browser-isolation.model';
import { getElectronBrowserApi } from '@/shared/runtime/electron-browser';
import { ScratchpadPanelComponent } from '@/features/productivity/scratchpad-panel/scratchpad-panel';
import { TodoPanelComponent } from '@/features/productivity/todo-panel/todo-panel';
import { GithubService } from '@/shared/services/github.service';
import { GitHubCapabilities } from '@/shared/models/github.model';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-project-detail',
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    PathAutocompleteInputComponent,
    ZardSkeletonComponent,
    ScratchpadPanelComponent,
    TodoPanelComponent,
    TrackNativeModalDirective,
  ],
  templateUrl: './project-detail.html',
  styleUrl: './project-detail.scss',
  host: { class: 'block flex-1 overflow-y-auto p-8' },
  viewProviders: [provideIcons({ lucideArrowLeft, lucideTrash2, lucideGitBranch, lucideFileText, lucideCheckSquare, lucidePlay, lucideSquare, lucidePlus, lucideServer, lucideGlobe, lucideShield, lucideX })],
})
export class ProjectDetail implements OnInit, OnDestroy {
  private projectsService = inject(ProjectsService);
  private reposService = inject(ReposService);
  private navigationService = inject(NavigationService);
  private sshForwardsService = inject(SshForwardsService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private productivityState = inject(ProductivityStateService);
  private browserIsolationService = inject(BrowserIsolationService);
  private githubService = inject(GithubService);
  private onboardingState = inject(OnboardingStateService);

  project = signal<Project | null>(null);
  repos = signal<Repo[]>([]);
  sshForwards = signal<SshForward[]>([]);
  loading = signal(true);
  sshForwardsLoading = signal(true);
  sshForwardingSupported = signal(false);

  showAddRepoDialog = signal(false);
  showAddSshForwardDialog = signal(false);
  showDeleteProjectDialog = signal(false);
  showRemoveRepoDialog = signal<Repo | null>(null);
  showRemoveSshForwardDialog = signal<SshForward | null>(null);
  expandedForwardDebugId = signal<number | null>(null);

  addingRepo = signal(false);
  addingSshForward = signal(false);
  deletingProject = signal(false);
  removingRepo = signal(false);
  removingSshForward = signal(false);
  newRepoPath = signal('');
  repoContextRootDrafts = signal<Record<number, string>>({});
  savingRepoContextRootId = signal<number | null>(null);
  togglingForwardId = signal<number | null>(null);
  quickForwardPort = signal(3000);
  showAdvancedSshSettings = signal(false);
  sshForwardDefaults = signal<SshForwardDefaults | null>(null);
  usingActiveServerDefaults = signal(false);

  browserIsolationConfig = signal<BrowserIsolationConfig | null>(null);
  browserIsolationLoading = signal(true);
  githubCapabilities = signal<GitHubCapabilities | null>(null);
  githubDiagnosticsLoading = signal(true);
  newGlobInput = signal('');
  savingBrowserIsolation = signal(false);

  newSshForward = signal<CreateSshForwardPayload>({
    name: '',
    sshHost: '',
    sshUser: '',
    sshPort: 22,
    bindAddress: '127.0.0.1',
    localPort: 3001,
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    startImmediately: true,
  });

  // Panel state
  showScratchpad = computed(() => {
    const proj = this.project();
    return proj ? this.productivityState.getPanelState(proj.id).scratchpad : false;
  });
  showTodos = computed(() => {
    const proj = this.project();
    return proj ? this.productivityState.getPanelState(proj.id).todos : false;
  });

  private addRepoDialogRef = viewChild<TrackNativeModalDirective>('addRepoDialog');
  private addSshForwardDialogRef = viewChild<TrackNativeModalDirective>('addSshForwardDialog');
  private deleteProjectDialogRef = viewChild<TrackNativeModalDirective>('deleteProjectDialog');
  private removeRepoDialogRef = viewChild<TrackNativeModalDirective>('removeRepoDialog');
  private removeSshForwardDialogRef = viewChild<TrackNativeModalDirective>('removeSshForwardDialog');
  private sshRefreshTimer: number | null = null;
  private routeSubscription: Subscription | null = null;

  activeForwardCount = computed(() =>
    this.sshForwards().filter(forward => forward.status === 'active').length,
  );

  forwardIssuesCount = computed(() =>
    this.sshForwards().filter(forward => forward.status === 'error').length,
  );

  ngOnInit() {
    this.routeSubscription = this.route.paramMap.subscribe((paramMap) => {
      const id = Number(paramMap.get('id'));
      if (!Number.isFinite(id) || id <= 0) {
        this.loading.set(false);
        this.sshForwardsLoading.set(false);
        return;
      }

      this.loadProject(id);
    });
  }

  ngOnDestroy() {
    this.routeSubscription?.unsubscribe();
    if (this.sshRefreshTimer !== null) {
      window.clearInterval(this.sshRefreshTimer);
    }
  }

  goBack() {
    this.router.navigate(['/projects']);
  }

  // Add repo dialog
  openAddRepoDialog() {
    this.newRepoPath.set('');
    this.showAddRepoDialog.set(true);
    setTimeout(() => this.addRepoDialogRef()?.open());
  }

  closeAddRepoDialog() {
    this.addRepoDialogRef()?.close();
    this.showAddRepoDialog.set(false);
    this.newRepoPath.set('');
  }

  preferredNewRepoStartDirectory() {
    const repoPath = this.newRepoPath().trim();
    if (repoPath.startsWith('~/')) {
      return '~';
    }

    if (!repoPath.includes('/')) {
      return undefined;
    }

    return repoPath.slice(0, repoPath.lastIndexOf('/')) || '/';
  }

  openAddSshForwardDialog() {
    const snapshot = this.onboardingState.readSnapshot();
    const activeServer = snapshot.remoteConnectionReady
      ? this.onboardingState.getActiveServer(snapshot)
      : null;

    let defaults: SshForwardDefaults | null;
    let fromActiveServer = false;

    if (activeServer) {
      defaults = {
        sshHost: activeServer.sshHost,
        sshUser: activeServer.sshUser ?? undefined,
        sshPort: activeServer.sshPort,
        bindAddress: '127.0.0.1',
        remoteHost: '127.0.0.1',
        startImmediately: true,
      };
      fromActiveServer = true;
    } else {
      defaults = this.sshForwardsService.getLastDefaults();
    }

    const suggestedPort = this.suggestLocalPort();
    this.sshForwardDefaults.set(defaults);
    this.usingActiveServerDefaults.set(fromActiveServer);
    this.quickForwardPort.set(suggestedPort);
    this.showAdvancedSshSettings.set(!defaults);
    this.newSshForward.set({
      name: '',
      sshHost: defaults?.sshHost ?? '',
      sshUser: defaults?.sshUser ?? '',
      sshPort: defaults?.sshPort ?? 22,
      bindAddress: defaults?.bindAddress ?? '127.0.0.1',
      localPort: suggestedPort,
      remoteHost: defaults?.remoteHost ?? '127.0.0.1',
      remotePort: suggestedPort,
      startImmediately: defaults?.startImmediately ?? true,
    });
    this.showAddSshForwardDialog.set(true);
    setTimeout(() => this.addSshForwardDialogRef()?.open());
  }

  closeAddSshForwardDialog() {
    this.addSshForwardDialogRef()?.close();
    this.showAddSshForwardDialog.set(false);
    this.showAdvancedSshSettings.set(false);
  }

  addRepo() {
    const path = this.newRepoPath().trim();
    if (!path) return;

    const projectId = this.project()?.id;
    if (!projectId) return;

    this.addingRepo.set(true);
    this.reposService.add(projectId, path).subscribe({
      next: (repo) => {
        this.repos.update(list => [...list, repo]);
        this.repoContextRootDrafts.update(current => ({
          ...current,
          [repo.id]: repo.preferredContextRootRef ?? '',
        }));
        this.navigationService.refreshTree();
        this.navigationService.revealProject(projectId);
        toast.success('Repository added');
        this.closeAddRepoDialog();
        this.addingRepo.set(false);
      },
      error: (err: HttpErrorResponse) => {
        if (err.status === 400) {
          toast.error('Folder not found. Verify the path exists and points to a git repository.');
        } else if (err.status === 409) {
          toast.error('This folder is already added to this project.');
        } else {
          toast.error('Could not add repository.');
        }
        this.addingRepo.set(false);
      },
    });
  }

  updateSshForwardField<K extends keyof CreateSshForwardPayload>(key: K, value: CreateSshForwardPayload[K]) {
    this.newSshForward.update(current => ({ ...current, [key]: value }));
  }

  updateRepoContextRootDraft(repoId: number, value: string) {
    this.repoContextRootDrafts.update(current => ({ ...current, [repoId]: value }));
  }

  async saveRepoContextRoot(repo: Repo) {
    this.savingRepoContextRootId.set(repo.id);
    try {
      const updated = await firstValueFrom(
        this.reposService.updatePreferredContextRootRef(
          repo.id,
          this.repoContextRootDrafts()[repo.id]?.trim() || null,
        ),
      );
      this.repos.update(items => items.map(item => item.id === repo.id ? updated : item));
      this.repoContextRootDrafts.update(current => ({
        ...current,
        [repo.id]: updated.preferredContextRootRef ?? '',
      }));
      toast.success('Default context root updated');
    } catch {
      toast.error('Could not update the default context root.');
    } finally {
      this.savingRepoContextRootId.set(null);
    }
  }

  addSshForward() {
    const projectId = this.project()?.id;
    const payload = this.buildSshForwardPayload();
    if (!projectId || !payload || !this.canCreateSshForward()) return;

    this.addingSshForward.set(true);
    this.sshForwardsService.create(projectId, {
      ...payload,
      name: payload.name.trim(),
      sshHost: payload.sshHost.trim(),
      sshUser: payload.sshUser?.trim() || undefined,
      bindAddress: payload.bindAddress.trim(),
      remoteHost: payload.remoteHost.trim(),
    }).subscribe({
      next: (forward) => {
        this.sshForwards.update(list => [forward, ...list]);
        toast.success(forward.status === 'active' ? 'SSH forward started' : 'SSH forward saved');
        this.closeAddSshForwardDialog();
        this.addingSshForward.set(false);
      },
      error: (err: unknown) => {
        toast.error(this.getErrorMessage(err, 'Could not create SSH forward.'));
        this.addingSshForward.set(false);
      },
    });
  }

  // Delete project dialog
  openDeleteProjectDialog() {
    this.showDeleteProjectDialog.set(true);
    setTimeout(() => this.deleteProjectDialogRef()?.open());
  }

  closeDeleteProjectDialog() {
    this.deleteProjectDialogRef()?.close();
    this.showDeleteProjectDialog.set(false);
  }

  deleteProject() {
    const projectId = this.project()?.id;
    if (!projectId) return;

    this.deletingProject.set(true);
    this.projectsService.delete(projectId).subscribe({
      next: () => {
        toast.success('Project deleted');
        this.router.navigate(['/projects']);
      },
      error: () => {
        toast.error('Could not delete. Please try again.');
        this.deletingProject.set(false);
      },
    });
  }

  // Remove repo dialog
  openRemoveRepoDialog(repo: Repo) {
    this.showRemoveRepoDialog.set(repo);
    setTimeout(() => this.removeRepoDialogRef()?.open());
  }

  closeRemoveRepoDialog() {
    this.removeRepoDialogRef()?.close();
    this.showRemoveRepoDialog.set(null);
  }

  openRemoveSshForwardDialog(forward: SshForward) {
    this.showRemoveSshForwardDialog.set(forward);
    setTimeout(() => this.removeSshForwardDialogRef()?.open());
  }

  toggleForwardDebug(forwardId: number) {
    this.expandedForwardDebugId.update(current => current === forwardId ? null : forwardId);
  }

  isForwardDebugOpen(forwardId: number) {
    return this.expandedForwardDebugId() === forwardId;
  }

  closeRemoveSshForwardDialog() {
    this.removeSshForwardDialogRef()?.close();
    this.showRemoveSshForwardDialog.set(null);
  }

  removeRepo() {
    const repo = this.showRemoveRepoDialog();
    if (!repo) return;

    this.removingRepo.set(true);
    this.reposService.remove(repo.id).subscribe({
      next: () => {
        this.repos.update(list => list.filter(r => r.id !== repo.id));
        toast.success('Repository removed');
        this.closeRemoveRepoDialog();
        this.removingRepo.set(false);
      },
      error: () => {
        toast.error('Could not delete. Please try again.');
        this.removingRepo.set(false);
      },
    });
  }

  removeSshForward() {
    const forward = this.showRemoveSshForwardDialog();
    if (!forward) return;

    this.removingSshForward.set(true);
    this.sshForwardsService.remove(forward.id).subscribe({
      next: () => {
        this.sshForwards.update(list => list.filter(item => item.id !== forward.id));
        toast.success('SSH forward removed');
        this.closeRemoveSshForwardDialog();
        this.removingSshForward.set(false);
      },
      error: () => {
        toast.error('Could not remove SSH forward.');
        this.removingSshForward.set(false);
      },
    });
  }

  toggleSshForward(forward: SshForward) {
    const action = forward.status === 'active' || forward.status === 'connecting'
      ? this.sshForwardsService.stop(forward.id)
      : this.sshForwardsService.start(forward.id);

    this.togglingForwardId.set(forward.id);
    action.subscribe({
      next: (updatedForward) => {
        this.replaceSshForward(updatedForward);
        if (updatedForward.status === 'inactive') {
          toast.success('SSH forward stopped');
        }
        this.togglingForwardId.set(null);
      },
      error: (err: unknown) => {
        toast.error(this.getErrorMessage(err, 'Could not update SSH forward.'));
        this.togglingForwardId.set(null);
      },
    });
  }

  // Panel toggles
  toggleScratchpad() {
    const proj = this.project();
    if (proj) {
      this.productivityState.togglePanel(proj.id, 'scratchpad');
    }
  }

  toggleTodos() {
    const proj = this.project();
    if (proj) {
      this.productivityState.togglePanel(proj.id, 'todos');
    }
  }

  canCreateSshForward() {
    const value = this.buildSshForwardPayload();
    if (!value) {
      return false;
    }

    return Boolean(
      value.name.trim()
      && value.sshHost.trim()
      && value.bindAddress.trim()
      && value.remoteHost.trim()
      && Number(value.localPort) > 0
      && Number(value.remotePort) > 0
      && Number(value.sshPort) > 0,
    );
  }

  isForwardBusy(forward: SshForward) {
    return this.togglingForwardId() === forward.id || forward.status === 'stopping';
  }

  canToggleForwarding() {
    return this.sshForwardingSupported();
  }

  statusLabel(status: SshForward['status']) {
    switch (status) {
      case 'active':
        return 'Live';
      case 'connecting':
        return 'Starting';
      case 'stopping':
        return 'Stopping';
      case 'error':
        return 'Needs attention';
      default:
        return 'Stopped';
    }
  }

  statusClass(status: SshForward['status']) {
    return `status-${status}`;
  }

  asText(value: string | number) {
    return `${value}`;
  }

  get effectiveQuickSummary() {
    const value = this.newSshForward();
    const sshTarget = value.sshUser?.trim()
      ? `${value.sshUser!.trim()}@${value.sshHost.trim()}:${value.sshPort}`
      : `${value.sshHost.trim()}:${value.sshPort}`;
    return `${sshTarget} | bind ${value.bindAddress.trim()} | remote host ${value.remoteHost.trim()}`;
  }

  toggleAdvancedSshSettings() {
    this.showAdvancedSshSettings.update(value => !value);
  }

  setBrowserIsolationMode(mode: 'shared' | 'isolated') {
    const config = this.browserIsolationConfig();
    if (!config || config.mode === mode) return;
    const projectId = this.project()?.id;
    if (!projectId) return;

    this.savingBrowserIsolation.set(true);
    this.browserIsolationService.save(projectId, mode, config.sharedGlobs).subscribe({
      next: (updated) => {
        this.browserIsolationConfig.set(updated);
        this.savingBrowserIsolation.set(false);
        const api = getElectronBrowserApi();
        void api?.updateIsolationConfig({ projectId, mode: updated.mode, sharedGlobs: updated.sharedGlobs });
        toast.success(mode === 'isolated' ? 'Browser switched to isolated routing' : 'Browser switched to shared routing');
      },
      error: () => {
        this.savingBrowserIsolation.set(false);
        toast.error('Could not update browser isolation setting.');
      },
    });
  }

  addSharedGlob() {
    const glob = this.newGlobInput().trim();
    if (!glob) return;
    const config = this.browserIsolationConfig();
    const projectId = this.project()?.id;
    if (!config || !projectId) return;
    if (config.sharedGlobs.includes(glob)) {
      toast.error('This pattern is already in the list.');
      return;
    }

    const updated = [...config.sharedGlobs, glob];
    this.browserIsolationService.save(projectId, config.mode, updated).subscribe({
      next: (saved) => {
        this.browserIsolationConfig.set(saved);
        this.newGlobInput.set('');
        const api = getElectronBrowserApi();
        void api?.updateIsolationConfig({ projectId, mode: saved.mode, sharedGlobs: saved.sharedGlobs });
      },
      error: () => toast.error('Could not save pattern.'),
    });
  }

  removeSharedGlob(index: number) {
    const config = this.browserIsolationConfig();
    const projectId = this.project()?.id;
    if (!config || !projectId) return;

    const updated = config.sharedGlobs.filter((_, i) => i !== index);
    this.browserIsolationService.save(projectId, config.mode, updated).subscribe({
      next: (saved) => {
        this.browserIsolationConfig.set(saved);
        const api = getElectronBrowserApi();
        void api?.updateIsolationConfig({ projectId, mode: saved.mode, sharedGlobs: saved.sharedGlobs });
      },
      error: () => toast.error('Could not remove pattern.'),
    });
  }

  updateQuickForwardPort(rawValue: string) {
    const port = Number(rawValue);
    this.quickForwardPort.set(port);
    this.newSshForward.update(current => ({
      ...current,
      localPort: port,
      remotePort: port,
    }));
  }

  private replaceSshForward(updatedForward: SshForward) {
    this.sshForwards.update(list => list.map(item => item.id === updatedForward.id ? updatedForward : item));
  }

  private suggestLocalPort() {
    const ports = this.sshForwards().map(forward => forward.localPort);
    let candidate = 3000;
    while (ports.includes(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

  private loadProject(projectId: number) {
    this.resetProjectViewState();

    this.projectsService.getOne(projectId).subscribe({
      next: (project) => {
        this.project.set(project);
      },
      error: () => {
        this.loading.set(false);
      },
    });

    this.reposService.getByProject(projectId).subscribe({
      next: (repos) => {
        this.repos.set(repos);
        this.repoContextRootDrafts.set(
          Object.fromEntries(repos.map(repo => [repo.id, repo.preferredContextRootRef ?? ''])),
        );
        void this.loadGithubDiagnostics(repos[0]?.path ?? null);
        this.loading.set(false);
      },
      error: () => {
        this.githubDiagnosticsLoading.set(false);
        this.loading.set(false);
      },
    });

    void this.loadSshForwards(projectId);
    this.loadBrowserIsolation(projectId);
  }

  private resetProjectViewState() {
    this.loading.set(true);
    this.sshForwardsLoading.set(true);
    this.project.set(null);
    this.repos.set([]);
    this.repoContextRootDrafts.set({});
    this.savingRepoContextRootId.set(null);
    this.sshForwards.set([]);
    this.expandedForwardDebugId.set(null);
    this.togglingForwardId.set(null);
    this.showRemoveRepoDialog.set(null);
    this.showRemoveSshForwardDialog.set(null);
    this.browserIsolationConfig.set(null);
    this.browserIsolationLoading.set(true);
    this.githubCapabilities.set(null);
    this.githubDiagnosticsLoading.set(true);
    this.newGlobInput.set('');

    if (this.sshRefreshTimer !== null) {
      window.clearInterval(this.sshRefreshTimer);
      this.sshRefreshTimer = null;
    }
  }

  private async loadSshForwards(projectId: number) {
    this.sshForwardingSupported.set(await this.sshForwardsService.isSupported());

    this.sshForwardsService.getByProject(projectId).subscribe({
      next: (forwards) => {
        this.sshForwards.set(forwards);
        this.sshForwardsLoading.set(false);
      },
      error: (err: unknown) => {
        toast.error(this.getErrorMessage(err, 'Could not load SSH forwards.'));
        this.sshForwardsLoading.set(false);
      },
    });

    if (this.sshForwardingSupported() && this.sshRefreshTimer === null) {
      this.sshRefreshTimer = window.setInterval(() => {
        this.sshForwardsService.getByProject(projectId).subscribe({
          next: (forwards) => this.sshForwards.set(forwards),
        });
      }, 3000);
    }
  }

  private loadBrowserIsolation(projectId: number) {
    this.browserIsolationService.get(projectId).subscribe({
      next: (config) => {
        this.browserIsolationConfig.set(config);
        this.browserIsolationLoading.set(false);
      },
      error: () => {
        this.browserIsolationConfig.set({ projectId, mode: 'shared', sharedGlobs: [] });
        this.browserIsolationLoading.set(false);
      },
    });
  }

  private async loadGithubDiagnostics(worktreePath: string | null) {
    if (!worktreePath) {
      this.githubCapabilities.set(null);
      this.githubDiagnosticsLoading.set(false);
      return;
    }

    try {
      const capabilities = await firstValueFrom(this.githubService.getCapabilities(worktreePath, true));
      this.githubCapabilities.set(capabilities);
    } catch {
      this.githubCapabilities.set(null);
    } finally {
      this.githubDiagnosticsLoading.set(false);
    }
  }

  private getErrorMessage(err: unknown, fallback: string) {
    if (err instanceof HttpErrorResponse) {
      return err.error?.message || fallback;
    }
    if (err instanceof Error) {
      return err.message || fallback;
    }
    return fallback;
  }

  private buildSshForwardPayload(): CreateSshForwardPayload | null {
    const base = this.newSshForward();
    const port = this.showAdvancedSshSettings() ? base.localPort : this.quickForwardPort();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }

    return {
      ...base,
      name: base.name.trim() || `Port ${port}`,
      localPort: port,
      remotePort: this.showAdvancedSshSettings() ? base.remotePort : port,
    };
  }
}
