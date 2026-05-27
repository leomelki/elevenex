import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { of, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChangeReviewFileSummary,
  ChangeReviewFileWindow,
  ChangeReviewRow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from '@/shared/models/change-review.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import { GitStatusSummary } from '@/shared/models/git.model';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { GitService } from '@/shared/services/git.service';
import { ChangeReviewPanelComponent } from './change-review-panel.component';

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const file = (
  path: string,
  additions = 2,
  deletions = 1,
  overrides: Partial<ChangeReviewFileSummary> = {},
): ChangeReviewFileSummary => ({
  path,
  oldPath: null,
  status: 'modified',
  additions,
  deletions,
  binary: false,
  large: false,
  size: null,
  ...overrides,
});

const summary = (
  files: ChangeReviewFileSummary[],
  scope: ChangeReviewScope = 'branch',
  overrides: Partial<ChangeReviewSummary> = {},
): ChangeReviewSummary => ({
  scope,
  worktreePath: '/tmp/repo',
  repoRoot: '/tmp/repo',
  branch: 'feature',
  baseRef: 'origin/main',
  baseSha: 'base123',
  headSha: 'head123',
  worktreeFingerprint: 'worktree-a',
  mergeBaseSha: 'merge123',
  compareLabel: 'feature vs origin/main',
  generatedAt: new Date().toISOString(),
  staleBase: false,
  originRefAgeSeconds: 1,
  pullRequest: null,
  totals: {
    files: files.length,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
  },
  files,
  loadGuard: null,
  ...overrides,
});

const row = (path: string, index: number) => ({
  id: `${path}:${index}`,
  type: 'context' as const,
  oldLine: index + 1,
  newLine: index + 1,
  content: `line ${index + 1}`,
  path,
});

const addRow = (path: string, index: number, content = `added ${index + 1}`) => ({
  id: `${path}:add:${index}`,
  type: 'add' as const,
  oldLine: null,
  newLine: index + 1,
  content,
  path,
});

const fileWindow = (
  path: string,
  scope: ChangeReviewScope = 'branch',
  offset = 0,
  rows: ChangeReviewRow[] = [row(path, offset)],
): ChangeReviewFileWindow => ({
  scope,
  path,
  oldPath: null,
  status: 'modified',
  binary: false,
  large: false,
  truncated: false,
  message: null,
  offset,
  limit: 700,
  totalRows: rows.length,
  hasMore: false,
  context: 8,
  changeHash: `${path}:hash`,
  rows,
  contextRanges: [],
});

const diffMention = (
  path: string,
  selected: ChangeReviewRow[],
  overrides: Partial<DiffSelectionMention> = {},
): DiffSelectionMention => ({
  id: 'mention-1',
  version: 1,
  scope: 'branch',
  compareLabel: 'feature vs origin/main',
  baseSha: 'base123',
  headSha: 'head123',
  filePath: path,
  oldPath: null,
  status: 'modified',
  changeHash: `${path}:hash`,
  oldLineStart: null,
  oldLineEnd: null,
  newLineStart: 2,
  newLineEnd: 2,
  selectedText: selected.map((item) => item.content).join('\n'),
  context: {
    before: [],
    selected: selected.map((item) => ({
      type: item.type,
      oldLine: item.oldLine,
      newLine: item.newLine,
      content: item.content,
    })),
    after: [],
  },
  truncated: false,
  ...overrides,
});

const gitSummary = (overrides: Partial<GitStatusSummary> = {}): GitStatusSummary => ({
  branch: 'feature',
  upstream: 'origin/feature',
  headSha: 'head123',
  worktreeFingerprint: 'worktree-a',
  ahead: 0,
  behind: 0,
  hasChanges: true,
  files: [],
  staged: { files: 0, additions: 0, deletions: 0 },
  unstaged: { files: 0, additions: 0, deletions: 0 },
  total: { files: 0, additions: 0, deletions: 0 },
  ...overrides,
});

const setViewport = (el: HTMLElement, clientHeight = 240, scrollTop = 0) => {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
};

const installStorageStub = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    },
  });
};

describe('ChangeReviewPanelComponent', () => {
  let fixture: ComponentFixture<ChangeReviewPanelComponent>;
  let serviceMock: {
    getSummary: ReturnType<typeof vi.fn>;
    getFileWindow: ReturnType<typeof vi.fn>;
    getContextWindow: ReturnType<typeof vi.fn>;
    clearCache: ReturnType<typeof vi.fn>;
    hasFileWindowCache: ReturnType<typeof vi.fn>;
  };
  let summaryCalls: Array<{
    scope: ChangeReviewScope;
    forceLoad: boolean;
    response: Subject<ChangeReviewSummary>;
  }>;
  let windowCalls: Array<{
    path: string;
    offset: number;
    forceFileLoad: boolean;
    response: Subject<ChangeReviewFileWindow>;
  }>;
  let latestGitSummary: WritableSignal<GitStatusSummary | null>;
  let gitServiceMock: {
    latestSummary: ReturnType<typeof vi.fn>;
    getSummary: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    installStorageStub();
    summaryCalls = [];
    windowCalls = [];
    latestGitSummary = signal<GitStatusSummary | null>(null);
    localStorage.clear();
    serviceMock = {
      getSummary: vi.fn(
        (
          _worktreePath: string,
          scope: ChangeReviewScope,
          _refreshBase = false,
          forceLoad = false,
        ) => {
          const response = new Subject<ChangeReviewSummary>();
          summaryCalls.push({ scope, forceLoad, response });
          return response.asObservable();
        },
      ),
      getFileWindow: vi.fn(
        (
          _worktreePath: string,
          _scope: ChangeReviewScope,
          path: string,
          options: { offset?: number; forceFileLoad?: boolean },
        ) => {
          const response = new Subject<ChangeReviewFileWindow>();
          windowCalls.push({
            path,
            offset: options.offset ?? 0,
            forceFileLoad: Boolean(options.forceFileLoad),
            response,
          });
          return response.asObservable();
        },
      ),
      getContextWindow: vi.fn(),
      clearCache: vi.fn(),
      hasFileWindowCache: vi.fn(() => false),
    };
    gitServiceMock = {
      latestSummary: vi.fn(() => latestGitSummary()),
      getSummary: vi.fn(() => of(latestGitSummary() ?? gitSummary())),
    };

    await TestBed.configureTestingModule({
      imports: [ChangeReviewPanelComponent],
      providers: [
        { provide: ChangeReviewService, useValue: serviceMock },
        { provide: GitService, useValue: gitServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChangeReviewPanelComponent);
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.detectChanges();
  });

  async function flushSummary(value: ChangeReviewSummary): Promise<HTMLElement> {
    summaryCalls[summaryCalls.length - 1].response.next(value);
    summaryCalls[summaryCalls.length - 1].response.complete();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const viewport = fixture.nativeElement.querySelector('.cr-diff-viewport') as HTMLElement | null;
    if (viewport) {
      setViewport(viewport);
      fixture.componentInstance.onDiffScroll();
    }
    fixture.detectChanges();
    return viewport as HTMLElement;
  }

  it('renders multiple file headers in one continuous diff surface', async () => {
    await flushSummary(summary([file('src/a.ts'), file('src/b.ts')]));

    const headers = [...fixture.nativeElement.querySelectorAll('.cr-file-header-row--main')].map(
      (item) => item.textContent,
    );

    expect(headers.join(' ')).toContain('src/a.ts');
    expect(headers.join(' ')).toContain('src/b.ts');
  });

  it('uses the sidebar as navigation into the continuous scroller', async () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    const viewport = await flushSummary(summary(files));
    const expectedTop = fixture.componentInstance.layout().fileStart('src/b.ts')! * 24;

    fixture.componentInstance.scrollToFile(files[1]);

    expect(viewport.scrollTop).toBe(expectedTop);
    expect(fixture.componentInstance.activeFilePath()).toBe('src/b.ts');
  });

  it('loads the next file when scrolling near its virtual range', async () => {
    const files = [file('src/large.ts', 600, 0), file('src/next.ts', 2, 0)];
    const viewport = await flushSummary(summary(files));
    expect(windowCalls.some((call) => call.path === 'src/next.ts')).toBe(false);

    setViewport(viewport, 240, fixture.componentInstance.layout().fileStart('src/next.ts')! * 24);
    fixture.componentInstance.onDiffScroll();

    const activeWindow = windowCalls.find((call) => call.path === 'src/large.ts')!;
    activeWindow.response.next(fileWindow('src/large.ts'));
    activeWindow.response.complete();
    await flush();

    expect(windowCalls.some((call) => call.path === 'src/next.ts')).toBe(true);
  });

  it('does not load header-only overscan files on panel open', async () => {
    await flushSummary(summary([file('src/first.ts', 113, 0), file('src/second.ts', 2_000, 0)]));

    expect(windowCalls.some((call) => call.path === 'src/first.ts')).toBe(true);
    expect(windowCalls.some((call) => call.path === 'src/second.ts')).toBe(false);
  });

  it('hides large file diffs by default and loads them only after confirmation', async () => {
    await flushSummary(summary([file('src/large.ts', 701, 0)]));
    fixture.detectChanges();

    expect(windowCalls).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Large diff hidden by default',
    );

    const loadButton = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Load diff')) as HTMLButtonElement;
    loadButton.click();
    fixture.detectChanges();

    expect(windowCalls).toHaveLength(1);
    expect(windowCalls[0]).toMatchObject({
      path: 'src/large.ts',
      offset: 0,
      forceFileLoad: true,
    });
  });

  it('loads only one file window at a time', async () => {
    await flushSummary(summary([file('src/a.ts'), file('src/b.ts')]));

    expect(windowCalls.map((call) => call.path)).toEqual(['src/a.ts']);

    windowCalls[0].response.next(fileWindow('src/a.ts'));
    windowCalls[0].response.complete();
    await flush();

    expect(windowCalls.map((call) => call.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('ignores stale file windows after the scope changes', async () => {
    await flushSummary(summary([file('src/old.ts')], 'branch'));
    const oldWindow = windowCalls.find((call) => call.path === 'src/old.ts')!;

    fixture.componentInstance.setScope('last-commit');
    fixture.detectChanges();
    expect(summaryCalls[summaryCalls.length - 1].scope).toBe('last-commit');
    await flushSummary(summary([file('src/new.ts')], 'last-commit'));

    oldWindow.response.next(fileWindow('src/old.ts'));
    oldWindow.response.complete();
    await flush();

    expect(fixture.componentInstance.fileChangeHashes().has('src/old.ts')).toBe(false);
  });

  it('enables viewed state after a file hash loads', async () => {
    const files = [file('src/a.ts')];
    await flushSummary(summary(files));

    fixture.componentInstance.toggleFileViewed(files[0]);
    expect(fixture.componentInstance.isFileViewed(files[0])).toBe(false);

    windowCalls[0].response.next(fileWindow('src/a.ts'));
    windowCalls[0].response.complete();
    await flush();
    fixture.detectChanges();

    fixture.componentInstance.toggleFileViewed(files[0]);
    expect(fixture.componentInstance.isFileViewed(files[0])).toBe(true);
    expect(fixture.componentInstance.isFileCollapsed(files[0])).toBe(true);
  });

  it('collapses a file to its main header row', async () => {
    const files = [file('src/a.ts'), file('src/b.ts')];
    await flushSummary(summary(files));

    fixture.componentInstance.toggleFileCollapsed(files[0]);
    fixture.detectChanges();

    expect(fixture.componentInstance.isFileCollapsed(files[0])).toBe(true);
    expect(fixture.componentInstance.layout().fileStart('src/b.ts')).toBe(1);

    fixture.componentInstance.toggleFileCollapsed(files[0]);
    fixture.detectChanges();

    expect(fixture.componentInstance.isFileCollapsed(files[0])).toBe(false);
    expect(fixture.componentInstance.layout().fileStart('src/b.ts')).toBeGreaterThan(1);
  });

  it('renders file headers with a suffix-preserving path structure', async () => {
    await flushSummary(summary([file('src/main/java/package/folder/Test.java')]));

    const path = fixture.nativeElement.querySelector('.cr-path') as HTMLElement;
    const dirname = path.querySelector('.cr-path__dir') as HTMLElement;
    const basename = path.querySelector('.cr-path__name') as HTMLElement;

    expect(path.getAttribute('title')).toBe('src/main/java/package/folder/Test.java');
    expect(dirname.textContent).toBe('src/main/java/package/folder');
    expect(basename.textContent).toBe('Test.java');
    expect(basename.tagName.toLowerCase()).toBe('strong');
  });

  it('detects outdated branch diffs from the latest git status summary', async () => {
    await flushSummary(summary([file('src/a.ts')]));

    latestGitSummary.set(gitSummary({ worktreeFingerprint: 'worktree-a', headSha: 'head123' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.diffsOutdated()).toBe(false);

    latestGitSummary.set(gitSummary({ worktreeFingerprint: 'worktree-b', headSha: 'head123' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.diffsOutdated()).toBe(true);
  });

  it('shows a merge conflict banner and emits the resolver action only when conflicts exist', async () => {
    await flushSummary(summary([file('src/a.ts')]));
    fixture.detectChanges();

    let element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).not.toContain('merge conflict');

    latestGitSummary.set(
      gitSummary({
        files: [{ path: 'src/conflicted.ts', status: 'conflicted', staged: false }],
        hasChanges: true,
        total: { files: 1, additions: 0, deletions: 0 },
      }),
    );
    fixture.detectChanges();

    const emitted: true[] = [];
    fixture.componentInstance.openConflicts.subscribe(() => emitted.push(true));

    element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('1 file with merge conflicts detected');

    const resolveButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Resolve'),
    ) as HTMLButtonElement;
    resolveButton.click();

    expect(emitted).toEqual([true]);
  });

  it('pauses diff loading for guarded large change sets until explicitly loaded', async () => {
    await flushSummary(
      summary([], 'branch', {
        totals: { files: 2_001, additions: 0, deletions: 0 },
        loadGuard: {
          blocked: true,
          threshold: 2_000,
          totalFiles: 2_001,
          stagedFiles: 4,
          unstagedFiles: 1_997,
          conflictedFiles: 1,
          reason: 'worktree',
        },
      }),
    );
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Diff loading paused');
    expect(element.textContent).toContain('2,001');
    expect(windowCalls).toHaveLength(0);
    expect(gitServiceMock.getSummary).not.toHaveBeenCalled();

    const loadButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Load all diffs'),
    ) as HTMLButtonElement;
    loadButton.click();
    fixture.detectChanges();

    expect(summaryCalls[summaryCalls.length - 1]).toMatchObject({
      scope: 'branch',
      forceLoad: true,
    });
  });

  it('uses only HEAD drift for last-commit outdated detection', async () => {
    fixture.componentInstance.summary.set(summary([file('src/a.ts')], 'last-commit'));

    latestGitSummary.set(gitSummary({ worktreeFingerprint: 'worktree-b', headSha: 'head123' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.diffsOutdated()).toBe(false);

    latestGitSummary.set(gitSummary({ worktreeFingerprint: 'worktree-a', headSha: 'head456' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.diffsOutdated()).toBe(true);
  });

  it('emits a structured mention for selected diff text', async () => {
    const files = [file('src/a.ts')];
    await flushSummary(summary(files));
    windowCalls[0].response.next(
      fileWindow('src/a.ts', 'branch', 0, [
        row('src/a.ts', 0),
        addRow('src/a.ts', 1, 'const selected = true;'),
        row('src/a.ts', 2),
      ]),
    );
    windowCalls[0].response.complete();
    await flush();
    fixture.detectChanges();

    const emitted: unknown[] = [];
    fixture.componentInstance.mentionSelection.subscribe((mentions) => emitted.push(mentions));

    const code = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.cr-code'),
    ).find((element) => element.textContent?.includes('const selected = true;')) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    fixture.componentInstance.captureDiffSelection();
    fixture.detectChanges();

    const action = fixture.nativeElement.querySelector('.cr-mention-action') as HTMLButtonElement;
    expect(action).not.toBeNull();
    action.click();

    expect(emitted).toHaveLength(1);
    const mentions = emitted[0] as any[];
    expect(mentions).toHaveLength(1);
    expect(mentions[0].filePath).toBe('src/a.ts');
    expect(mentions[0].selectedText).toBe('const selected = true;');
    expect(mentions[0].newLineStart).toBe(2);
    expect(mentions[0].context.before[0].content).toBe('line 1');
    expect(mentions[0].context.after[0].content).toBe('line 3');
  });

  it('highlights rows that are pending diff mentions', async () => {
    const path = 'src/a.ts';
    const selected = addRow(path, 1, 'const selected = true;');
    await flushSummary(summary([file(path)]));
    windowCalls[0].response.next(
      fileWindow(path, 'branch', 0, [row(path, 0), selected, row(path, 2)]),
    );
    windowCalls[0].response.complete();
    await flush();

    fixture.componentRef.setInput('highlightedMentions', [diffMention(path, [selected])]);
    fixture.detectChanges();

    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.cr-diff-row'),
    );
    const selectedRow = rows.find((element) =>
      element.textContent?.includes('const selected = true;'),
    );
    const otherRow = rows.find((element) => element.textContent?.includes('line 1'));

    expect(selectedRow?.classList.contains('cr-diff-row--mentioned')).toBe(true);
    expect(otherRow?.classList.contains('cr-diff-row--mentioned')).toBe(false);
  });
});
