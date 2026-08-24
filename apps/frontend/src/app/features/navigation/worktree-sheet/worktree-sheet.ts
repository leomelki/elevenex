import { Component, computed, inject, signal, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArchive,
  lucideArrowRightLeft,
  lucideBot,
  lucideCheck,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideFolderGit2,
  lucideGitBranch,
  lucideInfo,
  lucideLoaderCircle,
  lucideLock,
  lucidePencil,
  lucidePlus,
  lucideSearch,
  lucideSparkles,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { PathAutocompleteInputComponent } from '@/shared/components/path-autocomplete-input/path-autocomplete-input.component';
import { WorktreePoolItem } from '@/shared/models/worktree.model';
import { NavigationService } from '@/shared/services/navigation.service';
import { SessionsService } from '@/shared/services/sessions.service';
import { WorktreesService } from '@/shared/services/worktrees.service';

type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'muted';
type WorktreeCategory = 'available' | 'yours' | 'others' | 'unusable';
type WorktreeFilter = 'all' | WorktreeCategory;

interface Consequence {
  tone: Tone;
  icon: string;
  text: string;
}

interface WorktreeAssessment {
  category: WorktreeCategory;
  usable: boolean;
  /** Lower is safer / better to pick. */
  score: number;
  stateLabel: string;
  stateTone: Tone;
  stateIcon: string;
  /** Short summary shown on the row when collapsed. */
  summary: string;
  summaryTone: Tone;
  actionLabel: string;
  actionTone: 'default' | 'destructive';
  /** Consequences that the user must acknowledge before linking. */
  consequences: Consequence[];
  needsConfirm: boolean;
}

interface AssessedWorktree {
  item: WorktreePoolItem;
  assessment: WorktreeAssessment;
  recommended: boolean;
}

@Component({
  selector: 'app-worktree-sheet',
  imports: [
    FormsModule,
    NgIcon,
    TrackNativeModalDirective,
    PathAutocompleteInputComponent,
    ZardButtonComponent,
    ZardInputDirective,
  ],
  templateUrl: './worktree-sheet.html',
  viewProviders: [
    provideIcons({
      lucideArchive,
      lucideArrowRightLeft,
      lucideBot,
      lucideCheck,
      lucideCircleAlert,
      lucideCircleCheck,
      lucideFolderGit2,
      lucideGitBranch,
      lucideInfo,
      lucideLoaderCircle,
      lucideLock,
      lucidePencil,
      lucidePlus,
      lucideSearch,
      lucideSparkles,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
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
  showCreateForm = signal(false);
  createName = signal('');
  createPath = signal('');

  search = signal('');
  filter = signal<WorktreeFilter>('all');
  confirmingId = signal<number | null>(null);
  applyStashChoice = signal(true);
  renamingId = signal<number | null>(null);
  renameValue = signal('');
  renaming = signal(false);

  private assessed = computed<AssessedWorktree[]>(() => {
    const repoId = this.repoId();
    const ranked = this.pool()
      .map((item) => ({ item, assessment: this.assess(item, repoId), recommended: false }))
      .sort((a, b) => a.assessment.score - b.assessment.score || a.item.name.localeCompare(b.item.name));

    const best = ranked.find(
      (entry) =>
        !entry.item.statusLoading &&
        entry.assessment.category === 'available' &&
        entry.assessment.score <= 0,
    );
    if (best) best.recommended = true;
    return ranked;
  });

  counts = computed(() => {
    const counts = { all: 0, available: 0, yours: 0, others: 0, unusable: 0 };
    for (const { assessment } of this.assessed()) {
      counts.all += 1;
      counts[assessment.category] += 1;
    }
    return counts;
  });

  visiblePool = computed(() => {
    const filter = this.filter();
    const query = this.search().trim().toLowerCase();
    return this.assessed().filter(({ item, assessment }) => {
      if (filter !== 'all' && assessment.category !== filter) return false;
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        item.path.toLowerCase().includes(query) ||
        (item.currentBranch ?? '').toLowerCase().includes(query) ||
        (item.owner?.projectName ?? '').toLowerCase().includes(query)
      );
    });
  });

  recommended = computed(() => this.assessed().find((entry) => entry.recommended)?.item ?? null);

  availableCount = computed(() => this.counts().available);

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
    this.showCreateForm.set(false);
    this.search.set('');
    this.filter.set('all');
    this.confirmingId.set(null);
    this.renamingId.set(null);
    this.prepareCreateDefaults([]);
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
    this.worktreesService.getPoolByRepoStream(this.repoId()).subscribe({
      next: (items) => {
        this.pool.set(items);
        if (!this.showCreateForm()) {
          this.prepareCreateDefaults(items);
        }
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not load worktrees.');
        this.loading.set(false);
      },
      complete: () => {
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

  openCreateForm() {
    if (this.creating() || this.linkingId() !== null) return;
    this.prepareCreateDefaults(this.pool());
    this.confirmingId.set(null);
    this.showCreateForm.set(true);
  }

  cancelCreateForm() {
    if (this.creating()) return;
    this.showCreateForm.set(false);
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
        this.showCreateForm.set(false);
        this.link(created);
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not create worktree.');
        this.creating.set(false);
      },
    });
  }

  /**
   * Entry point for the row's primary action. When the worktree can be linked
   * without side effects it links immediately; otherwise it opens the inline
   * confirmation panel so the user can review what will happen first.
   */
  requestAction(entry: AssessedWorktree) {
    const { item, assessment } = entry;
    if (!assessment.usable || this.linkingId() !== null || this.creating()) return;

    if (this.confirmingId() === item.id) {
      this.confirmingId.set(null);
      return;
    }

    if (assessment.needsConfirm) {
      this.applyStashChoice.set(item.projectWorkspace?.pendingStashStatus === 'pending');
      this.confirmingId.set(item.id);
      return;
    }

    this.link(item);
  }

  cancelConfirm() {
    this.confirmingId.set(null);
  }

  confirmLink(item: WorktreePoolItem) {
    this.confirmingId.set(null);
    this.link(item);
  }

  link(item: WorktreePoolItem) {
    if (
      this.linkingId() !== null ||
      item.statusLoading ||
      item.isMissing ||
      item.isLocked
    ) {
      return;
    }

    const confirmTakeover = item.owner !== null && item.owner.repoId !== this.repoId();
    const confirmStash = item.isDirty;
    const applyPendingStash =
      item.projectWorkspace?.pendingStashStatus === 'pending' && this.applyStashChoice();

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

  canRename(item: WorktreePoolItem) {
    return (
      !item.statusLoading &&
      !item.isMissing &&
      !item.isLocked &&
      this.linkingId() === null &&
      !this.creating()
    );
  }

  startRename(item: WorktreePoolItem, event: Event) {
    event.stopPropagation();
    if (!this.canRename(item)) return;
    this.confirmingId.set(null);
    this.renamingId.set(item.id);
    this.renameValue.set(item.name);
  }

  cancelRename(event?: Event) {
    event?.stopPropagation();
    if (this.renaming()) return;
    this.renamingId.set(null);
    this.renameValue.set('');
  }

  saveRename(item: WorktreePoolItem, event?: Event) {
    event?.stopPropagation();
    if (this.renaming()) return;

    const name = this.renameValue().trim();
    if (!name) {
      toast.error('Worktree name is required.');
      return;
    }
    if (name === item.name) {
      this.cancelRename();
      return;
    }

    this.renaming.set(true);
    this.worktreesService.renamePool(this.repoId(), item.id, name).subscribe({
      next: (updated) => {
        this.pool.update((items) =>
          items.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
        );
        toast.success('Worktree renamed');
        this.renaming.set(false);
        this.renamingId.set(null);
        this.renameValue.set('');
      },
      error: (err) => {
        toast.error(err?.error?.message || 'Could not rename worktree.');
        this.renaming.set(false);
      },
    });
  }

  updateCreatePathFromName() {
    this.createPath.set(this.createPathForName(this.createName()));
  }

  ownerLabel(item: WorktreePoolItem) {
    if (!item.owner) return 'Available';
    if (item.owner.repoId === this.repoId()) return 'Linked here';
    return `Used by ${item.owner.projectName}`;
  }

  agentCountLabel(count: number) {
    return count === 1 ? '1 agent running' : `${count} agents running`;
  }

  chipClass(tone: Tone) {
    switch (tone) {
      case 'success':
        return 'border-success/40 bg-success/10 text-success';
      case 'warning':
        return 'border-warning/40 bg-warning/10 text-warning';
      case 'destructive':
        return 'border-destructive/40 bg-destructive/10 text-destructive';
      case 'info':
        return 'border-primary/40 bg-primary/10 text-primary';
      default:
        return 'border-border bg-muted text-muted-foreground';
    }
  }

  toneTextClass(tone: Tone) {
    switch (tone) {
      case 'success':
        return 'text-success';
      case 'warning':
        return 'text-warning';
      case 'destructive':
        return 'text-destructive';
      case 'info':
        return 'text-primary';
      default:
        return 'text-muted-foreground';
    }
  }

  toneIcon(tone: Tone) {
    switch (tone) {
      case 'success':
        return 'lucideCircleCheck';
      case 'info':
        return 'lucideInfo';
      case 'destructive':
        return 'lucideCircleAlert';
      default:
        return 'lucideTriangleAlert';
    }
  }

  filterCount(filter: WorktreeFilter) {
    return filter === 'all' ? this.counts().all : this.counts()[filter];
  }

  private assess(item: WorktreePoolItem, repoId: number): WorktreeAssessment {
    const consequences: Consequence[] = [];
    const isTakeover = item.owner !== null && item.owner.repoId !== repoId;
    const isYours = item.owner !== null && item.owner.repoId === repoId;
    const hasPendingStash = item.projectWorkspace?.pendingStashStatus === 'pending';

    if (item.statusLoading) {
      const category: WorktreeCategory = item.owner === null
        ? 'available'
        : isYours
          ? 'yours'
          : 'others';
      return {
        category,
        usable: false,
        score: item.owner === null ? 0 : isYours ? 5 : 40,
        stateLabel: 'Checking status',
        stateTone: 'muted',
        stateIcon: 'lucideLoaderCircle',
        summary: 'Checking this worktree for changes and conflicts…',
        summaryTone: 'muted',
        actionLabel: 'Checking…',
        actionTone: 'default',
        consequences: [],
        needsConfirm: false,
      };
    }

    // Unusable states block linking entirely.
    if (item.isMissing) {
      consequences.push({
        tone: 'destructive',
        icon: 'lucideCircleAlert',
        text: 'The folder is missing on disk and cannot be linked until it is restored.',
      });
    }
    if (item.isLocked) {
      consequences.push({
        tone: 'destructive',
        icon: 'lucideLock',
        text: item.lockReason ? `Locked by git: ${item.lockReason}` : 'Locked by git and cannot be modified.',
      });
    }

    const usable = !item.isMissing && !item.isLocked;

    if (item.hasConflicts) {
      consequences.push({
        tone: 'destructive',
        icon: 'lucideTriangleAlert',
        text: 'Has unresolved merge conflicts — resolve them before relying on this worktree.',
      });
    }
    if (isTakeover) {
      consequences.push({
        tone: 'warning',
        icon: 'lucideArrowRightLeft',
        text: `Currently used by ${item.owner!.projectName}. Linking it here will archive that project's sessions.`,
      });
      if (item.runningAgentCount > 0) {
        consequences.push({
          tone: 'destructive',
          icon: 'lucideBot',
          text: `${this.agentCountLabel(item.runningAgentCount)} in that project will be stopped.`,
        });
      }
    }
    if (item.isDirty) {
      consequences.push({
        tone: 'warning',
        icon: 'lucideArchive',
        text: 'Uncommitted changes will be stashed automatically before linking.',
      });
    }
    if (hasPendingStash) {
      consequences.push({
        tone: 'info',
        icon: 'lucideArchive',
        text: 'A stash saved by this project can be restored after linking.',
      });
    }

    // Category + score (lower = safer / better recommendation).
    let category: WorktreeCategory;
    let score = 0;
    if (!usable) {
      category = 'unusable';
      score = 1000 + (item.isMissing ? 100 : 0);
    } else if (item.owner === null) {
      category = 'available';
    } else if (isYours) {
      category = 'yours';
      score = 5;
    } else {
      category = 'others';
      score = 40 + item.runningAgentCount * 10;
    }
    if (item.hasConflicts) score += 200;
    if (item.isDirty) score += 15;

    const stateLabel = item.isMissing
      ? 'Missing'
      : item.isLocked
        ? 'Locked'
        : item.hasConflicts
          ? 'Conflicts'
          : item.isDirty
            ? 'Uncommitted changes'
            : 'Clean';
    const stateTone: Tone = item.isMissing || item.isLocked || item.hasConflicts
      ? 'destructive'
      : item.isDirty
        ? 'warning'
        : 'success';
    const stateIcon = stateTone === 'success'
      ? 'lucideCircleCheck'
      : stateTone === 'warning'
        ? 'lucideTriangleAlert'
        : 'lucideCircleAlert';

    let actionLabel: string;
    let actionTone: 'default' | 'destructive' = 'default';
    if (!usable) {
      actionLabel = 'Unavailable';
    } else if (isTakeover) {
      actionLabel = 'Steal worktree';
      actionTone = item.runningAgentCount > 0 ? 'destructive' : 'default';
    } else if (item.projectWorkspace?.linkStatus === 'unlinked') {
      actionLabel = 'Relink';
    } else if (isYours) {
      actionLabel = 'Use';
    } else {
      actionLabel = 'Use worktree';
    }

    // Short collapsed summary (the single most important thing to know).
    const primary = consequences[0];
    const summary = primary
      ? primary.text
      : 'Ready to use — linking has no side effects.';
    const summaryTone: Tone = primary ? primary.tone : 'success';

    return {
      category,
      usable,
      score,
      stateLabel,
      stateTone,
      stateIcon,
      summary,
      summaryTone,
      actionLabel,
      actionTone,
      consequences,
      needsConfirm: usable && (isTakeover || item.isDirty || hasPendingStash),
    };
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

  private prepareCreateDefaults(items: WorktreePoolItem[]) {
    const defaultName = this.nextDefaultWorktreeName(items);
    this.createName.set(defaultName);
    this.createPath.set(this.createPathForName(defaultName));
  }

  private createPathForName(name: string) {
    return `${this.parentDir(this.repoPath())}/.worktrees/${this.repoName()}/${this.slugify(name)}`;
  }

  private nextDefaultWorktreeName(items: WorktreePoolItem[]) {
    const baseName = this.repoName().trim() || 'worktree';
    const existingNames = new Set(
      items.map((item) => item.name.trim().toLowerCase()),
    );
    const existingPaths = new Set(
      items.map((item) => this.normalizePath(item.path)),
    );

    let index = 1;
    while (true) {
      const name = `${baseName} ${index}`;
      if (
        !existingNames.has(name.toLowerCase()) &&
        !existingPaths.has(this.normalizePath(this.createPathForName(name)))
      ) {
        return name;
      }
      index += 1;
    }
  }

  private parentDir(value: string) {
    const normalized = value.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(0, index) : normalized;
  }

  private normalizePath(value: string) {
    return value.replace(/\\/g, '/').toLowerCase();
  }

  private slugify(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  }
}
