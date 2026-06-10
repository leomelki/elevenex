import { Component, computed, inject, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toast } from 'ngx-sonner';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { WorktreePoolItem } from '@/shared/models/worktree.model';
import { NavigationService } from '@/shared/services/navigation.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { WorktreesService } from '@/shared/services/worktrees.service';

@Component({
  selector: 'app-worktree-sheet',
  imports: [FormsModule, TrackNativeModalDirective, PathAutocompleteInputComponent],
  templateUrl: './worktree-sheet.html',
})
export class WorktreeSheet {
  private worktreesService = inject(WorktreesService);
  private sessionsService = inject(SessionsService);
  private navigationService = inject(NavigationService);

  @ViewChild('worktreeDialog') dialogRef!: TrackNativeModalDirective;

  repoId = signal(0);
  repoPath = signal('');
  repoName = signal('');
  branchName = signal('HEAD');
  autoCreateSession = signal(false);
  pool = signal<WorktreePoolItem[]>([]);
  loading = signal(false);
  creating = signal(false);
  linkingId = signal<number | null>(null);
  createName = signal('');
  createPath = signal('');

  availableCount = computed(
    () => this.pool().filter((item) => item.owner === null).length,
  );

  open(
    repoId: number,
    branchName: string,
    repoPath: string,
    repoName: string,
    autoCreateSession: boolean = false,
  ) {
    this.repoId.set(repoId);
    this.repoPath.set(repoPath);
    this.repoName.set(repoName);
    this.branchName.set(branchName || 'HEAD');
    this.autoCreateSession.set(autoCreateSession);
    const defaultName = this.branchName() === 'HEAD' ? 'Workspace' : this.branchName();
    this.createName.set(defaultName);
    this.createPath.set(`${this.parentDir(repoPath)}/.worktrees/${repoName}/${this.slugify(defaultName)}`);
    this.pool.set([]);
    this.dialogRef.open();
    this.loadPool();
  }

  close() {
    this.dialogRef.close();
  }

  loadPool() {
    if (!this.repoId()) return;
    this.loading.set(true);
    this.worktreesService.getPoolByRepo(this.repoId()).subscribe({
      next: (items) => {
        this.pool.set(items);
        this.loading.set(false);
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not load worktrees.');
        this.loading.set(false);
      },
    });
  }

  preferredWorktreeStartDirectory() {
    const repoPath = this.repoPath();
    if (!repoPath.includes('/')) {
      return undefined;
    }

    return this.parentDir(repoPath);
  }

  createAndLink() {
    if (this.creating()) return;
    const name = this.createName().trim();
    const worktreePath = this.createPath().trim();
    const branchName = this.branchName().trim() || 'HEAD';
    if (!name || !worktreePath || !branchName) return;

    this.creating.set(true);
    this.worktreesService.createPool(this.repoId(), {
      name,
      path: worktreePath,
      startPoint: branchName,
    }).subscribe({
      next: (created) => {
        this.creating.set(false);
        this.link(created);
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not create worktree.');
        this.creating.set(false);
      },
    });
  }

  link(item: WorktreePoolItem) {
    if (this.linkingId() !== null || item.isMissing || item.isLocked) {
      return;
    }

    const confirmTakeover =
      item.owner !== null && item.owner.repoId !== this.repoId()
        ? window.confirm(
            `This worktree is linked to ${item.owner.projectName}. Take it over and archive sessions in that project?`,
          )
        : false;
    if (item.owner !== null && item.owner.repoId !== this.repoId() && !confirmTakeover) {
      return;
    }

    const confirmStash = item.isDirty
      ? window.confirm('This worktree has uncommitted changes. Stash them before linking?')
      : false;
    if (item.isDirty && !confirmStash) {
      return;
    }

    const applyPendingStash =
      item.projectWorkspace?.pendingStashStatus === 'pending'
        ? window.confirm('This project has a recorded stash for this worktree. Apply it after linking?')
        : false;

    this.linkingId.set(item.id);
    this.worktreesService.linkPool(this.repoId(), item.id, {
      workspaceName: item.projectWorkspace?.name ?? item.name,
      branchName: this.branchName().trim() || item.currentBranch || 'HEAD',
      confirmTakeover,
      confirmStash,
      applyPendingStash,
    }).subscribe({
      next: (workspace) => {
        toast.success('Worktree linked');
        this.afterLinked(workspace.id);
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not link worktree.');
        this.linkingId.set(null);
        this.loadPool();
      },
    });
  }

  updateCreatePathFromName() {
    this.createPath.set(
      `${this.parentDir(this.repoPath())}/.worktrees/${this.repoName()}/${this.slugify(this.createName())}`,
    );
  }

  ownerLabel(item: WorktreePoolItem) {
    if (!item.owner) return 'Available';
    if (item.owner.repoId === this.repoId()) return 'Linked here';
    return `Linked to ${item.owner.projectName}`;
  }

  statusLabel(item: WorktreePoolItem) {
    if (item.isMissing) return 'Missing';
    if (item.isLocked) return 'Locked';
    if (item.hasConflicts) return 'Conflicts';
    if (item.isDirty) return 'Dirty';
    return 'Clean';
  }

  canLink(item: WorktreePoolItem) {
    return !item.isMissing && !item.isLocked && this.linkingId() === null;
  }

  private afterLinked(workspaceId: number) {
    if (!this.autoCreateSession()) {
      this.finish();
      return;
    }

    this.sessionsService.create({
      repoId: this.repoId(),
      workspaceId,
    }).subscribe({
      next: (session) => {
        this.finish();
        this.navigationService.openSession(session.id);
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Worktree linked, but session could not be created.');
        this.finish();
      },
    });
  }

  private finish() {
    this.linkingId.set(null);
    this.navigationService.refreshTree();
    this.close();
  }

  private parentDir(value: string) {
    const normalized = value.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(0, index) : normalized;
  }

  private slugify(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  }
}
