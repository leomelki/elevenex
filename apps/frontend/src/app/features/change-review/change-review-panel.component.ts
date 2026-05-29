import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBinary,
  lucideChevronDown,
  lucideChevronRight,
  lucideChevronUp,
  lucideCheck,
  lucideExternalLink,
  lucideFileCode,
  lucideGitBranch,
  lucideGitMerge,
  lucideGitPullRequest,
  lucideLoader,
  lucideMessageSquarePlus,
  lucideRefreshCw,
  lucideSearch,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import hljs from 'highlight.js/lib/common';
import { firstValueFrom, Subject, takeUntil } from 'rxjs';
import { toast } from 'ngx-sonner';

import {
  ChangeReviewFileSummary,
  ChangeReviewFileStatus,
  ChangeReviewFileWindow,
  ChangeReviewLoadGuard,
  ChangeReviewRow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from '@/shared/models/change-review.model';
import {
  DIFF_SELECTION_MENTION_MAX_FILES,
  DIFF_SELECTION_MENTION_MAX_TEXT,
  DiffSelectionMention,
  DiffSelectionMentionContextRow,
} from '@/shared/models/diff-selection-mention.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { GitService } from '@/shared/services/git.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import {
  detectHljsLang,
  escapeHtml,
} from '@/features/session/claude-workspace/util/code-highlight';
import {
  ChangeReviewVirtualAnchor,
  ChangeReviewVirtualLayout,
  estimateChangeReviewDiffRows,
} from './change-review-virtual-layout';

type StatusFilter = 'all' | ChangeReviewFileStatus;
type RenderRowKind = 'fileHeader' | 'fileMeta' | 'largeDiffGate' | 'diff';
type ContextExpansionDirection = 'down' | 'up';

interface ScopeOption {
  value: ChangeReviewScope;
  label: string;
}

interface WindowLoadState {
  running: boolean;
  total: number;
}

interface DiffReplacement {
  baseIndex: number;
  rows: ChangeReviewRow[];
}

interface FileRenderState {
  file: ChangeReviewFileSummary;
  diffRowCount: number;
  baseRowCount: number | null;
  baseRows: ReadonlyMap<number, ChangeReviewRow>;
  loadingOffsets: ReadonlySet<number>;
  replacements: readonly DiffReplacement[];
  message: string | null;
  binary: boolean;
  large: boolean;
  truncated: boolean;
  changeHash: string | null;
}

interface ResolvedDiffRow {
  row: ChangeReviewRow | null;
  baseIndex: number | null;
}

interface RenderRow {
  id: string;
  kind: RenderRowKind;
  file: ChangeReviewFileSummary;
  state: FileRenderState;
  row: ChangeReviewRow | null;
  diffIndex: number | null;
  baseIndex: number | null;
}

interface SelectedDiffRow {
  renderRow: RenderRow;
  text: string;
}

interface DiffSelectionMentionAction {
  top: number;
  left: number;
  mentions: DiffSelectionMention[];
}

interface WindowRequest {
  generation: number;
  filePath: string;
  offset: number;
  key: string;
}

interface WindowCacheEntry {
  path: string;
  offset: number;
  length: number;
}

interface ScopeViewSnapshot {
  summary: ChangeReviewSummary;
  fileStates: ReadonlyMap<string, FileRenderState>;
  fileChangeHashes: ReadonlyMap<string, string>;
  fileFingerprints: ReadonlyMap<string, string>;
  activeFilePath: string | null;
  collapsedPaths: ReadonlySet<string>;
  forceLoadedFileDiffs: ReadonlySet<string>;
  forceLoadLargeChangeSet: boolean;
  windowCache: ReadonlyMap<string, WindowCacheEntry>;
  windowCacheRows: number;
  scrollTop: number;
  scrollLeft: number;
}

const SCOPES: ScopeOption[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'last-commit', label: 'Last commit' },
  { value: 'branch', label: 'Branch' },
];

const ROW_HEIGHT_PX = 24;
const FILE_DIFF_AUTO_LOAD_CHANGE_LIMIT = 700;
const WINDOW_LIMIT = 700;
const CONTEXT_RANGE_LIMIT = 120;
const VIEW_OVERSCAN_ROWS = 160;
const WINDOW_LOAD_CONCURRENCY = 1;
const MAX_WINDOW_CACHE_ROWS = 120_000;
const MAX_WINDOW_CACHE_WINDOWS = 400;
const MAX_ROW_HTML_CACHE = 8_000;
const VIEWED_STORAGE_KEY = 'elevenex-change-review-viewed-file-fingerprints-v1';

@Component({
  selector: 'app-change-review-panel',
  standalone: true,
  imports: [CommonModule, ScrollingModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './change-review-panel.component.html',
  styleUrl: './change-review-panel.component.scss',
  host: { class: 'block h-full min-h-0 bg-background text-foreground' },
  viewProviders: [
    provideIcons({
      lucideBinary,
      lucideChevronDown,
      lucideChevronRight,
      lucideChevronUp,
      lucideCheck,
      lucideExternalLink,
      lucideFileCode,
      lucideGitBranch,
      lucideGitMerge,
      lucideGitPullRequest,
      lucideLoader,
      lucideMessageSquarePlus,
      lucideRefreshCw,
      lucideSearch,
      lucideTriangleAlert,
    }),
  ],
})
export class ChangeReviewPanelComponent implements AfterViewInit, OnDestroy {
  readonly worktreePath = input.required<string>();
  readonly highlightedMentions = input<readonly DiffSelectionMention[]>([]);
  readonly mentionSelection = output<DiffSelectionMention[]>();
  readonly openConflicts = output<void>();

  private readonly changeReview = inject(ChangeReviewService);
  private readonly gitService = inject(GitService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly diffScroll = viewChild<ElementRef<HTMLElement>>('diffScroll');
  private readonly fileViewport = viewChild<CdkVirtualScrollViewport>('fileViewport');
  private readonly rowHtmlCache = new Map<string, SafeHtml>();
  private readonly windowQueue: WindowRequest[] = [];
  private readonly pendingWindowKeys = new Set<string>();
  private readonly windowCache = new Map<string, WindowCacheEntry>();
  private readonly fingerprintCache = new Map<string, string>();
  private readonly scopeSnapshots = new Map<string, ScopeViewSnapshot>();
  private readonly requestCancel$ = new Subject<void>();
  private readonly forceLoadedFileDiffs = signal<ReadonlySet<string>>(new Set());
  private readonly relativeTimeInterval = window.setInterval(() => {
    this.now.set(Date.now());
  }, 30_000);

  private windowCacheRows = 0;
  private inFlightWindowLoads = 0;
  private generation = 0;
  private activeScopeKey: string | null = null;
  private gitSummaryRefreshTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame: number | null = null;
  private readonly countFormatter = new Intl.NumberFormat();

  readonly rowHeightPx = ROW_HEIGHT_PX;
  readonly scopes = SCOPES;
  readonly scope = signal<ChangeReviewScope>('branch');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly search = signal('');
  readonly context = signal(8);
  readonly summary = signal<ChangeReviewSummary | null>(null);
  readonly forceLoadLargeChangeSet = signal(false);
  readonly loadingSummary = signal(false);
  readonly error = signal<string | null>(null);
  readonly now = signal(Date.now());
  readonly fileStates = signal<ReadonlyMap<string, FileRenderState>>(new Map());
  readonly activeFilePath = signal<string | null>(null);
  readonly layout = signal(new ChangeReviewVirtualLayout([]));
  readonly visibleRows = signal<RenderRow[]>([]);
  readonly renderedOffsetPx = signal(0);
  readonly loadingContextRanges = signal<ReadonlySet<string>>(new Set());
  readonly fileChangeHashes = signal<ReadonlyMap<string, string>>(new Map());
  readonly fileFingerprints = signal<ReadonlyMap<string, string>>(new Map());
  readonly viewedFingerprints = signal<Record<string, string>>(this.readViewedFingerprints());
  readonly loadingFileFingerprints = signal<ReadonlySet<string>>(new Set());
  readonly collapsedPaths = signal<ReadonlySet<string>>(new Set());
  readonly windowLoadState = signal<WindowLoadState>({ running: false, total: 0 });
  readonly selectionMentionAction = signal<DiffSelectionMentionAction | null>(null);
  readonly diffScrollLeftPx = signal(0);
  readonly diffViewportWidthPx = signal<number | null>(null);
  readonly mentionedRowKeys = computed(() => {
    const keys = new Set<string>();
    for (const mention of this.highlightedMentions()) {
      for (const row of mention.context.selected) {
        keys.add(
          diffMentionRowKey(
            mention.scope,
            mention.filePath,
            mention.changeHash,
            row.type,
            row.oldLine,
            row.newLine,
            row.content,
          ),
        );
      }
    }
    return keys;
  });

  readonly totalHeightPx = computed(() => this.layout().totalRows * ROW_HEIGHT_PX);
  readonly latestGitSummary = computed(() => this.gitService.latestSummary(this.worktreePath()));
  readonly conflictedFiles = computed(
    () => this.latestGitSummary()?.files.filter((file) => file.status === 'conflicted') ?? [],
  );
  readonly largeChangeGuard = computed<ChangeReviewLoadGuard | null>(() => {
    const guard = this.summary()?.loadGuard;
    return guard?.blocked ? guard : null;
  });
  readonly conflictCount = computed(
    () => this.largeChangeGuard()?.conflictedFiles ?? this.conflictedFiles().length,
  );
  readonly diffsOutdated = computed(() => {
    const summary = this.summary();
    const latest = this.latestGitSummary();
    if (!summary || !latest) return false;
    if (summary.loadGuard?.blocked) return false;
    if (summary.headSha !== latest.headSha) return true;
    if (summary.scope === 'last-commit') return false;
    return summary.worktreeFingerprint !== latest.worktreeFingerprint;
  });

  readonly activeFile = computed(() => {
    const activePath = this.activeFilePath();
    if (!activePath) return null;
    return (
      this.fileStates().get(activePath)?.file ??
      this.filteredFiles().find((file) => file.path === activePath) ??
      null
    );
  });
  readonly activeFileHeader = computed(() => {
    const file = this.activeFile();
    return file ? [file] : [];
  });

  readonly filteredFiles = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    const query = this.search().trim().toLowerCase();
    const status = this.statusFilter();
    return summary.files.filter((file) => {
      if (status !== 'all' && file.status !== status) return false;
      if (!query) return true;
      return (
        file.path.toLowerCase().includes(query) ||
        Boolean(file.oldPath?.toLowerCase().includes(query))
      );
    });
  });

  readonly statusFilters = computed<Array<{ value: StatusFilter; label: string; count: number }>>(
    () => {
      const files = this.summary()?.files ?? [];
      const count = (status: StatusFilter) =>
        status === 'all' ? files.length : files.filter((file) => file.status === status).length;
      const filters: Array<{ value: StatusFilter; label: string; count: number }> = [
        { value: 'all', label: 'All', count: count('all') },
        { value: 'added', label: 'Added', count: count('added') },
        { value: 'modified', label: 'Modified', count: count('modified') },
        { value: 'deleted', label: 'Deleted', count: count('deleted') },
        { value: 'renamed', label: 'Renamed', count: count('renamed') },
      ];
      return filters.filter((filter) => filter.value === 'all' || filter.count > 0);
    },
  );

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const scope = this.scope();
      if (!worktreePath || !scope) return;
      untracked(() => this.activateScope(worktreePath, scope));
    });
  }

  ngAfterViewInit(): void {
    this.setupResizeObserver();
    this.scheduleResizeRefresh();
  }

  ngOnDestroy(): void {
    this.generation += 1;
    this.cancelActiveRequests();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== null) {
      this.cancelResizeFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    window.clearInterval(this.relativeTimeInterval);
    this.requestCancel$.complete();
  }

  async refresh(refreshBase = false): Promise<void> {
    if (refreshBase) {
      this.changeReview.clearCache(this.worktreePath(), this.scope());
    }
    this.clearCurrentScopeSnapshot();
    await this.loadForCurrentScope(refreshBase);
  }

  async refreshOutdatedDiffs(): Promise<void> {
    const summary = this.summary();
    const latest = this.latestGitSummary();
    const needsBaseRefresh = Boolean(summary && latest && summary.headSha !== latest.headSha);
    this.changeReview.clearCache(this.worktreePath(), this.scope());
    this.clearCurrentScopeSnapshot();
    await this.loadForCurrentScope(needsBaseRefresh);
  }

  setScope(scope: ChangeReviewScope): void {
    if (scope === this.scope()) return;
    this.scope.set(scope);
  }

  async loadLargeChangeSet(): Promise<void> {
    this.forceLoadLargeChangeSet.set(true);
    this.changeReview.clearCache(this.worktreePath(), this.scope());
    this.clearCurrentScopeSnapshot();
    await this.loadForCurrentScope(false);
  }

  loadLargeFileDiff(file: ChangeReviewFileSummary): void {
    if (!this.shouldGateFileDiff(file)) return;
    const anchor = this.captureAnchor();
    this.forceLoadedFileDiffs.update((current) => new Set(current).add(file.path));
    this.setFileState(file.path, (state) => ({
      ...state,
      message: 'Loading large diff',
    }));
    this.rebuildLayout();
    this.restoreAnchor(anchor);
    this.refreshRenderedRows();
    this.enqueueWindow(file.path, 0, true);
  }

  setStatusFilter(filter: StatusFilter): void {
    this.statusFilter.set(filter);
    this.applyFilters(true);
  }

  setSearch(value: string): void {
    this.search.set(value);
    this.applyFilters(true);
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (!this.eventStartedInsidePanel(event) || this.isEditableTarget(event.target)) return;
    event.preventDefault();
    this.scrollToAdjacentFile(event.key === 'ArrowDown' ? 1 : -1);
  }

  onDiffScroll(): void {
    this.selectionMentionAction.set(null);
    this.updateDiffViewportMetrics();
    this.refreshRenderedRows();
    this.ensureVisibleRangeLoaded();
  }

  scrollToFile(file: ChangeReviewFileSummary): void {
    this.activeFilePath.set(file.path);
    const start = this.layout().fileStart(file.path);
    const scrollEl = this.diffScroll()?.nativeElement;
    if (start !== null && scrollEl) {
      scrollEl.scrollTop = start * ROW_HEIGHT_PX;
      this.refreshRenderedRows();
      this.ensureVisibleRangeLoaded();
      return;
    }
    this.enqueueWindow(file.path, 0, true);
  }

  prefetchFile(file: ChangeReviewFileSummary): void {
    this.enqueueWindow(file.path, 0, true);
  }

  toggleFileCollapsed(file: ChangeReviewFileSummary): void {
    this.setFileCollapsed(file.path, !this.isFileCollapsed(file), true);
  }

  toggleFileViewed(file: ChangeReviewFileSummary): void {
    void this.toggleFileViewedAsync(file);
  }

  private async toggleFileViewedAsync(file: ChangeReviewFileSummary): Promise<void> {
    if (this.loadingFileFingerprints().has(file.path)) return;
    if (this.isFileViewed(file)) {
      this.unmarkViewed(file.path);
      return;
    }

    const requestGeneration = this.generation;
    const fingerprint = await this.ensureFileFingerprint(file.path, requestGeneration, true);
    if (requestGeneration !== this.generation || !fingerprint) return;

    this.markViewed(file.path, fingerprint);
    this.setFileCollapsed(file.path, true, false);
    this.scrollToNextUnviewedFile(file.path);
  }

  openPullRequest(): void {
    const url = this.summary()?.pullRequest?.url;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  openMergeConflicts(): void {
    if (this.conflictCount() > 0) {
      this.openConflicts.emit();
    }
  }

  captureDiffSelection(): void {
    const selection = window.getSelection();
    const scrollEl = this.diffScroll()?.nativeElement;
    if (!selection || selection.isCollapsed || !selection.rangeCount || !scrollEl) {
      this.selectionMentionAction.set(null);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      !anchorNode ||
      !focusNode ||
      !scrollEl.contains(anchorNode) ||
      !scrollEl.contains(focusNode)
    ) {
      this.selectionMentionAction.set(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedRows = this.selectedDiffRows(range, scrollEl);
    if (!selectedRows.length) {
      this.selectionMentionAction.set(null);
      return;
    }

    const mentions = this.buildDiffSelectionMentions(selectedRows);
    if (!mentions.length) {
      this.selectionMentionAction.set(null);
      return;
    }

    const firstRect =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : scrollEl.getBoundingClientRect();
    const containerRect = scrollEl.getBoundingClientRect();
    this.selectionMentionAction.set({
      top: Math.max(8, firstRect.top - containerRect.top + scrollEl.scrollTop - 38),
      left: Math.max(8, firstRect.left - containerRect.left + scrollEl.scrollLeft),
      mentions,
    });
  }

  mentionCurrentSelection(): void {
    const action = this.selectionMentionAction();
    if (!action?.mentions.length) return;
    this.mentionSelection.emit(action.mentions);
    this.selectionMentionAction.set(null);
    window.getSelection()?.removeAllRanges();
    toast.success(
      action.mentions.length === 1
        ? 'Added diff selection to chat'
        : `Added ${action.mentions.length} diff selections to chat`,
    );
  }

  rowHtml(row: ChangeReviewRow): SafeHtml {
    const key = `${row.path}:${row.type}:${row.content}`;
    const cached = this.rowHtmlCache.get(key);
    if (cached) {
      this.rowHtmlCache.delete(key);
      this.rowHtmlCache.set(key, cached);
      return cached;
    }

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
    while (this.rowHtmlCache.size > MAX_ROW_HTML_CACHE) {
      const oldest = this.rowHtmlCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.rowHtmlCache.delete(oldest);
    }
    return safe;
  }

  async expandContext(
    renderRow: RenderRow,
    direction: ContextExpansionDirection = 'down',
  ): Promise<void> {
    const row = renderRow.row;
    const file = renderRow.file;
    if (!row || row.type !== 'expand' || !row.oldStart || !row.newStart || !row.count) return;
    if (this.loadingContextRanges().has(row.id)) return;

    const loadCount = Math.min(row.count, CONTEXT_RANGE_LIMIT);
    const oldStart =
      direction === 'up' ? row.oldStart + Math.max(0, row.count - loadCount) : row.oldStart;
    const newStart =
      direction === 'up' ? row.newStart + Math.max(0, row.count - loadCount) : row.newStart;
    this.setContextRangeLoading(row.id, true);
    const requestGeneration = this.generation;
    try {
      const contextWindow = await firstValueFrom(
        this.changeReview
          .getContextWindow(
            this.worktreePath(),
            this.scope(),
            file.path,
            {
              oldStart,
              newStart,
              count: loadCount,
              limit: CONTEXT_RANGE_LIMIT,
              forceFileLoad: this.isFileDiffForceLoaded(file),
            },
            this.forceLoadLargeChangeSet(),
          )
          .pipe(takeUntil(this.requestCancel$)),
      );
      if (requestGeneration !== this.generation) return;

      const loaded = contextWindow.rows.length;
      if (loaded <= 0) return;
      const replacement = this.contextReplacementRows(row, contextWindow.rows, direction);

      const anchor = this.captureAnchor();
      this.setFileState(file.path, (state) => this.replaceDiffRow(state, row.id, replacement));
      this.rebuildLayout();
      this.restoreAnchor(anchor);
      this.refreshRenderedRows();
    } catch (error: any) {
      if (requestGeneration !== this.generation) return;
      const message = error?.error?.message || 'Could not load context lines.';
      toast.error(message);
    } finally {
      if (requestGeneration !== this.generation) return;
      this.setContextRangeLoading(row.id, false);
    }
  }

  isContextRangeLoading(row: ChangeReviewRow | null): boolean {
    return row !== null && this.loadingContextRanges().has(row.id);
  }

  isFileViewed(file: ChangeReviewFileSummary): boolean {
    const viewedFingerprint = this.viewedFingerprints()[this.viewedKey(file.path)];
    if (!viewedFingerprint) return false;
    const loadedFingerprint = this.fileFingerprints().get(file.path);
    return !loadedFingerprint || loadedFingerprint === viewedFingerprint;
  }

  isFileLoaded(file: ChangeReviewFileSummary): boolean {
    return Boolean(this.fileChangeHashes().get(file.path));
  }

  isFileFingerprintLoading(file: ChangeReviewFileSummary): boolean {
    return this.loadingFileFingerprints().has(file.path);
  }

  isFileCollapsed(file: ChangeReviewFileSummary): boolean {
    return this.collapsedPaths().has(file.path);
  }

  isSelectedFile(file: ChangeReviewFileSummary): boolean {
    return this.activeFilePath() === file.path;
  }

  fileTrack(index: number, file: ChangeReviewFileSummary): string {
    return `${file.status}:${file.oldPath ?? ''}:${file.path}`;
  }

  renderRowTrack(index: number, row: RenderRow): string {
    return row.id;
  }

  isMentionedDiffRow(renderRow: RenderRow): boolean {
    const row = renderRow.row;
    if (renderRow.kind !== 'diff' || !row) return false;
    return this.mentionedRowKeys().has(
      diffMentionRowKey(
        this.scope(),
        renderRow.file.path,
        renderRow.state.changeHash,
        row.type,
        row.oldLine,
        row.newLine,
        row.content,
      ),
    );
  }

  fileBasename(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  fileDirname(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  headerTranslateX(): string {
    return `translateX(${this.diffScrollLeftPx()}px)`;
  }

  fileMetaText(row: RenderRow): string {
    if (this.shouldGateFileDiff(row.file)) {
      return `${this.largeFileDiffText(row.file)} hidden by default`;
    }
    if (row.state.message) return row.state.message;
    if (row.file.oldPath) return `renamed from ${row.file.oldPath}`;
    if (row.state.loadingOffsets.size > 0) return 'Loading diff window';
    if (!row.state.changeHash) return 'Diff not loaded yet';
    return row.state.baseRowCount === null ? '' : `${row.state.baseRowCount} diff rows`;
  }

  statusLabel(status: ChangeReviewFileStatus): string {
    switch (status) {
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'modified':
        return 'M';
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
    const elapsedSeconds = Math.max(
      0,
      Math.floor((this.now() - new Date(summary.generatedAt).getTime()) / 1000),
    );
    if (elapsedSeconds < 10) return 'just now';
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 48) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
  }

  prefetchText(state: WindowLoadState): string {
    if (!state.running) return '';
    return `loading ${state.total} diff window${state.total === 1 ? '' : 's'}`;
  }

  formatCount(value: number): string {
    return this.countFormatter.format(value);
  }

  guardedReasonText(guard: ChangeReviewLoadGuard): string {
    return guard.reason === 'worktree' ? 'pending or staged files' : 'files in this scope';
  }

  changedLineCount(file: ChangeReviewFileSummary): number {
    return file.additions + file.deletions;
  }

  shouldGateFileDiff(file: ChangeReviewFileSummary): boolean {
    return (
      !file.binary &&
      this.changedLineCount(file) > FILE_DIFF_AUTO_LOAD_CHANGE_LIMIT &&
      !this.isFileDiffForceLoaded(file)
    );
  }

  largeFileDiffText(file: ChangeReviewFileSummary): string {
    return `${this.formatCount(this.changedLineCount(file))} changed lines`;
  }

  private activateScope(worktreePath: string, scope: ChangeReviewScope): void {
    const nextKey = this.scopeSnapshotKey(worktreePath, scope);
    if (this.activeScopeKey === nextKey) return;

    this.saveActiveScopeSnapshot();
    this.activeScopeKey = nextKey;

    const snapshot = this.scopeSnapshots.get(nextKey);
    if (snapshot) {
      this.restoreScopeSnapshot(snapshot, worktreePath);
      return;
    }

    this.forceLoadLargeChangeSet.set(false);
    void this.loadForCurrentScope(false);
  }

  private saveActiveScopeSnapshot(): void {
    const key = this.activeScopeKey;
    const summary = this.summary();
    if (!key || !summary || this.scopeSnapshotKey(summary.worktreePath, summary.scope) !== key) {
      return;
    }

    const scrollEl = this.diffScroll()?.nativeElement;
    this.scopeSnapshots.set(key, {
      summary,
      fileStates: this.snapshotFileStates(),
      fileChangeHashes: new Map(this.fileChangeHashes()),
      fileFingerprints: new Map(this.fileFingerprints()),
      activeFilePath: this.activeFilePath(),
      collapsedPaths: new Set(this.collapsedPaths()),
      forceLoadedFileDiffs: new Set(this.forceLoadedFileDiffs()),
      forceLoadLargeChangeSet: this.forceLoadLargeChangeSet(),
      windowCache: new Map(this.windowCache),
      windowCacheRows: this.windowCacheRows,
      scrollTop: scrollEl?.scrollTop ?? 0,
      scrollLeft: scrollEl?.scrollLeft ?? this.diffScrollLeftPx(),
    });
  }

  private snapshotFileStates(): ReadonlyMap<string, FileRenderState> {
    return new Map(
      Array.from(this.fileStates()).map(([path, state]) => [
        path,
        {
          ...state,
          loadingOffsets: new Set<number>(),
        },
      ]),
    );
  }

  private restoreScopeSnapshot(snapshot: ScopeViewSnapshot, worktreePath: string): void {
    const requestGeneration = this.generation + 1;
    this.generation = requestGeneration;
    this.cancelActiveRequests();
    this.resetQueues();
    this.restoreWindowCache(snapshot);

    this.loadingSummary.set(false);
    this.error.set(null);
    this.summary.set(snapshot.summary);
    this.fileStates.set(snapshot.fileStates);
    this.fileChangeHashes.set(snapshot.fileChangeHashes);
    this.fileFingerprints.set(snapshot.fileFingerprints);
    this.collapsedPaths.set(snapshot.collapsedPaths);
    this.forceLoadedFileDiffs.set(snapshot.forceLoadedFileDiffs);
    this.forceLoadLargeChangeSet.set(snapshot.forceLoadLargeChangeSet);
    this.loadingContextRanges.set(new Set());
    this.loadingFileFingerprints.set(new Set());
    this.selectionMentionAction.set(null);
    this.now.set(Date.now());

    this.rebuildLayout();
    const files = this.filteredFiles();
    this.activeFilePath.set(
      snapshot.activeFilePath && files.some((file) => file.path === snapshot.activeFilePath)
        ? snapshot.activeFilePath
        : (files[0]?.path ?? null),
    );
    this.visibleRows.set([]);
    this.renderedOffsetPx.set(0);
    this.restoreScrollPosition(snapshot.scrollTop, snapshot.scrollLeft);
    if (!snapshot.summary.loadGuard?.blocked) {
      this.scheduleGitSummaryRefresh(worktreePath, requestGeneration);
    }
  }

  private restoreWindowCache(snapshot: ScopeViewSnapshot): void {
    this.windowCache.clear();
    for (const [key, entry] of snapshot.windowCache) {
      this.windowCache.set(key, { ...entry });
    }
    this.windowCacheRows = snapshot.windowCacheRows;
  }

  private restoreScrollPosition(scrollTop: number, scrollLeft: number): void {
    const applyScroll = () => {
      const scrollEl = this.diffScroll()?.nativeElement;
      if (!scrollEl) {
        this.visibleRows.set([]);
        this.renderedOffsetPx.set(0);
        return;
      }
      scrollEl.scrollTop = scrollTop;
      scrollEl.scrollLeft = scrollLeft;
      this.updateDiffViewportMetrics();
      this.refreshRenderedRows();
      this.ensureVisibleRangeLoaded();
    };

    applyScroll();
    window.setTimeout(applyScroll, 0);
  }

  private clearCurrentScopeSnapshot(): void {
    this.scopeSnapshots.delete(this.scopeSnapshotKey(this.worktreePath(), this.scope()));
  }

  private scopeSnapshotKey(worktreePath: string, scope: ChangeReviewScope): string {
    return `${worktreePath}\0${scope}`;
  }

  private async loadForCurrentScope(refreshBase: boolean): Promise<void> {
    const worktreePath = this.worktreePath();
    const scope = this.scope();
    const requestGeneration = this.generation + 1;
    this.generation = requestGeneration;
    this.cancelActiveRequests();
    this.resetQueues();
    this.loadingSummary.set(true);
    this.error.set(null);
    this.summary.set(null);
    this.fileStates.set(new Map());
    this.fileChangeHashes.set(new Map());
    this.fileFingerprints.set(new Map());
    this.activeFilePath.set(null);
    this.layout.set(new ChangeReviewVirtualLayout([]));
    this.visibleRows.set([]);
    this.renderedOffsetPx.set(0);
    this.diffScrollLeftPx.set(0);
    this.diffViewportWidthPx.set(null);
    this.loadingContextRanges.set(new Set());
    this.loadingFileFingerprints.set(new Set());
    this.selectionMentionAction.set(null);
    this.forceLoadedFileDiffs.set(new Set());
    this.rowHtmlCache.clear();
    this.now.set(Date.now());

    try {
      const summary = await firstValueFrom(
        this.changeReview
          .getSummary(worktreePath, scope, refreshBase, this.forceLoadLargeChangeSet())
          .pipe(takeUntil(this.requestCancel$)),
      );
      if (requestGeneration !== this.generation) return;

      this.summary.set(summary);
      this.fileStates.set(
        new Map(
          (summary.loadGuard?.blocked ? [] : summary.files).map((file) => [
            file.path,
            this.createFileState(file),
          ]),
        ),
      );
      this.applyFilters(true);
      if (!summary.loadGuard?.blocked) {
        this.validateSavedViewedFingerprints(summary, requestGeneration);
        this.scheduleGitSummaryRefresh(worktreePath, requestGeneration);
      }
    } catch (error: any) {
      if (requestGeneration !== this.generation) return;
      const message = error?.error?.message || 'Could not load changes.';
      this.error.set(message);
      toast.error(message);
    } finally {
      if (requestGeneration === this.generation) {
        this.loadingSummary.set(false);
      }
    }
  }

  private scheduleGitSummaryRefresh(worktreePath: string, requestGeneration: number): void {
    if (this.gitSummaryRefreshTimer !== null) {
      window.clearTimeout(this.gitSummaryRefreshTimer);
    }
    this.gitSummaryRefreshTimer = window.setTimeout(() => {
      this.gitSummaryRefreshTimer = null;
      void this.refreshGitSummary(worktreePath, requestGeneration);
    }, 250);
  }

  private async refreshGitSummary(worktreePath: string, requestGeneration: number): Promise<void> {
    if (requestGeneration !== this.generation) return;
    try {
      await firstValueFrom(
        this.gitService.getSummary(worktreePath).pipe(takeUntil(this.requestCancel$)),
      );
    } catch {
      // Keep the change-review UI usable if the lightweight git status refresh fails.
    }
  }

  private createFileState(file: ChangeReviewFileSummary): FileRenderState {
    return {
      file,
      diffRowCount: this.initialDiffRowCount(file),
      baseRowCount: null,
      baseRows: new Map(),
      loadingOffsets: new Set(),
      replacements: [],
      message: null,
      binary: file.binary,
      large: file.large,
      truncated: false,
      changeHash: null,
    };
  }

  private initialDiffRowCount(file: ChangeReviewFileSummary): number {
    return this.shouldGateFileDiff(file) ? 1 : estimateChangeReviewDiffRows(file, this.context());
  }

  private applyFilters(scrollToTop: boolean): void {
    this.rebuildLayout();
    const files = this.filteredFiles();
    this.activeFilePath.set(files[0]?.path ?? null);
    if (scrollToTop) {
      window.setTimeout(() => {
        const scrollEl = this.diffScroll()?.nativeElement;
        if (scrollEl) scrollEl.scrollTop = 0;
        this.updateDiffViewportMetrics();
        this.refreshRenderedRows();
        this.ensureVisibleRangeLoaded();
      }, 0);
      return;
    }
    this.updateDiffViewportMetrics();
    this.refreshRenderedRows();
    this.ensureVisibleRangeLoaded();
  }

  private rebuildLayout(): void {
    const states = this.fileStates();
    this.layout.set(
      new ChangeReviewVirtualLayout(
        this.filteredFiles().map((file) => ({
          path: file.path,
          headerRows: this.isFileCollapsed(file) ? 1 : 2,
          diffRows: this.isFileCollapsed(file)
            ? 0
            : (states.get(file.path)?.diffRowCount ?? this.initialDiffRowCount(file)),
        })),
      ),
    );
  }

  private refreshRenderedRows(): void {
    const layout = this.layout();
    const scrollEl = this.diffScroll()?.nativeElement;
    if (!scrollEl || layout.totalRows === 0) {
      this.visibleRows.set([]);
      this.renderedOffsetPx.set(0);
      return;
    }
    this.updateDiffViewportMetrics();

    const visibleStart = Math.max(0, Math.floor(scrollEl.scrollTop / ROW_HEIGHT_PX));
    const visibleEnd = Math.min(
      layout.totalRows,
      Math.ceil((scrollEl.scrollTop + scrollEl.clientHeight) / ROW_HEIGHT_PX),
    );
    const renderStart = Math.max(0, visibleStart - VIEW_OVERSCAN_ROWS);
    const renderEnd = Math.min(
      layout.totalRows,
      Math.max(visibleEnd + VIEW_OVERSCAN_ROWS, renderStart + 1),
    );
    const topPosition = layout.positionForIndex(visibleStart);

    this.renderedOffsetPx.set(renderStart * ROW_HEIGHT_PX);
    this.visibleRows.set(this.buildRenderRows(renderStart, renderEnd));
    if (topPosition && topPosition.path !== this.activeFilePath()) {
      this.activeFilePath.set(topPosition.path);
      this.enqueueWindow(topPosition.path, 0, true);
    }
  }

  private buildRenderRows(startIndex: number, endIndex: number): RenderRow[] {
    const layout = this.layout();
    const states = this.fileStates();
    const rows: RenderRow[] = [];

    for (let index = startIndex; index < endIndex; index += 1) {
      const position = layout.positionForIndex(index);
      if (!position) continue;
      const state = states.get(position.path);
      if (!state) continue;

      if (position.headerIndex === 0) {
        rows.push({
          id: `${position.path}:header`,
          kind: 'fileHeader',
          file: state.file,
          state,
          row: null,
          diffIndex: null,
          baseIndex: null,
        });
        continue;
      }

      if (position.headerIndex === 1) {
        rows.push({
          id: `${position.path}:meta`,
          kind: 'fileMeta',
          file: state.file,
          state,
          row: null,
          diffIndex: null,
          baseIndex: null,
        });
        continue;
      }

      if (position.diffIndex === 0 && this.shouldGateFileDiff(state.file)) {
        rows.push({
          id: `${position.path}:large-diff-gate`,
          kind: 'largeDiffGate',
          file: state.file,
          state,
          row: null,
          diffIndex: 0,
          baseIndex: null,
        });
        continue;
      }

      const diffIndex = position.diffIndex ?? 0;
      const resolved = this.resolveDiffRow(state, diffIndex);
      if (resolved.baseIndex !== null && resolved.row) {
        this.touchWindow(state.file.path, resolved.baseIndex);
      }
      rows.push({
        id: resolved.row
          ? `${position.path}:diff:${diffIndex}:${resolved.row.id}`
          : `${position.path}:placeholder:${diffIndex}`,
        kind: 'diff',
        file: state.file,
        state,
        row: resolved.row,
        diffIndex,
        baseIndex: resolved.baseIndex,
      });
    }

    return rows;
  }

  private ensureVisibleRangeLoaded(): void {
    const scrollEl = this.diffScroll()?.nativeElement;
    const layout = this.layout();
    if (layout.totalRows === 0) return;

    const viewportRows = scrollEl ? Math.ceil(scrollEl.clientHeight / ROW_HEIGHT_PX) : 40;
    const visibleStart = scrollEl ? Math.floor(scrollEl.scrollTop / ROW_HEIGHT_PX) : 0;
    const startIndex = Math.max(0, visibleStart - VIEW_OVERSCAN_ROWS);
    const endIndex = Math.min(layout.totalRows, visibleStart + viewportRows + VIEW_OVERSCAN_ROWS);
    this.ensureRangeLoaded(startIndex, endIndex);
    this.pruneQueuedWindowsForRange(startIndex, endIndex);
  }

  private ensureRangeLoaded(startIndex: number, endIndex: number): void {
    const states = this.fileStates();
    const activePath = this.activeFilePath();
    for (const segment of this.layout().segmentsForRange(startIndex, endIndex)) {
      const state = states.get(segment.path);
      if (!state) continue;
      if (this.collapsedPaths().has(segment.path)) continue;
      if (this.shouldGateFileDiff(state.file)) continue;

      if (segment.path === activePath || segment.diffEnd > segment.diffStart) {
        this.enqueueWindow(segment.path, 0, segment.path === activePath);
      }

      for (let diffIndex = segment.diffStart; diffIndex < segment.diffEnd; diffIndex += 1) {
        const resolved = this.resolveDiffRow(state, diffIndex);
        if (resolved.baseIndex === null || resolved.row) continue;
        if (state.baseRowCount !== null && resolved.baseIndex >= state.baseRowCount) continue;
        const offset = Math.floor(resolved.baseIndex / WINDOW_LIMIT) * WINDOW_LIMIT;
        this.enqueueWindow(segment.path, offset, false);
        diffIndex = Math.min(segment.diffEnd, offset + WINDOW_LIMIT) - 1;
      }
    }
  }

  private pruneQueuedWindowsForRange(startIndex: number, endIndex: number): void {
    if (this.windowQueue.length === 0) return;

    const keep = this.windowKeysForRange(startIndex, endIndex);
    const nextQueue: WindowRequest[] = [];
    for (const request of this.windowQueue) {
      if (request.generation === this.generation && keep.has(request.key)) {
        nextQueue.push(request);
        continue;
      }
      this.pendingWindowKeys.delete(request.key);
    }

    if (nextQueue.length !== this.windowQueue.length) {
      this.windowQueue.splice(0, this.windowQueue.length, ...nextQueue);
      this.updateWindowLoadState();
    }
  }

  private windowKeysForRange(startIndex: number, endIndex: number): Set<string> {
    const keep = new Set<string>();
    const states = this.fileStates();
    const activePath = this.activeFilePath();
    if (activePath && states.has(activePath) && !this.collapsedPaths().has(activePath)) {
      const state = states.get(activePath);
      if (state && !this.shouldGateFileDiff(state.file)) {
        keep.add(this.windowKey(activePath, 0));
      }
    }

    for (const segment of this.layout().segmentsForRange(startIndex, endIndex)) {
      const state = states.get(segment.path);
      if (!state || this.collapsedPaths().has(segment.path)) continue;
      if (this.shouldGateFileDiff(state.file)) continue;
      if (segment.diffEnd > segment.diffStart) {
        keep.add(this.windowKey(segment.path, 0));
      }

      for (let diffIndex = segment.diffStart; diffIndex < segment.diffEnd; diffIndex += 1) {
        const resolved = this.resolveDiffRow(state, diffIndex);
        if (resolved.baseIndex === null || resolved.row) continue;
        if (state.baseRowCount !== null && resolved.baseIndex >= state.baseRowCount) continue;
        const offset = Math.floor(resolved.baseIndex / WINDOW_LIMIT) * WINDOW_LIMIT;
        keep.add(this.windowKey(segment.path, offset));
        diffIndex = Math.min(segment.diffEnd, offset + WINDOW_LIMIT) - 1;
      }
    }

    return keep;
  }

  private enqueueWindow(filePath: string, offset: number, priority: boolean): void {
    const state = this.fileStates().get(filePath);
    if (!state) return;
    if (this.shouldGateFileDiff(state.file)) return;
    const safeOffset = Math.max(0, Math.floor(offset / WINDOW_LIMIT) * WINDOW_LIMIT);
    if (state.baseRowCount !== null && state.baseRowCount <= safeOffset && state.baseRowCount > 0)
      return;
    const key = this.windowKey(filePath, safeOffset);
    if (
      this.windowCache.has(key) ||
      this.pendingWindowKeys.has(key) ||
      state.loadingOffsets.has(safeOffset)
    ) {
      return;
    }

    const request: WindowRequest = {
      generation: this.generation,
      filePath,
      offset: safeOffset,
      key,
    };
    this.pendingWindowKeys.add(key);
    if (priority) {
      this.windowQueue.unshift(request);
    } else {
      this.windowQueue.push(request);
    }
    this.updateWindowLoadState();
    this.pumpWindowQueue();
  }

  private pumpWindowQueue(): void {
    while (this.inFlightWindowLoads < WINDOW_LOAD_CONCURRENCY && this.windowQueue.length > 0) {
      const request = this.windowQueue.shift()!;
      if (request.generation !== this.generation) {
        this.pendingWindowKeys.delete(request.key);
        continue;
      }
      this.startWindowLoad(request);
    }
    this.updateWindowLoadState();
  }

  private startWindowLoad(request: WindowRequest): void {
    this.inFlightWindowLoads += 1;
    this.setFileState(request.filePath, (state) => ({
      ...state,
      loadingOffsets: new Set(state.loadingOffsets).add(request.offset),
    }));

    void firstValueFrom(
      this.changeReview
        .getFileWindow(
          this.worktreePath(),
          this.scope(),
          request.filePath,
          {
            offset: request.offset,
            limit: WINDOW_LIMIT,
            context: this.context(),
            forceFileLoad: this.isFileDiffForceLoadedPath(request.filePath),
          },
          this.forceLoadLargeChangeSet(),
        )
        .pipe(takeUntil(this.requestCancel$)),
    )
      .then((fileWindow) => this.applyFileWindow(fileWindow, request))
      .catch((error: any) => {
        if (request.generation === this.generation) {
          const message = error?.error?.message || 'Could not load file diff.';
          toast.error(message);
        }
      })
      .finally(() => {
        if (request.generation !== this.generation) return;
        this.inFlightWindowLoads = Math.max(0, this.inFlightWindowLoads - 1);
        this.pendingWindowKeys.delete(request.key);
        this.setFileState(request.filePath, (state) => {
          const loadingOffsets = new Set(state.loadingOffsets);
          loadingOffsets.delete(request.offset);
          return { ...state, loadingOffsets };
        });
        this.updateWindowLoadState();
        this.refreshRenderedRows();
        this.pumpWindowQueue();
      });
  }

  private applyFileWindow(fileWindow: ChangeReviewFileWindow, request: WindowRequest): void {
    if (request.generation !== this.generation) return;
    const anchor = this.captureAnchor();
    this.rememberFileChangeHash(fileWindow.path, fileWindow.changeHash);
    this.setFileState(fileWindow.path, (state) => {
      const baseRows = new Map(state.baseRows);
      fileWindow.rows.forEach((row, index) => {
        baseRows.set(request.offset + index, row);
      });
      const replacements = state.replacements;
      const replacementDelta = this.replacementDelta(replacements);
      const baseRowCount = fileWindow.totalRows;
      return {
        ...state,
        file: {
          ...state.file,
          oldPath: fileWindow.oldPath,
          status: fileWindow.status,
          binary: fileWindow.binary,
          large: fileWindow.large,
        },
        baseRows,
        baseRowCount,
        diffRowCount: Math.max(1, baseRowCount + replacementDelta),
        message: fileWindow.message,
        binary: fileWindow.binary,
        large: fileWindow.large,
        truncated: fileWindow.truncated,
        changeHash: fileWindow.changeHash,
      };
    });
    this.rememberWindow(fileWindow.path, request.offset, fileWindow.rows.length);
    this.rebuildLayout();
    this.restoreAnchor(anchor);
    this.refreshRenderedRows();
    this.pruneWindowCache();
  }

  private resolveDiffRow(state: FileRenderState, diffIndex: number): ResolvedDiffRow {
    let shift = 0;
    for (
      let replacementIndex = 0;
      replacementIndex < state.replacements.length;
      replacementIndex += 1
    ) {
      const replacement = state.replacements[replacementIndex];
      const virtualStart = replacement.baseIndex + shift;
      const virtualEnd = virtualStart + replacement.rows.length;
      if (diffIndex < virtualStart) {
        const baseIndex = diffIndex - shift;
        return {
          row: state.baseRows.get(baseIndex) ?? null,
          baseIndex,
        };
      }
      if (diffIndex < virtualEnd) {
        return {
          row: replacement.rows[diffIndex - virtualStart] ?? null,
          baseIndex: null,
        };
      }
      shift += replacement.rows.length - 1;
    }

    const baseIndex = diffIndex - shift;
    return {
      row: state.baseRows.get(baseIndex) ?? null,
      baseIndex,
    };
  }

  private contextReplacementRows(
    row: ChangeReviewRow,
    loadedRows: ChangeReviewRow[],
    direction: ContextExpansionDirection,
  ): ChangeReviewRow[] {
    const remaining = Math.max(0, (row.count ?? 0) - loadedRows.length);
    if (remaining === 0) return loadedRows;

    if (direction === 'up') {
      return [
        this.expandPlaceholderRow(row, row.oldStart ?? 1, row.newStart ?? 1, remaining),
        ...loadedRows,
      ];
    }

    return [
      ...loadedRows,
      this.expandPlaceholderRow(
        row,
        (row.oldStart ?? 1) + loadedRows.length,
        (row.newStart ?? 1) + loadedRows.length,
        remaining,
      ),
    ];
  }

  private expandPlaceholderRow(
    source: ChangeReviewRow,
    oldStart: number,
    newStart: number,
    count: number,
  ): ChangeReviewRow {
    return {
      ...source,
      id: `${source.path}:expand:${oldStart}:${newStart}:${count}`,
      oldStart,
      newStart,
      count,
      content: `${count} unchanged line${count === 1 ? '' : 's'}`,
    };
  }

  private replaceDiffRow(
    state: FileRenderState,
    rowId: string,
    replacementRows: ChangeReviewRow[],
  ): FileRenderState {
    for (
      let replacementIndex = 0;
      replacementIndex < state.replacements.length;
      replacementIndex += 1
    ) {
      const replacement = state.replacements[replacementIndex];
      const rowIndex = replacement.rows.findIndex((row) => row.id === rowId);
      if (rowIndex === -1) continue;

      const nextRows = [
        ...replacement.rows.slice(0, rowIndex),
        ...replacementRows,
        ...replacement.rows.slice(rowIndex + 1),
      ];
      const replacements = state.replacements.map((candidate, index) =>
        index === replacementIndex ? { ...candidate, rows: nextRows } : candidate,
      );
      return {
        ...state,
        replacements,
        diffRowCount: this.diffRowCountFor(state.baseRowCount, state.diffRowCount, replacements),
      };
    }

    for (const [baseIndex, row] of state.baseRows.entries()) {
      if (row.id !== rowId) continue;
      const replacements = [...state.replacements, { baseIndex, rows: replacementRows }].sort(
        (left, right) => left.baseIndex - right.baseIndex,
      );
      return {
        ...state,
        replacements,
        diffRowCount: this.diffRowCountFor(state.baseRowCount, state.diffRowCount, replacements),
      };
    }

    return state;
  }

  private diffRowCountFor(
    baseRowCount: number | null,
    currentDiffRowCount: number,
    replacements: readonly DiffReplacement[],
  ): number {
    const baseCount = baseRowCount ?? currentDiffRowCount;
    return Math.max(1, baseCount + this.replacementDelta(replacements));
  }

  private replacementDelta(replacements: readonly DiffReplacement[]): number {
    return replacements.reduce((sum, replacement) => sum + replacement.rows.length - 1, 0);
  }

  private captureAnchor(): ChangeReviewVirtualAnchor | null {
    const scrollEl = this.diffScroll()?.nativeElement;
    return scrollEl ? this.layout().anchorForScrollTop(scrollEl.scrollTop, ROW_HEIGHT_PX) : null;
  }

  private restoreAnchor(anchor: ChangeReviewVirtualAnchor | null): void {
    if (!anchor) return;
    queueMicrotask(() => {
      const scrollEl = this.diffScroll()?.nativeElement;
      if (!scrollEl) return;
      scrollEl.scrollTop = this.layout().scrollTopForAnchor(anchor, ROW_HEIGHT_PX);
      this.refreshRenderedRows();
      this.ensureVisibleRangeLoaded();
    });
  }

  private scrollToAdjacentFile(delta: 1 | -1): void {
    const files = this.filteredFiles();
    if (files.length === 0) return;
    const activePath = this.activeFilePath();
    if (!activePath) {
      this.scrollToFile(delta > 0 ? files[0] : files[files.length - 1]);
      return;
    }
    const currentIndex = files.findIndex((file) => file.path === activePath);
    const nextIndex =
      currentIndex === -1 ? (delta > 0 ? 0 : files.length - 1) : currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= files.length) return;
    this.scrollToFile(files[nextIndex]);
  }

  private scrollToNextUnviewedFile(currentPath: string): void {
    const files = this.filteredFiles();
    if (files.length === 0) return;
    const currentIndex = files.findIndex((file) => file.path === currentPath);
    const ordered = [
      ...files.slice(Math.max(0, currentIndex + 1)),
      ...files.slice(0, Math.max(0, currentIndex)),
    ];
    const nextFile = ordered.find((file) => !this.isFileViewed(file));
    if (nextFile) {
      this.scrollToFile(nextFile);
    }
  }

  private setFileCollapsed(filePath: string, collapsed: boolean, preserveAnchor: boolean): void {
    const current = this.collapsedPaths();
    if (current.has(filePath) === collapsed) return;
    const anchor = preserveAnchor ? this.captureAnchor() : null;
    this.collapsedPaths.update((paths) => {
      const next = new Set(paths);
      if (collapsed) {
        next.add(filePath);
      } else {
        next.delete(filePath);
      }
      return next;
    });
    this.rebuildLayout();
    if (preserveAnchor) {
      this.restoreAnchor(anchor);
    } else {
      this.refreshRenderedRows();
      this.ensureVisibleRangeLoaded();
    }
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.scheduleResizeRefresh());
    this.resizeObserver.observe(this.elementRef.nativeElement);
  }

  private scheduleResizeRefresh(): void {
    if (this.resizeFrame !== null) return;
    this.resizeFrame = this.requestResizeFrame(() => {
      this.resizeFrame = null;
      this.refreshAfterResize();
    });
  }

  private refreshAfterResize(): void {
    this.fileViewport()?.checkViewportSize();
    this.updateDiffViewportMetrics();
    this.refreshRenderedRows();
    this.ensureVisibleRangeLoaded();
  }

  private requestResizeFrame(callback: FrameRequestCallback): number {
    if (typeof window.requestAnimationFrame === 'function') {
      return window.requestAnimationFrame(callback);
    }
    return window.setTimeout(() => callback(Date.now()), 0);
  }

  private cancelResizeFrame(frame: number): void {
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(frame);
      return;
    }
    window.clearTimeout(frame);
  }

  private updateDiffViewportMetrics(): void {
    const scrollEl = this.diffScroll()?.nativeElement;
    if (!scrollEl) return;
    this.diffScrollLeftPx.set(scrollEl.scrollLeft);
    this.diffViewportWidthPx.set(scrollEl.clientWidth || null);
  }

  private setFileState(
    filePath: string,
    updater: (state: FileRenderState) => FileRenderState,
  ): void {
    this.fileStates.update((current) => {
      const state = current.get(filePath);
      if (!state) return current;
      const nextState = updater(state);
      if (nextState === state) return current;
      const next = new Map(current);
      next.set(filePath, nextState);
      return next;
    });
  }

  private rememberWindow(filePath: string, offset: number, length: number): void {
    if (length <= 0) return;
    const key = this.windowKey(filePath, offset);
    const existing = this.windowCache.get(key);
    if (existing) {
      this.windowCacheRows -= existing.length;
      this.windowCache.delete(key);
    }
    this.windowCache.set(key, { path: filePath, offset, length });
    this.windowCacheRows += length;
  }

  private touchWindow(filePath: string, baseIndex: number): void {
    const offset = Math.floor(baseIndex / WINDOW_LIMIT) * WINDOW_LIMIT;
    const key = this.windowKey(filePath, offset);
    const entry = this.windowCache.get(key);
    if (!entry) return;
    this.windowCache.delete(key);
    this.windowCache.set(key, entry);
  }

  private pruneWindowCache(): void {
    if (
      this.windowCache.size <= MAX_WINDOW_CACHE_WINDOWS &&
      this.windowCacheRows <= MAX_WINDOW_CACHE_ROWS
    ) {
      return;
    }

    const protectedKeys = new Set(
      this.visibleRows()
        .filter((row) => row.baseIndex !== null)
        .map((row) =>
          this.windowKey(
            row.file.path,
            Math.floor((row.baseIndex ?? 0) / WINDOW_LIMIT) * WINDOW_LIMIT,
          ),
        ),
    );

    while (
      this.windowCache.size > MAX_WINDOW_CACHE_WINDOWS ||
      this.windowCacheRows > MAX_WINDOW_CACHE_ROWS
    ) {
      const victimKey = [...this.windowCache.keys()].find((key) => !protectedKeys.has(key));
      if (!victimKey) return;
      const victim = this.windowCache.get(victimKey);
      if (!victim) return;
      this.windowCache.delete(victimKey);
      this.windowCacheRows -= victim.length;
      this.removeWindowRows(victim);
    }
  }

  private removeWindowRows(entry: WindowCacheEntry): void {
    this.setFileState(entry.path, (state) => {
      const baseRows = new Map(state.baseRows);
      for (let index = entry.offset; index < entry.offset + entry.length; index += 1) {
        baseRows.delete(index);
      }
      return { ...state, baseRows };
    });
  }

  private windowKey(filePath: string, offset: number): string {
    return `${this.worktreePath()}\0${this.scope()}\0${filePath}\0${this.context()}\0${offset}`;
  }

  private updateWindowLoadState(): void {
    const total = this.windowQueue.length + this.inFlightWindowLoads;
    this.windowLoadState.set({ running: total > 0, total });
  }

  private cancelActiveRequests(): void {
    if (this.gitSummaryRefreshTimer !== null) {
      window.clearTimeout(this.gitSummaryRefreshTimer);
      this.gitSummaryRefreshTimer = null;
    }
    this.requestCancel$.next();
  }

  private resetQueues(): void {
    this.windowQueue.length = 0;
    this.pendingWindowKeys.clear();
    this.windowCache.clear();
    this.windowCacheRows = 0;
    this.inFlightWindowLoads = 0;
    this.windowLoadState.set({ running: false, total: 0 });
  }

  private validateSavedViewedFingerprints(
    summary: ChangeReviewSummary,
    requestGeneration: number,
  ): void {
    this.pruneViewedFingerprintsForSummary(summary);
    const paths = summary.files
      .map((file) => file.path)
      .filter((filePath) => Boolean(this.viewedFingerprints()[this.viewedKey(filePath)]));
    if (paths.length === 0) return;

    void this.fetchFileFingerprints(paths, requestGeneration).catch(() => {
      // Keep optimistic viewed state if the lightweight validation request fails.
    });
  }

  private pruneViewedFingerprintsForSummary(summary: ChangeReviewSummary): void {
    const prefix = `${encodeURIComponent(summary.worktreePath)}|${summary.scope}|`;
    const currentPaths = new Set(summary.files.map((file) => file.path));
    this.viewedFingerprints.update((current) => {
      let next: Record<string, string> | null = null;
      for (const key of Object.keys(current)) {
        if (!key.startsWith(prefix)) continue;
        const encodedPath = key.slice(prefix.length);
        const filePath = this.safeDecodeViewedPath(encodedPath);
        if (filePath && currentPaths.has(filePath)) continue;
        next ??= { ...current };
        delete next[key];
      }
      if (!next) return current;
      this.writeViewedFingerprints(next);
      return next;
    });
  }

  private safeDecodeViewedPath(encodedPath: string): string | null {
    try {
      return decodeURIComponent(encodedPath);
    } catch {
      return null;
    }
  }

  private async ensureFileFingerprint(
    filePath: string,
    requestGeneration: number,
    showError: boolean,
  ): Promise<string | null> {
    const existing = this.fileFingerprints().get(filePath);
    if (existing) return existing;

    try {
      const fingerprints = await this.fetchFileFingerprints([filePath], requestGeneration);
      return fingerprints.get(filePath) ?? null;
    } catch (error: any) {
      if (showError && requestGeneration === this.generation) {
        const message = error?.error?.message || 'Could not identify the file content.';
        toast.error(message);
      }
      return null;
    }
  }

  private async fetchFileFingerprints(
    paths: readonly string[],
    requestGeneration: number,
  ): Promise<Map<string, string>> {
    const summary = this.summary();
    if (!summary || requestGeneration !== this.generation) return new Map();

    const result = new Map<string, string>();
    const missingPaths: string[] = [];
    for (const filePath of [...new Set(paths)]) {
      const cached = this.fingerprintCache.get(this.fileFingerprintCacheKey(summary, filePath));
      if (cached) {
        result.set(filePath, cached);
        this.rememberFileFingerprint(filePath, cached);
      } else {
        missingPaths.push(filePath);
      }
    }

    if (missingPaths.length === 0) return result;

    this.setFileFingerprintLoading(missingPaths, true);
    try {
      const response = await firstValueFrom(
        this.changeReview
          .getFileFingerprints(
            summary.worktreePath,
            summary.scope,
            missingPaths,
            this.forceLoadLargeChangeSet(),
          )
          .pipe(takeUntil(this.requestCancel$)),
      );
      if (requestGeneration !== this.generation) return result;

      for (const item of response.fingerprints) {
        this.fingerprintCache.set(
          this.fileFingerprintCacheKey(summary, item.path),
          item.fingerprint,
        );
        result.set(item.path, item.fingerprint);
        this.rememberFileFingerprint(item.path, item.fingerprint);
      }
      return result;
    } finally {
      if (requestGeneration === this.generation) {
        this.setFileFingerprintLoading(missingPaths, false);
      }
    }
  }

  private fileFingerprintCacheKey(summary: ChangeReviewSummary, filePath: string): string {
    return [
      summary.worktreePath,
      summary.scope,
      summary.headSha ?? '',
      summary.worktreeFingerprint,
      encodeURIComponent(filePath),
    ].join('\0');
  }

  private rememberFileFingerprint(filePath: string, fingerprint: string): void {
    this.fileFingerprints.update((current) => {
      const next = new Map(current);
      next.set(filePath, fingerprint);
      return next;
    });
    const viewedFingerprint = this.viewedFingerprints()[this.viewedKey(filePath)];
    if (viewedFingerprint && viewedFingerprint !== fingerprint) {
      this.unmarkViewed(filePath);
    }
  }

  private setFileFingerprintLoading(paths: readonly string[], loading: boolean): void {
    this.loadingFileFingerprints.update((current) => {
      const next = new Set(current);
      for (const filePath of paths) {
        if (loading) {
          next.add(filePath);
        } else {
          next.delete(filePath);
        }
      }
      return next;
    });
  }

  private rememberFileChangeHash(filePath: string, changeHash: string): void {
    this.fileChangeHashes.update((current) => {
      const next = new Map(current);
      next.set(filePath, changeHash);
      return next;
    });
  }

  private isFileDiffForceLoaded(file: ChangeReviewFileSummary): boolean {
    return this.isFileDiffForceLoadedPath(file.path);
  }

  private isFileDiffForceLoadedPath(filePath: string): boolean {
    return this.forceLoadedFileDiffs().has(filePath);
  }

  private markViewed(filePath: string, fingerprint: string): void {
    this.viewedFingerprints.update((current) => {
      const next = { ...current, [this.viewedKey(filePath)]: fingerprint };
      this.writeViewedFingerprints(next);
      return next;
    });
  }

  private unmarkViewed(filePath: string): void {
    this.viewedFingerprints.update((current) => {
      const key = this.viewedKey(filePath);
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      this.writeViewedFingerprints(next);
      return next;
    });
  }

  private viewedKey(filePath: string): string {
    return [
      encodeURIComponent(this.worktreePath()),
      this.scope(),
      encodeURIComponent(filePath),
    ].join('|');
  }

  private readViewedFingerprints(): Record<string, string> {
    try {
      const raw = localStorage.getItem(VIEWED_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeViewedFingerprints(value: Record<string, string>): void {
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

  private eventStartedInsidePanel(event: KeyboardEvent): boolean {
    const target = event.target;
    return target instanceof Node && this.elementRef.nativeElement.contains(target);
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      tagName === 'select' ||
      target.isContentEditable
    );
  }

  private selectedDiffRows(range: Range, scrollEl: HTMLElement): SelectedDiffRow[] {
    const rowsById = new Map(this.visibleRows().map((row) => [row.id, row]));
    return Array.from(scrollEl.querySelectorAll<HTMLElement>('.cr-diff-row[data-cr-row-id]'))
      .filter((element) => {
        try {
          return range.intersectsNode(element);
        } catch {
          return false;
        }
      })
      .map((element): SelectedDiffRow | null => {
        const id = element.dataset['crRowId'];
        const renderRow = id ? (rowsById.get(id) ?? null) : null;
        if (!renderRow || renderRow.kind !== 'diff' || !renderRow.row) return null;
        const text = this.selectedTextWithinRow(range, element, renderRow.row.content);
        if (!text.trim()) return null;
        return { renderRow, text };
      })
      .filter((item): item is SelectedDiffRow => item !== null);
  }

  private selectedTextWithinRow(range: Range, element: HTMLElement, fallback: string): string {
    const contentEl = element.querySelector<HTMLElement>('.cr-code, .cr-expand-row');
    if (!contentEl) return fallback;
    try {
      const contentRange = document.createRange();
      contentRange.selectNodeContents(contentEl);
      const intersection = document.createRange();
      const startsInsideContent = contentEl.contains(range.startContainer);
      const endsInsideContent = contentEl.contains(range.endContainer);

      if (
        startsInsideContent &&
        range.compareBoundaryPoints(Range.START_TO_START, contentRange) > 0
      ) {
        intersection.setStart(range.startContainer, range.startOffset);
      } else {
        intersection.setStart(contentRange.startContainer, contentRange.startOffset);
      }

      if (endsInsideContent && range.compareBoundaryPoints(Range.END_TO_END, contentRange) < 0) {
        intersection.setEnd(range.endContainer, range.endOffset);
      } else {
        intersection.setEnd(contentRange.endContainer, contentRange.endOffset);
      }

      const text = intersection.toString();
      contentRange.detach();
      intersection.detach();
      return text || fallback;
    } catch {
      return fallback;
    }
  }

  private buildDiffSelectionMentions(selectedRows: SelectedDiffRow[]): DiffSelectionMention[] {
    const grouped = new Map<string, SelectedDiffRow[]>();
    for (const item of selectedRows) {
      const filePath = item.renderRow.file.path;
      grouped.set(filePath, [...(grouped.get(filePath) ?? []), item]);
    }

    if (grouped.size > DIFF_SELECTION_MENTION_MAX_FILES) {
      toast.message(
        `Mentioned the first ${DIFF_SELECTION_MENTION_MAX_FILES} files. Narrow the selection to mention more precisely.`,
      );
    }

    const summary = this.summary();
    return Array.from(grouped.values())
      .slice(0, DIFF_SELECTION_MENTION_MAX_FILES)
      .map((items) => this.buildFileMention(items, summary))
      .filter((mention): mention is DiffSelectionMention => mention !== null);
  }

  private buildFileMention(
    items: SelectedDiffRow[],
    summary: ChangeReviewSummary | null,
  ): DiffSelectionMention | null {
    const first = items[0]?.renderRow;
    if (!first) return null;

    const selectedTextRaw = items
      .map((item) => item.text.trimEnd())
      .join('\n')
      .trim();
    if (!selectedTextRaw) return null;
    const selectedText = selectedTextRaw.slice(0, DIFF_SELECTION_MENTION_MAX_TEXT);
    const selectedRenderRows = items.map((item) => item.renderRow);

    return {
      id: `diff-mention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      version: 1,
      scope: this.scope(),
      compareLabel: summary?.compareLabel ?? null,
      baseSha: summary?.mergeBaseSha ?? summary?.baseSha ?? null,
      headSha: summary?.headSha ?? null,
      filePath: first.file.path,
      oldPath: first.file.oldPath ?? null,
      status: first.file.status,
      changeHash: first.state.changeHash,
      oldLineStart: minLine(selectedRenderRows, 'oldLine'),
      oldLineEnd: maxLine(selectedRenderRows, 'oldLine'),
      newLineStart: minLine(selectedRenderRows, 'newLine'),
      newLineEnd: maxLine(selectedRenderRows, 'newLine'),
      selectedText,
      context: this.contextForSelection(first.file.path, selectedRenderRows),
      truncated: selectedTextRaw.length > DIFF_SELECTION_MENTION_MAX_TEXT,
    };
  }

  private contextForSelection(
    filePath: string,
    selectedRows: RenderRow[],
  ): DiffSelectionMention['context'] {
    const selectedIndexes = selectedRows
      .map((row) => row.diffIndex)
      .filter((index): index is number => typeof index === 'number');
    if (!selectedIndexes.length) {
      return { before: [], selected: [], after: [] };
    }

    const start = Math.min(...selectedIndexes);
    const end = Math.max(...selectedIndexes);
    const rows = this.visibleRows()
      .filter(
        (row) =>
          row.kind === 'diff' && row.file.path === filePath && row.row && row.diffIndex !== null,
      )
      .sort((left, right) => (left.diffIndex ?? 0) - (right.diffIndex ?? 0));

    return {
      before: rows
        .filter((row) => (row.diffIndex ?? 0) < start)
        .slice(-3)
        .map((row) => this.toMentionContextRow(row)),
      selected: selectedRows.map((row) => this.toMentionContextRow(row)),
      after: rows
        .filter((row) => (row.diffIndex ?? 0) > end)
        .slice(0, 3)
        .map((row) => this.toMentionContextRow(row)),
    };
  }

  private toMentionContextRow(row: RenderRow): DiffSelectionMentionContextRow {
    return {
      type: row.row?.type ?? 'context',
      oldLine: row.row?.oldLine ?? null,
      newLine: row.row?.newLine ?? null,
      content: row.row?.content ?? '',
    };
  }
}

function minLine(rows: RenderRow[], key: 'oldLine' | 'newLine'): number | null {
  const values = rows
    .map((row) => row.row?.[key])
    .filter((value): value is number => typeof value === 'number');
  return values.length ? Math.min(...values) : null;
}

function maxLine(rows: RenderRow[], key: 'oldLine' | 'newLine'): number | null {
  const values = rows
    .map((row) => row.row?.[key])
    .filter((value): value is number => typeof value === 'number');
  return values.length ? Math.max(...values) : null;
}

function diffMentionRowKey(
  scope: DiffSelectionMention['scope'],
  filePath: string,
  changeHash: string | null,
  type: ChangeReviewRow['type'],
  oldLine: number | null,
  newLine: number | null,
  content: string,
): string {
  return JSON.stringify([scope, filePath, changeHash, type, oldLine, newLine, content]);
}
