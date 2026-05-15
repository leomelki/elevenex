import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { NavigationService } from './navigation.service';

describe('NavigationService', () => {
  let service: NavigationService;
  let httpGetMock: ReturnType<typeof vi.fn>;
  let localStorageMock: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    httpGetMock = vi.fn();
    localStorageMock = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };

    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });

    TestBed.configureTestingModule({
      providers: [
        NavigationService,
        { provide: HttpClient, useValue: { get: httpGetMock } },
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
            branches: [],
            workspaces: [
              {
                id: 3,
                repoId: 2,
                name: 'Default',
                path: '/tmp/repo',
                isDefault: true,
                createdFromRef: 'main',
                currentBranch: 'main',
                head: 'abc123',
                isDetached: false,
                isBare: false,
                isLocked: false,
                lockReason: null,
                isMissing: false,
                isDirty: false,
                branchCheckedOutElsewhere: false,
                checkedOutElsewherePath: null,
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

    const session = service.tree()[0].repos[0].workspaces![0].sessions[0];
    expect(session.hasUnreviewedCompletion).toBe(false);
    expect(session.lastCompletionAt).toBe('2026-01-01T00:00:00.000Z');
    expect(session.lastCompletionKind).toBe('completed');
    expect(session.lastStateChangeAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('does not auto-expand the tree on the initial load', () => {
    httpGetMock.mockReturnValue(
      of([
        {
          id: 1,
          name: 'Project',
          repos: [
            {
              id: 2,
              name: 'Repo',
              path: '/tmp/repo',
              branches: [],
              workspaces: [
                {
                  id: 3,
                  repoId: 2,
                  name: 'Default',
                  path: '/tmp/repo',
                  isDefault: true,
                  createdFromRef: 'main',
                  currentBranch: 'main',
                  head: 'abc123',
                  isDetached: false,
                  isBare: false,
                  isLocked: false,
                  lockReason: null,
                  isMissing: false,
                  isDirty: false,
                  branchCheckedOutElsewhere: false,
                  checkedOutElsewherePath: null,
                  sessions: [],
                  archivedSessions: [],
                },
              ],
            },
          ],
        },
      ]),
    );

    service.loadTree();

    expect(service.expandedKeys().size).toBe(0);
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it('auto-expands newly added projects, repositories, workspaces, and sessions on refresh', () => {
    service.tree.set([
      {
        id: 1,
        name: 'Project',
        repos: [
          {
            id: 2,
            name: 'Repo',
            path: '/tmp/repo',
            branches: [],
            workspaces: [
              {
                id: 3,
                repoId: 2,
                name: 'Default',
                path: '/tmp/repo',
                isDefault: true,
                createdFromRef: 'main',
                currentBranch: 'main',
                head: 'abc123',
                isDetached: false,
                isBare: false,
                isLocked: false,
                lockReason: null,
                isMissing: false,
                isDirty: false,
                branchCheckedOutElsewhere: false,
                checkedOutElsewherePath: null,
                sessions: [],
                archivedSessions: [],
              },
            ],
          },
        ],
      },
    ]);
    httpGetMock.mockReturnValue(
      of([
        {
          id: 1,
          name: 'Project',
          repos: [
            {
              id: 2,
              name: 'Repo',
              path: '/tmp/repo',
              branches: [],
              workspaces: [
                {
                  id: 3,
                  repoId: 2,
                  name: 'Default',
                  path: '/tmp/repo',
                  isDefault: true,
                  createdFromRef: 'main',
                  currentBranch: 'main',
                  head: 'abc123',
                  isDetached: false,
                  isBare: false,
                  isLocked: false,
                  lockReason: null,
                  isMissing: false,
                  isDirty: false,
                  branchCheckedOutElsewhere: false,
                  checkedOutElsewherePath: null,
                  sessions: [
                    {
                      id: 42,
                      repoId: 2,
                      branchName: 'main',
                      name: 'Session 42',
                      status: 'active',
                      hasUnreviewedCompletion: false,
                      lastCompletionAt: null,
                      lastCompletionKind: null,
                      lastStateChangeAt: null,
                    },
                  ],
                  archivedSessions: [],
                },
                {
                  id: 4,
                  repoId: 2,
                  name: 'Feature',
                  path: '/tmp/repo-feature',
                  isDefault: false,
                  createdFromRef: 'feature',
                  currentBranch: 'feature',
                  head: 'def456',
                  isDetached: false,
                  isBare: false,
                  isLocked: false,
                  lockReason: null,
                  isMissing: false,
                  isDirty: false,
                  branchCheckedOutElsewhere: false,
                  checkedOutElsewherePath: null,
                  sessions: [],
                  archivedSessions: [],
                },
              ],
            },
            {
              id: 3,
              name: 'New Repo',
              path: '/tmp/new-repo',
              branches: [],
            },
          ],
        },
        {
          id: 4,
          name: 'New Project',
          repos: [],
        },
      ]),
    );

    service.loadTree();

    expect(service.expandedKeys()).toEqual(
      new Set(['project-1', 'repo-2', 'workspace-2-3', 'workspace-2-4', 'repo-3', 'project-4']),
    );
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'elevenex-nav-expanded',
      JSON.stringify([
        'project-1',
        'repo-2',
        'workspace-2-3',
        'workspace-2-4',
        'repo-3',
        'project-4',
      ]),
    );
  });
});
