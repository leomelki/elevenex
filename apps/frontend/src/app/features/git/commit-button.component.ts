import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideGitCommitVertical,
  lucideLoaderCircle,
  lucideRefreshCw,
  lucideSparkles,
  lucideUpload,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardInputDirective } from '@/shared/components/input';
import { FileStatus, GitStatusSummary } from '@/shared/models/git.model';
import { GitService } from '@/shared/services/git.service';

const POLL_INTERVAL_MS = 5000;
const MAX_VISIBLE_FILES = 10;

interface CommitFileRow extends FileStatus {
  basename: string;
  folder: string;
}

@Component({
  selector: 'app-commit-button',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardInputDirective],
  templateUrl: './commit-button.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'commit-entry relative flex items-center',
  },
  viewProviders: [
    provideIcons({
      lucideGitCommitVertical,
      lucideLoaderCircle,
      lucideRefreshCw,
      lucideSparkles,
      lucideUpload,
      lucideX,
    }),
  ],
})
export class CommitButtonComponent {
  readonly worktreePath = input<string | null>(null);
  readonly contextKey = input<string | null>(null);

  private readonly gitService = inject(GitService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly summary = signal<GitStatusSummary | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly open = signal(false);
  readonly submitting = signal(false);
  readonly includeUnstaged = signal(false);
  readonly commitMessage = signal('');

  private refreshInFlightKey: string | null = null;
  private refreshRequestId = 0;
  private readonly pushingWorktreePaths = signal<ReadonlySet<string>>(new Set());

  readonly hasChanges = computed(() => this.summary()?.hasChanges ?? false);
  readonly hasPushableCommits = computed(() => {
    const summary = this.summary();
    if (!summary || summary.hasChanges || summary.branch === 'HEAD') return false;
    return !summary.upstream || summary.ahead > 0;
  });
  readonly shouldShowButton = computed(
    () =>
      Boolean(this.worktreePath()) &&
      (this.loading() ||
        this.hasChanges() ||
        this.hasPushableCommits() ||
        this.open() ||
        this.isBusy()),
  );
  readonly pushing = computed(() => {
    const worktreePath = this.worktreePath();
    return Boolean(worktreePath && this.pushingWorktreePaths().has(worktreePath));
  });
  readonly isBusy = computed(() => this.submitting() || this.pushing());
  readonly triggerLabel = computed(() => {
    if (this.submitting()) return 'Committing…';
    if (this.pushing()) return 'Pushing…';
    if (this.loading() && !this.summary()) return 'Checking…';
    return this.hasChanges() ? 'Commit' : 'Push';
  });

  readonly selectedRows = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    return this.includeUnstaged() ? summary.files : summary.files.filter((file) => file.staged);
  });

  readonly selectedFileCount = computed(
    () => new Set(this.selectedRows().map((file) => file.path)).size,
  );

  readonly selectedStats = computed(() => {
    const summary = this.summary();
    const scope = this.includeUnstaged() ? summary?.total : summary?.staged;
    return {
      files: this.selectedFileCount(),
      additions: scope?.additions ?? 0,
      deletions: scope?.deletions ?? 0,
    };
  });

  readonly visibleRows = computed<CommitFileRow[]>(() =>
    this.selectedRows()
      .slice(0, MAX_VISIBLE_FILES)
      .map((file) => {
        const pathParts = file.path.split(/[\\/]/).filter(Boolean);
        const basename = pathParts.pop() ?? file.path;
        return {
          ...file,
          basename,
          folder: pathParts.length ? pathParts.join('/') : '',
        };
      }),
  );
  readonly hiddenRowCount = computed(() =>
    Math.max(0, this.selectedRows().length - MAX_VISIBLE_FILES),
  );
  readonly canCommit = computed(() => this.selectedFileCount() > 0 && !this.submitting());

  private readonly activeContextKey = computed(() => {
    const worktreePath = this.worktreePath();
    if (!worktreePath) return null;
    return this.contextKey() || worktreePath;
  });

  readonly primaryActionLabel = computed(() => {
    if (this.submitting()) return 'Committing…';
    return this.commitMessage().trim() ? 'Commit' : 'Generate & commit';
  });

  constructor() {
    effect((onCleanup) => {
      const worktreePath = this.worktreePath();
      const contextKey = this.activeContextKey();

      this.summary.set(null);
      this.open.set(false);
      this.commitMessage.set('');
      this.loading.set(Boolean(worktreePath));
      this.refreshing.set(false);
      if (this.refreshInFlightKey !== contextKey) {
        this.refreshInFlightKey = null;
      }

      if (!worktreePath) {
        this.loading.set(false);
        return;
      }

      void this.refreshSummary();

      const intervalId = window.setInterval(() => {
        void this.refreshSummary({ background: true });
      }, POLL_INTERVAL_MS);
      const onFocus = () => {
        void this.refreshSummary({ background: true });
      };
      window.addEventListener('focus', onFocus);

      onCleanup(() => {
        window.clearInterval(intervalId);
        window.removeEventListener('focus', onFocus);
      });
    });
  }

  async toggleOpen(): Promise<void> {
    if (this.hasPushableCommits()) {
      await this.push();
      return;
    }

    const next = !this.open();
    this.open.set(next);
    if (next) {
      await this.refreshSummary();
    }
  }

  close(): void {
    this.open.set(false);
  }

  async refresh(): Promise<void> {
    await this.refreshSummary();
  }

  async submitCommit(): Promise<void> {
    const worktreePath = this.worktreePath();
    if (!worktreePath || !this.canCommit()) return;

    this.submitting.set(true);
    try {
      const result = await firstValueFrom(
        this.gitService.commit(worktreePath, {
          message: this.commitMessage().trim() || undefined,
          includeUnstaged: this.includeUnstaged(),
        }),
      );

      const shortMsg =
        result.message.length > 64 ? result.message.slice(0, 61) + '…' : result.message;
      toast.success(`Committed: ${shortMsg}`);

      this.commitMessage.set('');
      this.open.set(false);
      await this.refreshSummary({ force: true });
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not create commit.');
    } finally {
      this.submitting.set(false);
    }
  }

  async push(): Promise<void> {
    const worktreePath = this.worktreePath();
    if (
      !worktreePath ||
      !this.hasPushableCommits() ||
      this.pushingWorktreePaths().has(worktreePath)
    ) {
      return;
    }

    this.setPushingWorktree(worktreePath, true);
    try {
      const result = await firstValueFrom(this.gitService.push(worktreePath));
      if (result.pushed) {
        toast.success(result.message);
      } else if (result.nonFastForward) {
        toast.error('Push rejected - branch is behind upstream.');
      } else {
        toast.error(result.message || 'Push failed.');
      }
      if (this.worktreePath() === worktreePath) {
        await this.refreshSummary({ force: true });
      }
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not push.');
    } finally {
      this.setPushingWorktree(worktreePath, false);
    }
  }

  trackFile(_: number, file: FileStatus): string {
    return `${file.staged ? 'staged' : 'unstaged'}:${file.path}:${file.status}`;
  }

  statusLabel(file: FileStatus): string {
    if (file.status === 'untracked') return 'new';
    return file.status;
  }

  private async refreshSummary(
    options: { background?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const worktreePath = this.worktreePath();
    const contextKey = this.activeContextKey();
    if (
      !worktreePath ||
      !contextKey ||
      (!options.force && this.refreshInFlightKey === contextKey) ||
      (!options.force && this.isBusy())
    ) {
      return;
    }

    const requestId = ++this.refreshRequestId;
    this.refreshInFlightKey = contextKey;
    if (options.background) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    try {
      const summary = await firstValueFrom(this.gitService.getSummary(worktreePath));
      if (!this.isCurrentRefreshContext(worktreePath, contextKey, requestId)) {
        return;
      }
      this.summary.set(summary);

      if (summary.staged.files === 0 && summary.unstaged.files > 0) {
        this.includeUnstaged.set(true);
      } else if (summary.unstaged.files === 0) {
        this.includeUnstaged.set(false);
      }

      if (!summary.hasChanges) {
        this.open.set(false);
      }
    } catch {
      if (
        !options.background &&
        this.isCurrentRefreshContext(worktreePath, contextKey, requestId)
      ) {
        toast.error('Could not load git status.');
      }
    } finally {
      if (this.isCurrentRefreshContext(worktreePath, contextKey, requestId)) {
        this.loading.set(false);
        this.refreshing.set(false);
        this.refreshInFlightKey = null;
      }
    }
  }

  private isCurrentRefreshContext(
    worktreePath: string,
    contextKey: string,
    requestId: number,
  ): boolean {
    return (
      this.worktreePath() === worktreePath &&
      this.activeContextKey() === contextKey &&
      this.refreshRequestId === requestId
    );
  }

  private setPushingWorktree(worktreePath: string, pushing: boolean): void {
    this.pushingWorktreePaths.update((current) => {
      const next = new Set(current);
      if (pushing) {
        next.add(worktreePath);
      } else {
        next.delete(worktreePath);
      }
      return next;
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open()) return;
    const target = event.target as Node | null;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) {
      this.close();
    }
  }
}
