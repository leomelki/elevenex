import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpDown,
  lucideBinary,
  lucideChevronDown,
  lucideExternalLink,
  lucideFileCode,
  lucideGitBranch,
  lucideGitPullRequest,
  lucideLoader,
  lucideRefreshCw,
  lucideSearch,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import hljs from 'highlight.js/lib/common';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';

import {
  ChangeReviewFileSummary,
  ChangeReviewFileStatus,
  ChangeReviewFileWindow,
  ChangeReviewRow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from '@/shared/models/change-review.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { detectHljsLang, escapeHtml } from '@/features/session/claude-workspace/util/code-highlight';

type StatusFilter = 'all' | ChangeReviewFileStatus;

interface ScopeOption {
  value: ChangeReviewScope;
  label: string;
}

const SCOPES: ScopeOption[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'last-commit', label: 'Last commit' },
  { value: 'branch', label: 'Branch' },
];

const WINDOW_LIMIT = 700;
const CONTEXT_RANGE_LIMIT = 120;

@Component({
  selector: 'app-change-review-panel',
  standalone: true,
  imports: [CommonModule, ScrollingModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './change-review-panel.component.html',
  styleUrl: './change-review-panel.component.scss',
  host: { class: 'block h-full min-h-0 bg-background text-foreground' },
  viewProviders: [
    provideIcons({
      lucideArrowUpDown,
      lucideBinary,
      lucideChevronDown,
      lucideExternalLink,
      lucideFileCode,
      lucideGitBranch,
      lucideGitPullRequest,
      lucideLoader,
      lucideRefreshCw,
      lucideSearch,
      lucideTriangleAlert,
    }),
  ],
})
export class ChangeReviewPanelComponent {
  readonly worktreePath = input.required<string>();

  private readonly changeReview = inject(ChangeReviewService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly rowHtmlCache = new Map<string, SafeHtml>();
  private readonly diffViewport = viewChild<CdkVirtualScrollViewport>('diffViewport');

  readonly scopes = SCOPES;
  readonly scope = signal<ChangeReviewScope>('branch');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly search = signal('');
  readonly context = signal(8);
  readonly summary = signal<ChangeReviewSummary | null>(null);
  readonly selectedFile = signal<ChangeReviewFileSummary | null>(null);
  readonly fileWindow = signal<ChangeReviewFileWindow | null>(null);
  readonly rows = signal<ChangeReviewRow[]>([]);
  readonly loadingSummary = signal(false);
  readonly loadingWindow = signal(false);
  readonly loadingMore = signal(false);
  readonly loadingContextRanges = signal<ReadonlySet<string>>(new Set());
  readonly error = signal<string | null>(null);

  readonly filteredFiles = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    const query = this.search().trim().toLowerCase();
    const status = this.statusFilter();
    return summary.files.filter((file) => {
      if (status !== 'all' && file.status !== status) return false;
      if (!query) return true;
      return file.path.toLowerCase().includes(query)
        || Boolean(file.oldPath?.toLowerCase().includes(query));
    });
  });

  readonly statusFilters = computed<Array<{ value: StatusFilter; label: string; count: number }>>(() => {
    const files = this.summary()?.files ?? [];
    const count = (status: StatusFilter) => status === 'all'
      ? files.length
      : files.filter((file) => file.status === status).length;
    const filters: Array<{ value: StatusFilter; label: string; count: number }> = [
      { value: 'all', label: 'All', count: count('all') },
      { value: 'added', label: 'Added', count: count('added') },
      { value: 'modified', label: 'Modified', count: count('modified') },
      { value: 'deleted', label: 'Deleted', count: count('deleted') },
      { value: 'renamed', label: 'Renamed', count: count('renamed') },
    ];
    return filters.filter((filter) => filter.value === 'all' || filter.count > 0);
  });

  readonly hasMoreRows = computed(() => {
    const fileWindow = this.fileWindow();
    return Boolean(fileWindow?.hasMore) && this.rows().length < (fileWindow?.totalRows ?? 0);
  });

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const scope = this.scope();
      if (!worktreePath) return;
      void this.loadSummary(worktreePath, scope, false);
    });
  }

  async refresh(refreshBase = false): Promise<void> {
    await this.loadSummary(this.worktreePath(), this.scope(), refreshBase);
  }

  setScope(scope: ChangeReviewScope): void {
    if (scope === this.scope()) return;
    this.scope.set(scope);
  }

  setStatusFilter(filter: StatusFilter): void {
    this.statusFilter.set(filter);
  }

  async selectFile(file: ChangeReviewFileSummary): Promise<void> {
    this.selectedFile.set(file);
    this.context.set(8);
    await this.loadWindow(file, 0, true);
  }

  async collapseFile(): Promise<void> {
    this.selectedFile.set(null);
    this.fileWindow.set(null);
    this.rows.set([]);
    this.loadingContextRanges.set(new Set());
  }

  onDiffIndexChange(index: number): void {
    const rows = this.rows();
    const file = this.selectedFile();
    if (!file || this.loadingMore() || !this.hasMoreRows()) return;
    if (index + 80 >= rows.length) {
      void this.loadWindow(file, rows.length, false);
    }
  }

  openPullRequest(): void {
    const url = this.summary()?.pullRequest?.url;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  rowHtml(row: ChangeReviewRow): SafeHtml {
    const key = `${row.path}:${row.type}:${row.content}`;
    const cached = this.rowHtmlCache.get(key);
    if (cached) return cached;
    const lang = detectHljsLang(row.path);
    let html = escapeHtml(row.content || ' ');
    if (row.type !== 'hunk' && row.type !== 'expand' && row.type !== 'meta') {
      try {
        html = lang
          ? hljs.highlight(row.content || ' ', { language: lang, ignoreIllegals: true }).value
          : escapeHtml(row.content || ' ');
      } catch {
        html = escapeHtml(row.content || ' ');
      }
    }
    const safe = this.sanitizer.bypassSecurityTrustHtml(html);
    this.rowHtmlCache.set(key, safe);
    return safe;
  }

  async expandContext(row: ChangeReviewRow): Promise<void> {
    const file = this.selectedFile();
    if (!file || row.type !== 'expand' || !row.oldStart || !row.newStart || !row.count) return;
    if (this.loadingContextRanges().has(row.id)) return;
    this.setContextRangeLoading(row.id, true);
    try {
      const contextWindow = await firstValueFrom(this.changeReview.getContextWindow(
        this.worktreePath(),
        this.scope(),
        file.path,
        {
          oldStart: row.oldStart,
          newStart: row.newStart,
          count: row.count,
          limit: CONTEXT_RANGE_LIMIT,
        },
      ));
      const loaded = contextWindow.rows.length;
      const replacement: ChangeReviewRow[] = [...contextWindow.rows];
      const remaining = Math.max(0, row.count - loaded);
      if (remaining > 0) {
        replacement.push({
          ...row,
          id: `${row.path}:expand:${row.oldStart + loaded}:${row.newStart + loaded}:${remaining}`,
          oldStart: row.oldStart + loaded,
          newStart: row.newStart + loaded,
          count: remaining,
          content: `${remaining} unchanged line${remaining === 1 ? '' : 's'}`,
        });
      }

      this.rows.update((rows) => {
        const index = rows.findIndex((candidate) => candidate.id === row.id);
        if (index === -1) return rows;
        return [
          ...rows.slice(0, index),
          ...replacement,
          ...rows.slice(index + 1),
        ];
      });
    } catch (error: any) {
      const message = error?.error?.message || 'Could not load context lines.';
      toast.error(message);
    } finally {
      this.setContextRangeLoading(row.id, false);
    }
  }

  isContextRangeLoading(row: ChangeReviewRow): boolean {
    return this.loadingContextRanges().has(row.id);
  }

  fileTrack(index: number, file: ChangeReviewFileSummary): string {
    return `${file.status}:${file.oldPath ?? ''}:${file.path}`;
  }

  rowTrack(index: number, row: ChangeReviewRow): string {
    return row.id;
  }

  fileBasename(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  fileDirname(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  statusLabel(status: ChangeReviewFileStatus): string {
    switch (status) {
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'modified': return 'M';
    }
  }

  statusClass(status: ChangeReviewFileStatus): string {
    return `cr-file-status--${status}`;
  }

  shortSha(value: string | null): string {
    return value ? value.slice(0, 8) : '-';
  }

  staleText(seconds: number | null): string {
    if (seconds === null) return '';
    const hours = Math.floor(seconds / 3600);
    if (hours < 48) return `${hours}h old`;
    return `${Math.floor(hours / 24)}d old`;
  }

  private async loadSummary(worktreePath: string, scope: ChangeReviewScope, refreshBase: boolean): Promise<void> {
    this.loadingSummary.set(true);
    this.error.set(null);
    this.fileWindow.set(null);
    this.rows.set([]);
    this.selectedFile.set(null);
    this.loadingContextRanges.set(new Set());
    this.rowHtmlCache.clear();
    try {
      const summary = await firstValueFrom(this.changeReview.getSummary(worktreePath, scope, refreshBase));
      this.summary.set(summary);
      const first = summary.files[0] ?? null;
      if (first) {
        await this.selectFile(first);
      }
    } catch (error: any) {
      const message = error?.error?.message || 'Could not load changes.';
      this.error.set(message);
      toast.error(message);
    } finally {
      this.loadingSummary.set(false);
    }
  }

  private async loadWindow(file: ChangeReviewFileSummary, offset: number, replace: boolean): Promise<void> {
    if (replace) {
      this.loadingWindow.set(true);
      this.loadingContextRanges.set(new Set());
      this.diffViewport()?.scrollToIndex(0);
    } else {
      this.loadingMore.set(true);
    }
    try {
      const fileWindow = await firstValueFrom(this.changeReview.getFileWindow(
        this.worktreePath(),
        this.scope(),
        file.path,
        {
          offset,
          limit: WINDOW_LIMIT,
          context: this.context(),
        },
      ));
      this.fileWindow.set(fileWindow);
      this.rows.set(replace ? fileWindow.rows : [...this.rows(), ...fileWindow.rows]);
    } catch (error: any) {
      const message = error?.error?.message || 'Could not load file diff.';
      toast.error(message);
    } finally {
      this.loadingWindow.set(false);
      this.loadingMore.set(false);
    }
  }

  private setContextRangeLoading(rowId: string, loading: boolean): void {
    this.loadingContextRanges.update((current) => {
      const next = new Set(current);
      if (loading) {
        next.add(rowId);
      } else {
        next.delete(rowId);
      }
      return next;
    });
  }
}
