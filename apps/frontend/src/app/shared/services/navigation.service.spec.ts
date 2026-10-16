import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { of, Subject } from 'rxjs';
import { NavigationProject } from '../models/navigation-tree.model';
import { NavigationService } from './navigation.service';
import { getBackendOrigin } from '../runtime/runtime-config';
import { ClaudeStatusService } from './claude-status.service';

describe('NavigationService', () => {
  let service: NavigationService;
  let httpGetMock: ReturnType<typeof vi.fn>;
  let treeInvalidated: ReturnType<typeof signal<number>>;
  let localStorageMock: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    httpGetMock = vi.fn();
    treeInvalidated = signal(0);
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
        {
          provide: ClaudeStatusService,
          useValue: { treeInvalidated: treeInvalidated.asReadonly() },
        },
      ],
    });

    service = TestBed.inject(NavigationService);
  });

  function makeTree(sessionIds: number[], head = 'abc123'): NavigationProject[] {
    return [
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
                head,
                isDetached: false,
                isBare: false,
                isLocked: false,
                lockReason: null,
                isMissing: false,
                isDirty: false,
                branchCheckedOutElsewhere: false,
                checkedOutElsewherePath: null,
                sessions: sessionIds.map((id) => ({
                  id,
                  repoId: 2,
                  branchName: 'main',
                  name: `Session ${id}`,
                  status: 'active',
                  hasUnreviewedCompletion: false,
                  lastCompletionAt: null,
                  lastCompletionKind: null,
                  lastStateChangeAt: null,
                })),
                archivedSessions: [],
              },
            ],
          },
        ],
      },
    ];
  }

  it('shows generated names for temporary sessions across tree refreshes', () => {
    const tree = makeTree([]);
    tree[0].repos[0].workspaces![0].temporarySessions = [
      {
        id: 42,
        repoId: 2,
        branchName: 'main',
        name: 'Temporary session',
        status: 'active',
        isTemporary: true,
        hasUnreviewedCompletion: false,
        lastCompletionAt: null,
        lastCompletionKind: null,
        lastStateChangeAt: null,
      },
    ];
    service.tree.set(tree);

    service.patchSessionName(42, 'Investigate sidebar names');
    expect(service.tree()[0].repos[0].workspaces![0].temporarySessions![0].name).toBe(
      'Investigate sidebar names',
    );

    const refreshed = makeTree([]);
    refreshed[0].repos[0].workspaces![0].temporarySessions = [
      { ...tree[0].repos[0].workspaces![0].temporarySessions![0] },
    ];
    httpGetMock.mockReturnValue(of(refreshed));
    service.loadTree();

    expect(service.tree()[0].repos[0].workspaces![0].temporarySessions![0].name).toBe(
      'Investigate sidebar names',
    );
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

  function makeTaskTree(taskIds: number[]): NavigationProject[] {
    const tree = makeTree([]);
    const repo = tree[0].repos[0];
    const workspace = repo.workspaces![0];
    repo.workspaces!.push(...taskIds.map((id) => ({
      ...workspace,
      id,
      name: `Task ${id}`,
      isDefault: false,
      taskState: 'preparing' as const,
    })));
    return tree;
  }

  it('restores existing task expansion choices on startup', () => {
    httpGetMock.mockReturnValue(of(makeTaskTree([4])));
    service.loadTree();

    expect(service.expandedKeys().size).toBe(0);
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
  });

  it.each(['light', 'full'])('expands new tasks and their parents from a %s refresh', (phase) => {
    httpGetMock.mockReturnValue(of(makeTaskTree([4])));
    service.loadTree();
    const light$ = new Subject<NavigationProject[]>();
    const full$ = new Subject<NavigationProject[]>();
    httpGetMock.mockReturnValueOnce(light$).mockReturnValueOnce(full$);

    service.loadTree();
    light$.next(makeTaskTree(phase === 'light' ? [4, 5] : [4]));
    full$.next(makeTaskTree([4, 5]));

    expect(service.expandedKeys()).toEqual(new Set(['project-1', 'repo-2', 'workspace-2-5']));
    expect(service.isExpanded('workspace-2-4')).toBe(false);
    expect(service.isExpanded('workspace-2-3')).toBe(false);
  });

  it('keeps a manually collapsed task closed through preparation and temporary removal', () => {
    httpGetMock.mockReturnValue(of(makeTaskTree([])));
    service.loadTree();
    httpGetMock.mockReturnValue(of(makeTaskTree([4])));
    service.refreshTree();
    service.toggleExpand('workspace-2-4');

    httpGetMock.mockReturnValue(of(makeTaskTree([])));
    service.refreshTree();
    const ready = makeTaskTree([4]);
    ready[0].repos[0].workspaces![1].taskState = 'ready';
    httpGetMock.mockReturnValue(of(ready));
    service.refreshTree();

    expect(service.isExpanded('workspace-2-4')).toBe(false);
  });

  it('expands a created task explicitly before the next tree refresh', () => {
    service.tree.set(makeTree([]));
    service.expandTask(2, 4);

    expect(service.expandedKeys()).toEqual(new Set(['workspace-2-4', 'repo-2', 'project-1']));
  });

  it('expands new tasks after an empty initial tree without opening archived tasks', () => {
    httpGetMock.mockReturnValue(of([]));
    service.loadTree();
    const tree = makeTaskTree([4, 5]);
    tree[0].repos[0].workspaces![2].archivedAt = '2026-10-16T10:00:00Z';
    httpGetMock.mockReturnValue(of(tree));
    service.refreshTree();

    expect(service.expandedKeys()).toEqual(new Set(['project-1', 'repo-2', 'workspace-2-4']));
  });

  it('preserves selected expansions through light and full refreshes without opening new nodes', () => {
    const light$ = new Subject<NavigationProject[]>();
    const full$ = new Subject<NavigationProject[]>();
    httpGetMock.mockReturnValueOnce(light$).mockReturnValueOnce(full$);
    service.toggleExpand('project-1');
    service.toggleExpand('archive-2-3');
    service.toggleExpand('session-folder-9');
    localStorageMock.setItem.mockClear();

    service.loadTree();
    light$.next(makeTree([]));
    full$.next(makeTree([42]));

    expect(service.expandedKeys()).toEqual(
      new Set(['project-1', 'archive-2-3', 'session-folder-9']),
    );
    expect(localStorageMock.setItem).not.toHaveBeenCalled();
    expect(service.tree()[0].repos[0].workspaces![0].sessions).toHaveLength(1);
  });

  it('ignores stale full-tree responses after a newer light-tree refresh removes a session', () => {
    const firstLight$ = new Subject<NavigationProject[]>();
    const firstFull$ = new Subject<NavigationProject[]>();
    const secondLight$ = new Subject<NavigationProject[]>();
    const secondFull$ = new Subject<NavigationProject[]>();

    httpGetMock
      .mockReturnValueOnce(firstLight$.asObservable())
      .mockReturnValueOnce(firstFull$.asObservable())
      .mockReturnValueOnce(secondLight$.asObservable())
      .mockReturnValueOnce(secondFull$.asObservable());

    service.loadTree();
    firstLight$.next(makeTree([42]));

    expect(service.tree()[0].repos[0].workspaces![0].sessions.map((session) => session.id)).toEqual(
      [42],
    );
    expect(httpGetMock).toHaveBeenNthCalledWith(2, '/api/navigation/tree');

    service.loadTree();
    secondLight$.next(makeTree([]));

    expect(service.tree()[0].repos[0].workspaces![0].sessions).toEqual([]);

    firstFull$.next(makeTree([42], 'stale-head'));

    expect(service.tree()[0].repos[0].workspaces![0].sessions).toEqual([]);
    expect(service.tree()[0].repos[0].workspaces![0].head).toBe('abc123');
    expect(httpGetMock).toHaveBeenCalledTimes(3);

    firstFull$.complete();

    expect(httpGetMock).toHaveBeenNthCalledWith(4, '/api/navigation/tree');

    secondFull$.next(makeTree([], 'fresh-head'));

    expect(service.tree()[0].repos[0].workspaces![0].sessions).toEqual([]);
    expect(service.tree()[0].repos[0].workspaces![0].head).toBe('fresh-head');
  });

  it('keeps optimistic task order through stale tree responses and then accepts the saved order', () => {
    const original = makeTree([]);
    const repo = original[0].repos[0];
    const main = repo.workspaces![0];
    repo.workspaces!.push(
      { ...main, id: 4, name: 'First', isDefault: false, sortOrder: 1 },
      { ...main, id: 5, name: 'Second', isDefault: false, sortOrder: 2 },
    );
    const pendingLight = new Subject<NavigationProject[]>();
    httpGetMock.mockImplementation((url) => url.endsWith('/light') ? pendingLight : of(original));
    service.tree.set(original);
    service.loadTree();
    service.previewTaskOrder(repo.id, [5, 4]);
    pendingLight.next(original);
    expect(service.tree()[0].repos[0].workspaces!.find((item) => item.id === 5)!.sortOrder).toBe(1);
    expect(service.tree()[0].repos[0].workspaces!.find((item) => item.id === 4)!.sortOrder).toBe(2);
    const saved = structuredClone(original);
    saved[0].repos[0].workspaces![1].sortOrder = 3;
    saved[0].repos[0].workspaces![2].sortOrder = 4;
    httpGetMock.mockReturnValue(of(saved));
    service.finishTaskOrder(repo.id, getBackendOrigin());
    expect(service.tree()[0].repos[0].workspaces![1].sortOrder).toBe(3);
    expect(service.tree()[0].repos[0].workspaces![2].sortOrder).toBe(4);
  });

  it('refreshes once per tree invalidation without depending on tree responses', () => {
    httpGetMock.mockReturnValue(of(makeTree([42])));

    treeInvalidated.set(1);
    TestBed.tick();

    expect(httpGetMock).toHaveBeenCalledTimes(2);
    expect(httpGetMock).toHaveBeenNthCalledWith(1, '/api/navigation/tree/light');
    expect(httpGetMock).toHaveBeenNthCalledWith(2, '/api/navigation/tree');

    // Signal writes made while applying either response must not retrigger the
    // invalidation effect. A second backend invalidation still refreshes once.
    TestBed.tick();
    expect(httpGetMock).toHaveBeenCalledTimes(2);

    treeInvalidated.set(2);
    TestBed.tick();
    expect(httpGetMock).toHaveBeenCalledTimes(4);
  });
});
