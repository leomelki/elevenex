import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { NavigationService } from './navigation.service';

describe('NavigationService', () => {
  let service: NavigationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        NavigationService,
        { provide: HttpClient, useValue: { get: vi.fn() } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });

    service = TestBed.inject(NavigationService);
  });

  it('patches completion fields for a session in the navigation tree', () => {
    service.tree.set([
      {
        id: 1,
        name: 'Project',
        repos: [
          {
            id: 2,
            name: 'Repo',
            path: '/tmp/repo',
            branches: [
              {
                name: 'main',
                label: 'main',
                current: true,
                isRemote: false,
                hasWorktree: true,
                worktreePath: '/tmp/repo',
                commit: 'abc123',
                sessions: [
                  {
                    id: 42,
                    repoId: 2,
                    branchName: 'main',
                    name: 'Session 42',
                    status: 'active',
                    hasUnreviewedCompletion: true,
                    lastCompletionAt: '2026-01-01T00:00:00.000Z',
                    lastCompletionKind: 'completed',
                    lastStateChangeAt: '2026-01-01T00:00:00.000Z',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    service.patchSessionCompletion(42, {
      hasUnreviewedCompletion: false,
      lastCompletionAt: '2026-01-01T00:00:00.000Z',
      lastCompletionKind: 'completed',
      lastStateChangeAt: '2026-01-01T00:01:00.000Z',
    });

    const session = service.tree()[0].repos[0].branches[0].sessions[0];
    expect(session.hasUnreviewedCompletion).toBe(false);
    expect(session.lastCompletionAt).toBe('2026-01-01T00:00:00.000Z');
    expect(session.lastCompletionKind).toBe('completed');
    expect(session.lastStateChangeAt).toBe('2026-01-01T00:01:00.000Z');
  });
});
