import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import { GitStatusSummary } from '@/shared/models/git.model';
import { GitService } from '@/shared/services/git.service';
import { CommitButtonComponent } from './commit-button.component';

const changedSummary: GitStatusSummary = {
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  hasChanges: true,
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      staged: true,
    },
  ],
  staged: {
    files: 1,
    additions: 3,
    deletions: 1,
  },
  unstaged: {
    files: 0,
    additions: 0,
    deletions: 0,
  },
  total: {
    files: 1,
    additions: 3,
    deletions: 1,
  },
};

const cleanSummary: GitStatusSummary = {
  branch: 'feature',
  upstream: 'origin/feature',
  ahead: 0,
  behind: 0,
  hasChanges: false,
  files: [],
  staged: {
    files: 0,
    additions: 0,
    deletions: 0,
  },
  unstaged: {
    files: 0,
    additions: 0,
    deletions: 0,
  },
  total: {
    files: 0,
    additions: 0,
    deletions: 0,
  },
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CommitButtonComponent', () => {
  let fixture: ComponentFixture<CommitButtonComponent>;
  let getSummaryCalls: Subject<GitStatusSummary>[];
  const gitServiceMock = {
    getSummary: vi.fn(() => {
      const response = new Subject<GitStatusSummary>();
      getSummaryCalls.push(response);
      return response.asObservable();
    }),
    commit: vi.fn(() =>
      of({
        hash: 'abc123',
        message: 'fix(git): keep commit button visible',
        generatedMessage: false,
      }),
    ),
    push: vi.fn(() =>
      of({
        pushed: true,
        remote: 'origin',
        branch: 'main',
        upstream: 'origin/main',
        createdUpstream: false,
        nonFastForward: false,
        rejected: false,
        message: 'Pushed',
      }),
    ),
  };

  beforeEach(async () => {
    getSummaryCalls = [];
    gitServiceMock.getSummary.mockClear();
    gitServiceMock.commit.mockClear();
    gitServiceMock.push.mockClear();

    await TestBed.configureTestingModule({
      imports: [CommitButtonComponent],
      providers: [{ provide: GitService, useValue: gitServiceMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(CommitButtonComponent);
  });

  it('keeps the trigger visible while committing even after changes are cleared', () => {
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.componentRef.setInput('contextKey', 'session-1:main');
    fixture.detectChanges();

    fixture.componentInstance.summary.set(changedSummary);
    fixture.componentInstance.submitting.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Committing');

    fixture.componentInstance.summary.set(cleanSummary);
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Committing');
    expect(fixture.nativeElement.querySelector('.cx-trigger')).toBeTruthy();
  });

  it('clears stale summary immediately and ignores old context refresh results', async () => {
    fixture.componentRef.setInput('worktreePath', '/tmp/repo');
    fixture.componentRef.setInput('contextKey', 'session-1:main');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Checking');
    expect(getSummaryCalls).toHaveLength(1);

    fixture.componentRef.setInput('contextKey', 'session-1:feature');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Checking');
    expect(getSummaryCalls).toHaveLength(2);

    getSummaryCalls[0].next(changedSummary);
    getSummaryCalls[0].complete();
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Checking');
    expect(fixture.nativeElement.textContent).not.toContain('Commit');

    getSummaryCalls[1].next(cleanSummary);
    getSummaryCalls[1].complete();
    await flushPromises();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.cx-trigger')).toBeNull();
  });
});
