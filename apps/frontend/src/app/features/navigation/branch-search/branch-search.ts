import {
  Component,
  signal,
  output,
  ViewChild,
  ElementRef,
  inject,
  computed,
  effect,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideSearch,
  lucideGitBranch,
  lucideCircleDashed,
  lucideLoader2,
  lucidePlus,
  lucideArrowLeft,
  lucideGlobe2,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { BranchesService } from '../../../shared/services/branches.service';
import { BranchInfo } from '../../../shared/models/branch.model';
import { NavigationRepo } from '../../../shared/models/navigation-tree.model';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-branch-search',
  imports: [FormsModule, NgIcon, TrackNativeModalDirective],
  templateUrl: './branch-search.html',
  viewProviders: [
    provideIcons({
      lucideSearch,
      lucideGitBranch,
      lucideCircleDashed,
      lucideLoader2,
      lucidePlus,
      lucideArrowLeft,
      lucideGlobe2,
    }),
  ],
})
export class BranchSearch {
  private branchesService = inject(BranchesService);

  @ViewChild('searchDialog') dialogRef!: TrackNativeModalDirective;
  @ViewChild('searchInput') searchInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('originInput') originInputRef!: ElementRef<HTMLInputElement>;

  repos = signal<NavigationRepo[]>([]);
  selectedRepoId = signal<number | null>(null);
  searchQuery = signal('');
  searchResults = signal<BranchInfo[]>([]);
  searchRemoteResults = signal<BranchInfo[]>([]);
  searching = signal(false);
  searchingRemote = signal(false);
  selectedIndex = signal(0);
  creating = signal(false);

  // Step 2: origin selection
  dialogStep = signal<'search' | 'selectOrigin'>('search');
  pendingBranchName = signal('');
  originSearchQuery = signal('');
  originLocalResults = signal<BranchInfo[]>([]);
  originRemoteResults = signal<BranchInfo[]>([]);
  originSearchingLocal = signal(false);
  originSearchingRemote = signal(false);
  originSelectedIndex = signal(0);

  branchSelected = output<{ repo: NavigationRepo; branch: BranchInfo }>();

  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private originDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  reposWithSelection = computed(() => {
    const selectedId = this.selectedRepoId();
    return this.repos().map((repo) => ({
      ...repo,
      selected: repo.id === selectedId,
    }));
  });

  visibleRemoteResults = computed(() => {
    const localNames = new Set(
      this.searchResults().map((b) => b.name.toLowerCase()),
    );
    return this.searchRemoteResults().filter(
      (b) => !localNames.has(stripRemotePrefix(b.name).toLowerCase()),
    );
  });

  canCreateBranch = computed(() => {
    const query = this.searchQuery();
    const results = this.searchResults();
    const remotes = this.visibleRemoteResults();
    if (query.length < 3) return false;
    const lower = query.toLowerCase();
    const exactLocal = results.some((b) => b.name.toLowerCase() === lower);
    const exactRemote = remotes.some(
      (b) => stripRemotePrefix(b.name).toLowerCase() === lower,
    );
    return (
      !exactLocal &&
      !exactRemote &&
      !this.searching() &&
      !this.searchingRemote()
    );
  });

  totalItems = computed(() => {
    const results = this.searchResults();
    const remotes = this.visibleRemoteResults();
    const canCreate = this.canCreateBranch();
    return results.length + remotes.length + (canCreate ? 1 : 0);
  });

  originTotalItems = computed(() => {
    return this.originLocalResults().length + this.originRemoteResults().length;
  });

  constructor() {
    effect(() => {
      const query = this.searchQuery();
      const repoId = this.selectedRepoId();
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
      }
      if (query.length >= 3 && repoId !== null) {
        this.searching.set(true);
        this.searchingRemote.set(true);
        this.selectedIndex.set(0);
        this.searchDebounceTimer = setTimeout(() => {
          this.performSearch(repoId, query);
        }, 200);
      } else {
        this.searchResults.set([]);
        this.searchRemoteResults.set([]);
        this.searching.set(false);
        this.searchingRemote.set(false);
      }
    });

    effect(() => {
      const query = this.originSearchQuery();
      const repoId = this.selectedRepoId();
      const step = this.dialogStep();
      if (this.originDebounceTimer) {
        clearTimeout(this.originDebounceTimer);
      }
      if (step === 'selectOrigin' && repoId !== null) {
        this.originSearchingLocal.set(true);
        this.originSearchingRemote.set(true);
        this.originSelectedIndex.set(0);
        this.originDebounceTimer = setTimeout(() => {
          this.performOriginSearch(repoId, query);
        }, 200);
      }
    });
  }

  open(repos: NavigationRepo[]) {
    this.repos.set(repos);
    this.selectedRepoId.set(repos.length > 0 ? repos[0].id : null);
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.searchRemoteResults.set([]);
    this.selectedIndex.set(0);
    this.creating.set(false);
    this.dialogStep.set('search');
    this.pendingBranchName.set('');
    this.originSearchQuery.set('');
    this.originLocalResults.set([]);
    this.originRemoteResults.set([]);
    this.dialogRef.open();
    setTimeout(() => {
      this.searchInputRef?.nativeElement?.focus();
    }, 50);
  }

  close() {
    this.dialogRef.close();
  }

  selectRepo(repoId: number) {
    this.selectedRepoId.set(repoId);
    this.searchResults.set([]);
    this.searchRemoteResults.set([]);
    this.searchQuery.set('');
    setTimeout(() => {
      this.searchInputRef?.nativeElement?.focus();
    });
  }

  onKeyDown(event: KeyboardEvent) {
    if (this.dialogStep() === 'selectOrigin') {
      this.onOriginKeyDown(event);
      return;
    }

    const total = this.totalItems();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (total > 0) {
        this.selectedIndex.set((this.selectedIndex() + 1) % total);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (total > 0) {
        this.selectedIndex.set(
          (this.selectedIndex() - 1 + total) % total,
        );
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const results = this.searchResults();
      const remotes = this.visibleRemoteResults();
      const canCreate = this.canCreateBranch();
      const idx = this.selectedIndex();

      if (idx < results.length) {
        this.selectBranch(results[idx]);
      } else if (idx < results.length + remotes.length) {
        this.selectRemoteBranch(remotes[idx - results.length]);
      } else if (canCreate && idx === results.length + remotes.length) {
        this.createBranch();
      }
    } else if (event.key === 'Escape') {
      this.close();
    }
  }

  private onOriginKeyDown(event: KeyboardEvent) {
    const total = this.originTotalItems();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (total > 0) {
        this.originSelectedIndex.set(
          (this.originSelectedIndex() + 1) % total,
        );
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (total > 0) {
        this.originSelectedIndex.set(
          (this.originSelectedIndex() - 1 + total) % total,
        );
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const idx = this.originSelectedIndex();
      const locals = this.originLocalResults();
      const remotes = this.originRemoteResults();
      if (idx < locals.length) {
        this.selectOriginBranch(locals[idx]);
      } else if (idx < locals.length + remotes.length) {
        this.selectOriginBranch(remotes[idx - locals.length]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.goBackToSearch();
    }
  }

  selectBranch(branch: BranchInfo) {
    const repo = this.repos().find((r) => r.id === this.selectedRepoId());
    if (repo) {
      this.branchSelected.emit({ repo, branch });
      this.close();
    }
  }

  selectRemoteBranch(branch: BranchInfo) {
    const repoId = this.selectedRepoId();
    if (!repoId) return;

    const localName = stripRemotePrefix(branch.name);
    const repo = this.repos().find((r) => r.id === repoId);
    if (!repo) return;

    this.creating.set(true);
    this.branchesService
      .createBranch(repoId, localName, branch.name)
      .subscribe({
        next: (newBranch) => {
          this.creating.set(false);
          toast.success(`Branch "${localName}" created from ${branch.name}`);
          this.branchSelected.emit({ repo, branch: newBranch });
          this.close();
        },
        error: (err) => {
          this.creating.set(false);
          const msg = err?.error?.message || 'Unknown error';
          toast.error(`Could not create branch. ${msg}`);
        },
      });
  }

  createBranch() {
    const repoId = this.selectedRepoId();
    const branchName = this.searchQuery().trim();

    if (!repoId || !branchName) return;

    this.pendingBranchName.set(branchName);
    this.originSearchQuery.set('');
    this.originLocalResults.set([]);
    this.originRemoteResults.set([]);
    this.originSelectedIndex.set(0);
    this.dialogStep.set('selectOrigin');
    setTimeout(() => {
      this.originInputRef?.nativeElement?.focus();
    }, 50);
  }

  selectOriginBranch(branch: BranchInfo) {
    const repoId = this.selectedRepoId();
    const branchName = this.pendingBranchName();

    if (!repoId || !branchName) return;

    this.creating.set(true);
    this.branchesService
      .createBranch(repoId, branchName, branch.name)
      .subscribe({
        next: (newBranch) => {
          this.creating.set(false);
          toast.success(`Branch "${branchName}" created from ${branch.name}`);
          const repo = this.repos().find((r) => r.id === repoId);
          if (repo) {
            this.branchSelected.emit({ repo, branch: newBranch });
          }
          this.close();
        },
        error: (err) => {
          this.creating.set(false);
          const msg = err?.error?.message || 'Unknown error';
          toast.error(`Could not create branch. ${msg}`);
        },
      });
  }

  goBackToSearch() {
    this.dialogStep.set('search');
    this.pendingBranchName.set('');
    this.originSearchQuery.set('');
    this.originLocalResults.set([]);
    this.originRemoteResults.set([]);
    setTimeout(() => {
      this.searchInputRef?.nativeElement?.focus();
    }, 50);
  }

  private performSearch(repoId: number, query: string) {
    this.branchesService.searchBranches(repoId, query).subscribe({
      next: (results) => {
        this.searchResults.set(results);
        this.searching.set(false);
        this.selectedIndex.set(0);
      },
      error: () => {
        this.searchResults.set([]);
        this.searching.set(false);
      },
    });

    this.branchesService.searchRemoteBranches(repoId, query).subscribe({
      next: (results) => {
        this.searchRemoteResults.set(results);
        this.searchingRemote.set(false);
      },
      error: () => {
        this.searchRemoteResults.set([]);
        this.searchingRemote.set(false);
      },
    });
  }

  private performOriginSearch(repoId: number, query: string) {
    this.branchesService
      .searchBranches(repoId, query, true)
      .subscribe({
        next: (results) => {
          this.originLocalResults.set(results);
          this.originSearchingLocal.set(false);
          this.originSelectedIndex.set(0);
        },
        error: () => {
          this.originLocalResults.set([]);
          this.originSearchingLocal.set(false);
        },
      });

    this.branchesService
      .searchRemoteBranches(repoId, query)
      .subscribe({
        next: (results) => {
          this.originRemoteResults.set(results);
          this.originSearchingRemote.set(false);
        },
        error: () => {
          this.originRemoteResults.set([]);
          this.originSearchingRemote.set(false);
        },
      });
  }
}

function stripRemotePrefix(name: string): string {
  const idx = name.indexOf('/');
  return idx >= 0 ? name.substring(idx + 1) : name;
}
