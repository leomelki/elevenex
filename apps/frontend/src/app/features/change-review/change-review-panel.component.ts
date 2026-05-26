import { ScrollingModule } from '@angular/cdk/scrolling';
import { CommonModule } from '@angular/common';
import { Component, computed, effect, ElementRef, HostListener, inject, input, OnDestroy, output, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBinary,
  lucideChevronDown,
  lucideCheck,
  lucideExternalLink,
  lucideFileCode,
  lucideGitBranch,
  lucideGitPullRequest,
  lucideLoader,
  lucideMessageSquarePlus,
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
import {
  DIFF_SELECTION_MENTION_MAX_FILES,
  DIFF_SELECTION_MENTION_MAX_TEXT,
  DiffSelectionMention,
  DiffSelectionMentionContextRow,
} from '@/shared/models/diff-selection-mention.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { detectHljsLang, escapeHtml } from '@/features/session/claude-workspace/util/code-highlight';
import {
  ChangeReviewVirtualAnchor,
  ChangeReviewVirtualLayout,
  estimateChangeReviewDiffRows,
} from './change-review-virtual-layout';

type StatusFilter = 'all' | ChangeReviewFileStatus;
type RenderRowKind = 'fileHeader' | 'fileMeta' | 'diff';

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

const SCOPES: ScopeOption[] = [
  { value: 'uncommitted', label: 'Uncommitted' },
  { value: 'last-commit', label: 'Last commit' },
  { value: 'branch', label: 'Branch' },
];

const ROW_HEIGHT_PX = 24;
const WINDOW_LIMIT = 700;
const CONTEXT_RANGE_LIMIT = 120;
const VIEW_OVERSCAN_ROWS = 160;
const WINDOW_LOAD_CONCURRENCY = 3;
const MAX_WINDOW_CACHE_ROWS = 120_000;
const MAX_WINDOW_CACHE_WINDOWS = 400;
const MAX_ROW_HTML_CACHE = 8_000;
const VIEWED_STORAGE_KEY = 'elevenex-change-review-viewed-files';

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
      lucideCheck,
      lucideExternalLink,
      lucideFileCode,
      lucideGitBranch,
      lucideGitPullRequest,
      lucideLoader,
      lucideMessageSquarePlus,
      lucideRefreshCw,
      lucideSearch,
      lucideTriangleAlert,
    }),
  ],
})
export class ChangeReviewPanelComponent implements OnDestroy {
  readonly worktreePath = input.required<string>();
  readonly mentionSelection = output<DiffSelectionMention[]>();

  private readonly changeReview = inject(ChangeReviewService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly diffScroll = viewChild<ElementRef<HTMLElement>>('diffScroll');
  private readonly rowHtmlCache = new Map<string, SafeHtml>();
  private readonly windowQueue: WindowRequest[] = [];
  private readonly pendingWindowKeys = new Set<string>();
  private readonly windowCache = new Map<string, WindowCacheEntry>();
  private readonly relativeTimeInterval = window.setInterval(() => {
    this.now.set(Date.now());
  }, 30_000);

  private windowCacheRows = 0;
  private inFlightWindowLoads = 0;
  private generation = 0;

  readonly rowHeightPx = ROW_HEIGHT_PX;
  readonly scopes = SCOPES;
  readonly scope = signal<ChangeReviewScope>('branch');
  readonly statusFilter = signal<StatusFilter>('all');
  readonly search = signal('');
  readonly context = signal(8);
  readonly summary = signal<ChangeReviewSummary | null>(null);
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
  readonly viewedHashes = signal<Record<string, string>>(this.readViewedHashes());
  readonly windowLoadState = signal<WindowLoadState>({ running: false, total: 0 });
  readonly selectionMentionAction = signal<DiffSelectionMentionAction | null>(null);

  readonly totalHeightPx = computed(() => this.layout().totalRows * ROW_HEIGHT_PX);

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

  constructor() {
    effect(() => {
      const worktreePath = this.worktreePath();
      const scope = this.scope();
      if (!worktreePath || !scope) return;
      void this.loadForCurrentScope(false);
    });
  }

  ngOnDestroy(): void {
    this.generation += 1;
    window.clearInterval(this.relativeTimeInterval);
  }

  async refresh(refreshBase = false): Promise<void> {
    if (refreshBase) {
      this.changeReview.clearCache(this.worktreePath(), this.scope());
    }
    await this.loadForCurrentScope(refreshBase);
  }

  setScope(scope: ChangeReviewScope): void {
    if (scope === this.scope()) return;
    this.scope.set(scope);
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

  toggleFileViewed(file: ChangeReviewFileSummary): void {
    const hash = this.fileChangeHashes().get(file.path);
    if (!hash) return;
    if (this.isViewedHash(file.path, hash)) {
      this.unmarkViewed(file.path);
      return;
    }
    this.markViewed(file.path, hash);
    this.scrollToNextUnviewedFile(file.path);
  }

  openPullRequest(): void {
    const url = this.summary()?.pullRequest?.url;
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
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
    if (!anchorNode || !focusNode || !scrollEl.contains(anchorNode) || !scrollEl.contains(focusNode)) {
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

    const firstRect = typeof range.getBoundingClientRect === 'function'
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
    toast.success(action.mentions.length === 1
      ? 'Added diff selection to chat'
      : `Added ${action.mentions.length} diff selections to chat`);
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

  async expandContext(renderRow: RenderRow): Promise<void> {
    const row = renderRow.row;
    const file = renderRow.file;
    if (!row || row.type !== 'expand' || !row.oldStart || !row.newStart || !row.count) return;
    if (this.loadingContextRanges().has(row.id)) return;

    this.setContextRangeLoading(row.id, true);
    const requestGeneration = this.generation;
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
      if (requestGeneration !== this.generation) return;

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

      const anchor = this.captureAnchor();
      this.setFileState(file.path, (state) => this.replaceDiffRow(state, row.id, replacement));
      this.rebuildLayout();
      this.restoreAnchor(anchor);
      this.refreshRenderedRows();
    } catch (error: any) {
      const message = error?.error?.message || 'Could not load context lines.';
      toast.error(message);
    } finally {
      this.setContextRangeLoading(row.id, false);
    }
  }

  isContextRangeLoading(row: ChangeReviewRow | null): boolean {
    return row !== null && this.loadingContextRanges().has(row.id);
  }

  isFileViewed(file: ChangeReviewFileSummary): boolean {
    const hash = this.fileChangeHashes().get(file.path);
    return Boolean(hash) && this.isViewedHash(file.path, hash!);
  }

  isFileLoaded(file: ChangeReviewFileSummary): boolean {
    return Boolean(this.fileChangeHashes().get(file.path));
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

  fileBasename(filePath: string): string {
    return filePath.split('/').pop() || filePath;
  }

  fileDirname(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  fileMetaText(row: RenderRow): string {
    if (row.state.message) return row.state.message;
    if (row.file.oldPath) return `renamed from ${row.file.oldPath}`;
    if (row.state.loadingOffsets.size > 0) return 'Loading diff window';
    if (!row.state.changeHash) return 'Diff not loaded yet';
    return row.state.baseRowCount === null ? '' : `${row.state.baseRowCount} diff rows`;
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

  prefetchText(state: WindowLoadState): string {
    if (!state.running) return '';
    return `loading ${state.total} diff window${state.total === 1 ? '' : 's'}`;
  }

  private async loadForCurrentScope(refreshBase: boolean): Promise<void> {
    const worktreePath = this.worktreePath();
    const scope = this.scope();
    const requestGeneration = ++this.generation;
    this.resetQueues();
    this.loadingSummary.set(true);
    this.error.set(null);
    this.summary.set(null);
    this.fileStates.set(new Map());
    this.fileChangeHashes.set(new Map());
    this.activeFilePath.set(null);
    this.layout.set(new ChangeReviewVirtualLayout([]));
    this.visibleRows.set([]);
    this.renderedOffsetPx.set(0);
    this.loadingContextRanges.set(new Set());
    this.selectionMentionAction.set(null);
    this.rowHtmlCache.clear();
    this.now.set(Date.now());

    try {
      const summary = await firstValueFrom(this.changeReview.getSummary(worktreePath, scope, refreshBase));
      if (requestGeneration !== this.generation) return;

      this.summary.set(summary);
      this.fileStates.set(new Map(summary.files.map((file) => [
        file.path,
        this.createFileState(file),
      ])));
      this.applyFilters(true);
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

  private createFileState(file: ChangeReviewFileSummary): FileRenderState {
    return {
      file,
      diffRowCount: estimateChangeReviewDiffRows(file, this.context()),
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

  private applyFilters(scrollToTop: boolean): void {
    this.rebuildLayout();
    const files = this.filteredFiles();
    this.activeFilePath.set(files[0]?.path ?? null);
    if (scrollToTop) {
      window.setTimeout(() => {
        const scrollEl = this.diffScroll()?.nativeElement;
        if (scrollEl) scrollEl.scrollTop = 0;
        this.refreshRenderedRows();
        this.ensureVisibleRangeLoaded();
      }, 0);
      return;
    }
    this.refreshRenderedRows();
    this.ensureVisibleRangeLoaded();
  }

  private rebuildLayout(): void {
    const states = this.fileStates();
    this.layout.set(new ChangeReviewVirtualLayout(this.filteredFiles().map((file) => ({
      path: file.path,
      diffRows: states.get(file.path)?.diffRowCount ?? estimateChangeReviewDiffRows(file, this.context()),
    }))));
  }

  private refreshRenderedRows(): void {
    const layout = this.layout();
    const scrollEl = this.diffScroll()?.nativeElement;
    if (!scrollEl || layout.totalRows === 0) {
      this.visibleRows.set([]);
      this.renderedOffsetPx.set(0);
      return;
    }

    const visibleStart = Math.max(0, Math.floor(scrollEl.scrollTop / ROW_HEIGHT_PX));
    const visibleEnd = Math.min(
      layout.totalRows,
      Math.ceil((scrollEl.scrollTop + scrollEl.clientHeight) / ROW_HEIGHT_PX),
    );
    const renderStart = Math.max(0, visibleStart - VIEW_OVERSCAN_ROWS);
    const renderEnd = Math.min(layout.totalRows, Math.max(visibleEnd + VIEW_OVERSCAN_ROWS, renderStart + 1));
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

    const viewportRows = scrollEl
      ? Math.ceil(scrollEl.clientHeight / ROW_HEIGHT_PX)
      : 40;
    const visibleStart = scrollEl
      ? Math.floor(scrollEl.scrollTop / ROW_HEIGHT_PX)
      : 0;
    this.ensureRangeLoaded(
      Math.max(0, visibleStart - VIEW_OVERSCAN_ROWS),
      Math.min(layout.totalRows, visibleStart + viewportRows + VIEW_OVERSCAN_ROWS),
    );
  }

  private ensureRangeLoaded(startIndex: number, endIndex: number): void {
    const states = this.fileStates();
    for (const segment of this.layout().segmentsForRange(startIndex, endIndex)) {
      const state = states.get(segment.path);
      if (!state) continue;

      if (segment.includesHeader || segment.diffEnd > segment.diffStart) {
        this.enqueueWindow(segment.path, 0, segment.includesHeader);
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

  private enqueueWindow(filePath: string, offset: number, priority: boolean): void {
    const state = this.fileStates().get(filePath);
    if (!state) return;
    const safeOffset = Math.max(0, Math.floor(offset / WINDOW_LIMIT) * WINDOW_LIMIT);
    if (state.baseRowCount !== null && state.baseRowCount <= safeOffset && state.baseRowCount > 0) return;
    const key = this.windowKey(filePath, safeOffset);
    if (
      this.windowCache.has(key)
      || this.pendingWindowKeys.has(key)
      || state.loadingOffsets.has(safeOffset)
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

    void firstValueFrom(this.changeReview.getFileWindow(
      this.worktreePath(),
      this.scope(),
      request.filePath,
      {
        offset: request.offset,
        limit: WINDOW_LIMIT,
        context: this.context(),
      },
    ))
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
    this.rememberFileHash(fileWindow.path, fileWindow.changeHash);
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
    for (let replacementIndex = 0; replacementIndex < state.replacements.length; replacementIndex += 1) {
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

  private replaceDiffRow(
    state: FileRenderState,
    rowId: string,
    replacementRows: ChangeReviewRow[],
  ): FileRenderState {
    for (let replacementIndex = 0; replacementIndex < state.replacements.length; replacementIndex += 1) {
      const replacement = state.replacements[replacementIndex];
      const rowIndex = replacement.rows.findIndex((row) => row.id === rowId);
      if (rowIndex === -1) continue;

      const nextRows = [
        ...replacement.rows.slice(0, rowIndex),
        ...replacementRows,
        ...replacement.rows.slice(rowIndex + 1),
      ];
      const replacements = state.replacements.map((candidate, index) => index === replacementIndex
        ? { ...candidate, rows: nextRows }
        : candidate);
      return {
        ...state,
        replacements,
        diffRowCount: this.diffRowCountFor(state.baseRowCount, state.diffRowCount, replacements),
      };
    }

    for (const [baseIndex, row] of state.baseRows.entries()) {
      if (row.id !== rowId) continue;
      const replacements = [
        ...state.replacements,
        { baseIndex, rows: replacementRows },
      ].sort((left, right) => left.baseIndex - right.baseIndex);
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
    const nextIndex = currentIndex === -1
      ? (delta > 0 ? 0 : files.length - 1)
      : currentIndex + delta;
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
      this.windowCache.size <= MAX_WINDOW_CACHE_WINDOWS
      && this.windowCacheRows <= MAX_WINDOW_CACHE_ROWS
    ) {
      return;
    }

    const protectedKeys = new Set(
      this.visibleRows()
        .filter((row) => row.baseIndex !== null)
        .map((row) => this.windowKey(
          row.file.path,
          Math.floor((row.baseIndex ?? 0) / WINDOW_LIMIT) * WINDOW_LIMIT,
        )),
    );

    while (
      this.windowCache.size > MAX_WINDOW_CACHE_WINDOWS
      || this.windowCacheRows > MAX_WINDOW_CACHE_ROWS
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

  private resetQueues(): void {
    this.windowQueue.length = 0;
    this.pendingWindowKeys.clear();
    this.windowCache.clear();
    this.windowCacheRows = 0;
    this.inFlightWindowLoads = 0;
    this.windowLoadState.set({ running: false, total: 0 });
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

  private eventStartedInsidePanel(event: KeyboardEvent): boolean {
    const target = event.target;
    return target instanceof Node && this.elementRef.nativeElement.contains(target);
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return tagName === 'input'
      || tagName === 'textarea'
      || tagName === 'select'
      || target.isContentEditable;
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
        const renderRow = id ? rowsById.get(id) ?? null : null;
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

      if (startsInsideContent && range.compareBoundaryPoints(Range.START_TO_START, contentRange) > 0) {
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
      toast.message(`Mentioned the first ${DIFF_SELECTION_MENTION_MAX_FILES} files. Narrow the selection to mention more precisely.`);
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

    const selectedTextRaw = items.map((item) => item.text.trimEnd()).join('\n').trim();
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
      .filter((row) => row.kind === 'diff' && row.file.path === filePath && row.row && row.diffIndex !== null)
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
