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
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';

import { ZardInputDirective } from '@/shared/components/input';
import { FileStatus, GitStatusSummary } from '@/shared/models/git.model';
import { GitService } from '@/shared/services/git.service';

const POLL_INTERVAL_MS = 5000;
const MAX_VISIBLE_FILES = 10;

@Component({
  selector: 'app-commit-button',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardInputDirective],
  templateUrl: './commit-button.component.html',
  styleUrl: './commit-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'commit-entry',
  },
  viewProviders: [
    provideIcons({
      lucideGitCommitVertical,
      lucideLoaderCircle,
      lucideRefreshCw,
      lucideSparkles,
      lucideX,
    }),
  ],
})
export class CommitButtonComponent {
  readonly worktreePath = input<string | null>(null);

  private readonly gitService = inject(GitService);
  private readonly elementRef = inject(ElementRef<HTMLElement>);

  readonly summary = signal<GitStatusSummary | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly open = signal(false);
  readonly submitting = signal(false);
  readonly includeUnstaged = signal(false);
  readonly commitMessage = signal('');

  private refreshInFlight = false;

  readonly hasChanges = computed(() => this.summary()?.hasChanges ?? false);

  readonly selectedRows = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    return this.includeUnstaged()
      ? summary.files
      : summary.files.filter(file => file.staged);
  });

  readonly selectedFileCount = computed(
    () => new Set(this.selectedRows().map(file => file.path)).size,
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

  readonly visibleRows = computed(() => this.selectedRows().slice(0, MAX_VISIBLE_FILES));
  readonly hiddenRowCount = computed(() => Math.max(0, this.selectedRows().length - MAX_VISIBLE_FILES));
  readonly canCommit = computed(() => this.selectedFileCount() > 0 && !this.submitting());

  readonly primaryActionLabel = computed(() => {
    if (this.submitting()) return 'Committing…';
    return this.commitMessage().trim() ? 'Commit' : 'Generate & commit';
  });

  constructor() {
    effect(onCleanup => {
      const worktreePath = this.worktreePath();

      this.summary.set(null);
      this.open.set(false);
      this.commitMessage.set('');
      this.loading.set(Boolean(worktreePath));

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
      const result = await firstValueFrom(this.gitService.commit(worktreePath, {
        message: this.commitMessage().trim() || undefined,
        includeUnstaged: this.includeUnstaged(),
      }));

      const shortMsg = result.message.length > 64
        ? result.message.slice(0, 61) + '…'
        : result.message;
      toast.success(`Committed: ${shortMsg}`);

      this.commitMessage.set('');
      this.open.set(false);
      await this.refreshSummary();
    } catch (error: any) {
      toast.error(error?.error?.message || 'Could not create commit.');
    } finally {
      this.submitting.set(false);
    }
  }

  trackFile(_: number, file: FileStatus): string {
    return `${file.staged ? 'staged' : 'unstaged'}:${file.path}:${file.status}`;
  }

  statusLabel(file: FileStatus): string {
    if (file.status === 'untracked') return 'new';
    return file.status;
  }

  private async refreshSummary(options: { background?: boolean } = {}): Promise<void> {
    const worktreePath = this.worktreePath();
    if (!worktreePath || this.refreshInFlight || this.submitting()) return;

    this.refreshInFlight = true;
    if (options.background) {
      this.refreshing.set(true);
    } else {
      this.loading.set(true);
    }

    try {
      const summary = await firstValueFrom(this.gitService.getSummary(worktreePath));
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
      if (!options.background) {
        toast.error('Could not load git status.');
      }
    } finally {
      this.loading.set(false);
      this.refreshing.set(false);
      this.refreshInFlight = false;
    }
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
