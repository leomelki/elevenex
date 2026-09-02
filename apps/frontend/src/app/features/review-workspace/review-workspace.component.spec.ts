import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeReviewService } from '@/shared/services/change-review.service';
import { FilesService } from '@/shared/services/files.service';
import { GitService } from '@/shared/services/git.service';
import { MonacoEditorLoaderService } from '@/shared/services/monaco-editor-loader.service';
import { ReviewChatsService } from '@/shared/services/review-chats.service';
import { AgentRuntimeWebsocketService } from '@/shared/services/agent-runtime-websocket.service';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { ReviewWorkspaceComponent } from './review-workspace.component';

/**
 * Tab bookkeeping is pure component state, so these drive the component class
 * directly and stub the diff panel's scroll accessors. Rendering the real panel
 * would pull in virtual scrolling and the whole change-review data pipeline for
 * no added confidence about tabs.
 */
describe('ReviewWorkspaceComponent tabs', () => {
  let fixture: ComponentFixture<ReviewWorkspaceComponent>;
  let component: ReviewWorkspaceComponent;
  let scrollTop = 0;

  beforeEach(async () => {
    scrollTop = 0;

    await TestBed.configureTestingModule({
      imports: [ReviewWorkspaceComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ChangeReviewService,
          useValue: {
            getSummary: vi.fn(() => of(null)),
            getFileWindow: vi.fn(() => of(null)),
            getContextWindow: vi.fn(() => of(null)),
            getFileFingerprints: vi.fn(() => of({ fingerprints: [] })),
            clearCache: vi.fn(),
            hasFileWindowCache: vi.fn(() => false),
          },
        },
        { provide: GitService, useValue: { getSummary: vi.fn(() => of(null)), latestSummary: () => null } },
        { provide: FilesService, useValue: { listFiles: vi.fn(() => of([])), readFile: vi.fn(() => of({ content: '', language: 'markdown' })) } },
        { provide: MonacoEditorLoaderService, useValue: { load: vi.fn() } },
        { provide: ReviewChatsService, useValue: { list: vi.fn(() => of([])) } },
        {
          provide: AgentRuntimeWebsocketService,
          useValue: { borrow: vi.fn(() => of()), releaseBorrow: vi.fn(), send: vi.fn() },
        },
        { provide: AgentRuntimeApiService, useValue: { getHistory: vi.fn(() => of([])) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ReviewWorkspaceComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('sessionId', 1);
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.componentRef.setInput('provider', 'claude');

    // Stand in for the diff panel's scroll accessors.
    (component as unknown as { diffPanel: () => unknown }).diffPanel = () => ({
      readScrollTop: () => scrollTop,
      restoreScrollTop: (value: number) => {
        scrollTop = value;
      },
    });
  });

  it('starts on the stacked view with no tabs open', () => {
    expect(component.tabs()).toEqual([]);
    expect(component.activeTabPath()).toBeNull();
  });

  it('opens a file as a tab and focuses it', () => {
    component.openTab('src/a.ts');

    expect(component.tabs().map((tab) => tab.path)).toEqual(['src/a.ts']);
    expect(component.activeTabPath()).toBe('src/a.ts');
  });

  it('focuses an already-open file instead of duplicating the tab', () => {
    component.openTab('src/a.ts');
    component.openTab('src/b.ts');
    component.openTab('src/a.ts');

    expect(component.tabs().map((tab) => tab.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(component.activeTabPath()).toBe('src/a.ts');
  });

  it('remembers each tab’s scroll position across switches', () => {
    component.openTab('src/a.ts');
    scrollTop = 900;

    component.openTab('src/b.ts');
    // Switching away captured a.ts at 900 and reset the viewport for b.ts.
    expect(component.tabs()[0].scrollTop).toBe(900);
    expect(scrollTop).toBe(0);

    scrollTop = 120;
    component.selectTab('src/a.ts');

    expect(component.tabs()[1].scrollTop).toBe(120);
    expect(scrollTop).toBe(900);
  });

  it('keeps the stacked view scroll separate from tab scrolls', () => {
    scrollTop = 400;
    component.openTab('src/a.ts');
    expect(scrollTop).toBe(0);

    scrollTop = 50;
    component.selectTab(null);

    expect(component.activeTabPath()).toBeNull();
    expect(component.tabs()[0].scrollTop).toBe(50);
  });

  it('opens markdown on rendered preview and other files on the diff', () => {
    component.openTab('README.md');
    expect(component.tabs()[0].preview).toBe(true);
    expect(component.showMarkdownPreview()).toBe(true);

    component.openTab('src/a.ts');
    expect(component.tabs()[1].preview).toBe(false);
    expect(component.showMarkdownPreview()).toBe(false);
  });

  it('toggles a markdown tab between preview and diff, resetting its scroll', () => {
    component.openTab('README.md');
    component.onPreviewScrolled(300);
    expect(component.tabs()[0].scrollTop).toBe(300);

    component.toggleTabPreview('README.md');

    expect(component.tabs()[0].preview).toBe(false);
    expect(component.showMarkdownPreview()).toBe(false);
    // Diff and preview scroll independently, so the offset must not carry over.
    expect(component.tabs()[0].scrollTop).toBe(0);
  });

  it('focuses the neighbouring tab when the active one closes', () => {
    component.openTab('src/a.ts');
    component.openTab('src/b.ts');
    component.openTab('src/c.ts');
    component.selectTab('src/b.ts');

    component.closeTab('src/b.ts');

    expect(component.tabs().map((tab) => tab.path)).toEqual(['src/a.ts', 'src/c.ts']);
    expect(component.activeTabPath()).toBe('src/c.ts');
  });

  it('falls back to the previous tab when closing the last one', () => {
    component.openTab('src/a.ts');
    component.openTab('src/b.ts');

    component.closeTab('src/b.ts');

    expect(component.activeTabPath()).toBe('src/a.ts');
  });

  it('returns to the stacked view when the final tab closes', () => {
    component.openTab('src/a.ts');

    component.closeTab('src/a.ts');

    expect(component.tabs()).toEqual([]);
    expect(component.activeTabPath()).toBeNull();
  });

  it('leaves the active tab alone when closing a different one', () => {
    component.openTab('src/a.ts');
    component.openTab('src/b.ts');

    component.closeTab('src/a.ts');

    expect(component.activeTabPath()).toBe('src/b.ts');
  });

  it('stops tracking a closed file as an explicitly opened extra file', () => {
    component.openWorktreeFile('docs/notes.md');
    expect(component.extraFiles()).toEqual(['docs/notes.md']);
    expect(component.tabs()[0].extra).toBe(true);

    component.closeTab('docs/notes.md');

    expect(component.extraFiles()).toEqual([]);
  });
});
