import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GitStatusSummary } from '../models/git.model';
import { AgentRuntimeProviderService } from './agent-runtime-provider.service';
import { GitService } from './git.service';

const summary = (overrides: Partial<GitStatusSummary> = {}): GitStatusSummary => ({
  branch: 'feature',
  upstream: 'origin/feature',
  headSha: 'abc123',
  worktreeFingerprint: 'fingerprint-a',
  ahead: 0,
  behind: 0,
  hasChanges: true,
  files: [],
  staged: { files: 0, additions: 0, deletions: 0 },
  unstaged: { files: 0, additions: 0, deletions: 0 },
  total: { files: 0, additions: 0, deletions: 0 },
  ...overrides,
});

describe('GitService', () => {
  let service: GitService;
  let httpGetMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    httpGetMock = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        GitService,
        { provide: HttpClient, useValue: { get: httpGetMock, post: vi.fn() } },
        { provide: AgentRuntimeProviderService, useValue: { currentProvider: 'claude' } },
      ],
    });

    service = TestBed.inject(GitService);
  });

  it('stores the latest git summary by worktree path', () => {
    const response = new Subject<GitStatusSummary>();
    const loaded = summary();
    httpGetMock.mockReturnValue(response.asObservable());

    service.getSummary('/tmp/repo').subscribe();
    expect(service.latestSummary('/tmp/repo')).toBeNull();

    response.next(loaded);
    response.complete();

    expect(service.latestSummary('/tmp/repo')).toEqual(loaded);
    expect(service.latestSummary('/tmp/other')).toBeNull();
  });
});
