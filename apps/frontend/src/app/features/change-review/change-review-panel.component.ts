import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import { Component, computed, effect, inject, input, OnDestroy, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpDown,
  lucideBinary,
  lucideChevronDown,
  lucideCheck,
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
const VIEWED_STORAGE_KEY = 'elevenex-change-review-viewed-files';
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_PAUSE_MS = 35;
const PREFETCH_MAX_FILES = 2_000;
const PREFETCH_MAX_CHANGED_LINES_PER_FILE = 8_000;
const PREFETCH_MAX_TOTAL_CHANGED_LINES = 220_000;

interface PrefetchState {
  running: boolean;
  completed: number;
  total: number;
  skipped: number;
}

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
      lucideCheck,
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
export class ChangeReviewPanelComponent implements OnDestroy {
  readonly worktreePath = input.required<string>();

  private readonly changeReview = inject(ChangeReviewService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly rowHtmlCache = new Map<string, SafeHtml>();
  private readonly diffViewport = viewChild<CdkVirtualScrollViewport>('diffViewport');
  private readonly relativeTimeInterval = window.setInterval(() => {
    this.now.set(Date.now());
  }, 30_000);
  private prefetchGeneration = 0;

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
  readonly now = signal(Date.now());
  readonly fileChangeHashes = signal<ReadonlyMap<string, string>>(new Map());
  readonly viewedHashes = signal<Record<string, string>>(this.readViewedHashes());
  readonly prefetchState = signal<PrefetchState>({
    running: false,
    completed: 0,
    total: 0,
    skipped: 0,
  });

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

  readonly selectedFileViewed = computed(() => {
    const file = this.selectedFile();
    const fileWindow = this.fileWindow();
    if (!file || !fileWindow) return false;
    return this.isViewedHash(file.path, fileWindow.changeHash);
  });

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const scope = this.scope();
      if (!worktreePath) return;
      void this.loadSummary(worktreePath, scope, false);
    });
  }

  ngOnDestroy(): void {
    this.prefetchGeneration += 1;
    window.clearInterval(this.relativeTimeInterval);
  }

  async refresh(refreshBase = false): Promise<void> {
    this.prefetchGeneration += 1;
    this.prefetchState.set({ running: false, completed: 0, total: 0, skipped: 0 });
    if (refreshBase) {
      this.changeReview.clearCache(this.worktreePath(), this.scope());
    }
    await this.loadSummary(this.worktreePath(), this.scope(), refreshBase);
  }

  setScope(scope: ChangeReviewScope): void {
    if (scope === this.scope()) return;
    this.prefetchGeneration += 1;
    this.prefetchState.set({ running: false, completed: 0, total: 0, skipped: 0 });
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

  toggleSelectedFileViewed(): void {
    const file = this.selectedFile();
    const fileWindow = this.fileWindow();
    if (!file || !fileWindow) return;
    if (this.selectedFileViewed()) {
      this.unmarkViewed(file.path);
      return;
    }
    this.markViewed(file.path, fileWindow.changeHash);
  }

  prefetchFile(file: ChangeReviewFileSummary): void {
    if (file.binary || file.large) return;
    const options = {
      offset: 0,
      limit: WINDOW_LIMIT,
      context: this.context(),
    };
    if (this.changeReview.hasFileWindowCache(this.worktreePath(), this.scope(), file.path, options)) {
      return;
    }
    void firstValueFrom(this.changeReview.getFileWindow(
      this.worktreePath(),
      this.scope(),
      file.path,
      options,
    ))
      .then((fileWindow) => this.rememberFileHash(fileWindow.path, fileWindow.changeHash))
      .catch(() => undefined);
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

  isFileViewed(file: ChangeReviewFileSummary): boolean {
    const hash = this.fileChangeHashes().get(file.path);
    return Boolean(hash) && this.isViewedHash(file.path, hash!);
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

  refreshAgeText(summary: ChangeReviewSummary): string {
    const elapsedSeconds = Math.max(0, Math.floor((this.now() - new Date(summary.generatedAt).getTime()) / 1000));
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 48) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
  }

  prefetchText(state: PrefetchState): string {
    if (!state.running && state.total === 0) return '';
    if (state.running) return `warming ${state.completed}/${state.total}`;
    return `warmed ${state.completed}/${state.total}`;
  }

  private async loadSummary(worktreePath: string, scope: ChangeReviewScope, refreshBase: boolean): Promise<void> {
    this.loadingSummary.set(true);
    this.error.set(null);
    this.fileWindow.set(null);
    this.rows.set([]);
    this.selectedFile.set(null);
    this.loadingContextRanges.set(new Set());
    this.fileChangeHashes.set(new Map());
    this.rowHtmlCache.clear();
    this.now.set(Date.now());
    const generation = ++this.prefetchGeneration;
    this.prefetchState.set({ running: false, completed: 0, total: 0, skipped: 0 });
    try {
      const summary = await firstValueFrom(this.changeReview.getSummary(worktreePath, scope, refreshBase));
      this.summary.set(summary);
      const first = summary.files[0] ?? null;
      if (first) {
        const firstFile = this.selectFile(first);
        void this.prefetchFileWindows(summary, generation, first.path);
        await firstFile;
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
    const options = {
      offset,
      limit: WINDOW_LIMIT,
      context: this.context(),
    };
    const cacheHit = this.changeReview.hasFileWindowCache(
      this.worktreePath(),
      this.scope(),
      file.path,
      options,
    );
    if (replace) {
      this.loadingWindow.set(!cacheHit);
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
        options,
      ));
      this.rememberFileHash(fileWindow.path, fileWindow.changeHash);
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

  private async prefetchFileWindows(
    summary: ChangeReviewSummary,
    generation: number,
    selectedPath: string,
  ): Promise<void> {
    const { files, skipped } = this.prefetchCandidates(summary, selectedPath);
    if (generation !== this.prefetchGeneration) return;
    this.prefetchState.set({
      running: files.length > 0,
      completed: 0,
      total: files.length,
      skipped,
    });
    if (files.length === 0) return;

    await this.prefetchPause(180);
    const workerCount = Math.min(PREFETCH_CONCURRENCY, files.length);
    await Promise.all(Array.from({ length: workerCount }, async (_, workerIndex) => {
      for (let index = workerIndex; index < files.length; index += workerCount) {
        if (generation !== this.prefetchGeneration) return;
        const file = files[index];
        const fileWindow = await firstValueFrom(this.changeReview.getFileWindow(
          summary.worktreePath,
          summary.scope,
          file.path,
          {
            offset: 0,
            limit: WINDOW_LIMIT,
            context: this.context(),
          },
        )).catch(() => undefined);
        if (fileWindow) {
          this.rememberFileHash(fileWindow.path, fileWindow.changeHash);
        }
        if (generation !== this.prefetchGeneration) return;
        this.prefetchState.update((state) => ({
          ...state,
          completed: Math.min(state.total, state.completed + 1),
        }));
        await this.prefetchPause(PREFETCH_PAUSE_MS);
      }
    }));

    if (generation === this.prefetchGeneration) {
      this.prefetchState.update((state) => ({ ...state, running: false }));
    }
  }

  private prefetchCandidates(
    summary: ChangeReviewSummary,
    selectedPath: string,
  ): { files: ChangeReviewFileSummary[]; skipped: number } {
    let skipped = 0;
    let totalChangedLines = 0;
    const files: ChangeReviewFileSummary[] = [];
    const candidates = summary.files
      .filter((file) => file.path !== selectedPath)
      .sort((left, right) => {
        const leftSize = left.additions + left.deletions;
        const rightSize = right.additions + right.deletions;
        return leftSize - rightSize || left.path.localeCompare(right.path);
      });

    for (const file of candidates) {
      const changedLines = file.additions + file.deletions;
      if (
        file.binary
        || file.large
        || changedLines > PREFETCH_MAX_CHANGED_LINES_PER_FILE
        || files.length >= PREFETCH_MAX_FILES
        || totalChangedLines + changedLines > PREFETCH_MAX_TOTAL_CHANGED_LINES
      ) {
        skipped += 1;
        continue;
      }
      files.push(file);
      totalChangedLines += changedLines;
    }

    return { files, skipped };
  }

  private prefetchPause(delayMs: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }

  private rememberFileHash(filePath: string, changeHash: string): void {
    this.fileChangeHashes.update((current) => {
      const next = new Map(current);
      next.set(filePath, changeHash);
      return next;
    });
    const key = this.viewedKey(filePath);
    const viewedHash = this.viewedHashes()[key];
    if (viewedHash && viewedHash !== changeHash) {
      this.unmarkViewed(filePath);
    }
  }

  private markViewed(filePath: string, changeHash: string): void {
    this.viewedHashes.update((current) => {
      const next = { ...current, [this.viewedKey(filePath)]: changeHash };
      this.writeViewedHashes(next);
      return next;
    });
  }

  private unmarkViewed(filePath: string): void {
    this.viewedHashes.update((current) => {
      const key = this.viewedKey(filePath);
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      this.writeViewedHashes(next);
      return next;
    });
  }

  private isViewedHash(filePath: string, changeHash: string): boolean {
    return this.viewedHashes()[this.viewedKey(filePath)] === changeHash;
  }

  private viewedKey(filePath: string): string {
    return [
      encodeURIComponent(this.worktreePath()),
      this.scope(),
      encodeURIComponent(filePath),
    ].join('|');
  }

  private readViewedHashes(): Record<string, string> {
    try {
      const raw = localStorage.getItem(VIEWED_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeViewedHashes(value: Record<string, string>): void {
    try {
      localStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Ignore storage errors.
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
