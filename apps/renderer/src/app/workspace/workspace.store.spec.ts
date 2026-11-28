import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendClientState, BackendResult, ElevenexBridge, WorkspaceCreateTask, WorkspacePage, WorkspaceProject, WorkspaceProjectDetail, WorkspaceSession, WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceTask, WorkspaceTaskRecovery, WorkspaceViewState } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { SessionChatDrafts } from '../session-chat/session-chat-drafts';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceDialogsComponent } from './workspace-dialogs.component';
import { WorkspaceNavigationComponent } from './workspace-navigation.component';

const project: WorkspaceProject = { id: 1, name: 'Project', agentInstructions: null };
const session: WorkspaceSession = { id: 5, taskId: 3, repoId: 2, name: 'Session', status: 'created', provider: 'claude', updatedAt: '' };
const task: WorkspaceTask = { id: 3, projectId: 1, repoId: 2, name: 'Task', branchName: 'task', stage: 'active', state: 'ready', archivedAt: null, updatedAt: '' };
const finishedTask: WorkspaceTask = { ...task, state: 'finished', archivedAt: 'now' };
const detail: WorkspaceProjectDetail = { project, repositories: { items: [{ id: 2, projectId: 1, name: 'repo', path: '/repo', defaultBase: 'main' }], nextCursor: null } };
const page = <T>(items: readonly T[]): WorkspacePage<T> => ({ items, nextCursor: null });
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });

async function settle(): Promise<void> { for (let index = 0; index < 15; index++) await Promise.resolve(); }

function setup(history = false) {
  let listener!: (state: BackendClientState) => void;
  const bridge = {
    workspaceMoveSession: vi.fn<(scope: string, input: import('@elevenex/shared').WorkspaceMoveSession) => Promise<BackendResult<WorkspaceSession>>>(async (_scope, input) => ok({...session, id: input.sessionId, parentSessionId: input.parentSessionId})),
    environmentStatus: vi.fn(async (): Promise<import('@elevenex/shared').EnvironmentSnapshot> => ({ selection: { kind: 'local' }, context: { projectId: null, taskId: null, sessionId: null, draft: '', cursor: null }, connection: null, challenge: null, forwards: [] })),
    saveEnvironmentContext: vi.fn(async (context: import('@elevenex/shared').EnvironmentContext, selection: import('@elevenex/shared').EnvironmentSelection) => ({ selection, context, connection: null, challenge: null, forwards: [] })),
    backendClientState: vi.fn(async () => ({ revision: 1, scope: { id: 'scope', environment: { kind: 'local' as const } } })),
    onBackendClientChanged: vi.fn((fn: (state: BackendClientState) => void) => { listener = fn; return vi.fn(); }),
    workspaceProjects: vi.fn(async (scope: string, query: import('@elevenex/shared').WorkspacePageQuery) => { void scope; void query; return ok(page([project])); }),
    workspaceProjectNameAvailability: vi.fn(async (scope: string, name: string) => { void scope; void name; return ok({ available: true }); }),
    workspaceTasks: vi.fn(async (scope: string, query: import('@elevenex/shared').WorkspaceTaskQuery) => { void scope; void query; return ok(page([task])); }),
    workspaceSessions: vi.fn<(scope: string, query: WorkspaceSessionQuery) => Promise<BackendResult<WorkspaceSessionPage>>>(async (_scope, query) => ok(page(query.state === 'archived' ? [] : [session]))),
    workspaceProject: vi.fn(async () => ok(detail)),
    workspaceCreateProject: vi.fn(async () => ok(detail)),
    workspaceFolders: vi.fn(async (): Promise<BackendResult<readonly import('@elevenex/shared').WorkspaceFolder[]>> => ok([])),
    workspaceBranches: vi.fn<ElevenexBridge['workspaceBranches']>(async () => ok([{ name: 'main', current: false, isDefault: true, defaultBase: 'main', heldTaskName: null }])),
    workspaceCreateTask: vi.fn<(scope: string, input: WorkspaceCreateTask) => Promise<BackendResult<WorkspaceTask>>>(async () => ok({ ...task, state: 'preparing' })),
    workspaceTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok(task)),
    workspaceRetryTask: vi.fn<(scope: string, taskId: number, recovery?: WorkspaceTaskRecovery) => Promise<BackendResult<WorkspaceTask>>>(async () => ok(task)),
    workspaceDeleteSession: vi.fn(async (): Promise<BackendResult<{readonly accepted: true}>> => ok({accepted: true})),
    workspaceArchiveSession: vi.fn(async (): Promise<BackendResult<{readonly accepted: true}>> => ok({accepted: true})),
    workspaceRestoreSession: vi.fn(async (): Promise<BackendResult<WorkspaceSession>> => ok({...session, status:'stopped'})),
    workspaceCreateSession: vi.fn(async (): Promise<BackendResult<WorkspaceSession>> => ok({ ...session, id: 6 })),
    workspaceSetStage: vi.fn(async () => ok(task)),
    workspaceKeepTaskOpen: vi.fn<ElevenexBridge['workspaceKeepTaskOpen']>(async () => ok(task)),
    workspaceFinishTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok({ ...task, state: 'finished', archivedAt: 'now' })),
    workspaceReopenTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok(task)),
    workspaceDeleteProject: vi.fn(async (): Promise<BackendResult<{readonly accepted: true}>> => ok({ accepted: true })),
    workspaceRevision: vi.fn(async () => ok({ revision: 1, version: 1 as const, sessionArchive: true as const, ...(history ? { sessionArchiveHistory: true as const } : {}) })),
  } satisfies Pick<ElevenexBridge, 'environmentStatus' | 'saveEnvironmentContext' | 'workspaceProjectNameAvailability' | 'backendClientState' | 'onBackendClientChanged' | 'workspaceProjects' | 'workspaceTasks' | 'workspaceSessions' | 'workspaceProject' | 'workspaceCreateProject' | 'workspaceBranches' | 'workspaceCreateTask' | 'workspaceTask' | 'workspaceCreateSession' | 'workspaceDeleteSession' | 'workspaceArchiveSession' | 'workspaceMoveSession' | 'workspaceRestoreSession' | 'workspaceSetStage' | 'workspaceRevision' | 'workspaceFolders' | 'workspaceRetryTask' | 'workspaceKeepTaskOpen' | 'workspaceFinishTask' | 'workspaceReopenTask' | 'workspaceDeleteProject'>;
  TestBed.configureTestingModule({ providers: [WorkspaceStore, SessionChatDrafts, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
  const store = TestBed.inject(WorkspaceStore);
  store.connect({ id: 'local', name: 'This Mac', kind: 'local', conn: 'live' }, true);
  return { store, bridge, emit: (state: BackendClientState) => listener(state), async start() {
    await settle(); TestBed.tick();
    // Some tests intentionally hold a restoration read pending; keep that state observable.
    for (let pass = 0; pass < 80 && store.loading(); pass++) await Promise.resolve();
  } };
}

afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Workspace resume', () => {
  const activeView: WorkspaceViewState = { panel: 'terminal', panelOpen: true, wideReview: false, closed: false, focused: true, filter: 'review', projectCursor: null, taskCursor: null };
  const savedClosedView: WorkspaceViewState = { ...activeView, closed: true, taskCursor: '2' };

  function saved(bridge: ReturnType<typeof setup>['bridge'], context: Partial<import('@elevenex/shared').EnvironmentContext> = {}) {
    const snapshot = { selection: { kind: 'local' as const }, connection: null, challenge: null, forwards: [], context: {
      projectId: 1, taskId: 3, sessionId: 5, draft: 'keep unsent input', cursor: 'keep event cursor',
      workspace: activeView, ...context,
    } };
    bridge.environmentStatus.mockResolvedValue(snapshot);
    return snapshot;
  }

  it('restores selection and layout before saving, preserving unrelated context fields', async () => {
    const { store, bridge, start } = setup(); saved(bridge); await start(); TestBed.tick(); await settle();
    expect(store.activeProject()).toBe('1'); expect(store.selectedSession()?.id).toBe(5);
    expect(store.panel()).toBe('terminal'); expect(store.panelOpen()).toBe(true);
    expect(store.filter()).toBe('review'); expect(store.focused()).toBe(true);
    expect(bridge.workspaceSessions).toHaveBeenCalledTimes(1);
    expect(bridge.saveEnvironmentContext).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 1, taskId: 3, sessionId: 5, draft: 'keep unsent input', cursor: 'keep event cursor' }), { kind: 'local' });
    expect(bridge.workspaceCreateSession).not.toHaveBeenCalled(); expect(bridge.workspaceRetryTask).not.toHaveBeenCalled();
  });

  it('jumps to bounded project, task and session windows outside the newest pages', async () => {
    const { store, bridge, start } = setup(); saved(bridge, { projectId: 77 });
    bridge.workspaceProjects.mockImplementation(async (_scope, query) => ok(page(query.cursor === '76' ? [{ ...project, id: 77 }] : [project])));
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.cursor === '4' ? [{ ...task, projectId: 77 }] : [])));
    bridge.workspaceTask.mockResolvedValue(ok({ ...task, projectId: 77 }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.cursor === '6' ? [session] : [{ ...session, id: 500 }])));
    await start(); TestBed.tick(); await settle();
    expect(store.activeProject()).toBe('77'); expect(store.selected()?.sessionId).toBe(5);
    expect(bridge.workspaceProjects).toHaveBeenCalledWith('scope', { cursor: '76', limit: 50 });
    expect(bridge.workspaceTasks).toHaveBeenCalledWith('scope', { projectId: 77, state: 'active', limit: 20, cursor: '4' });
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', { taskId: 3, order: 'latest', limit: 20, cursor: '6' });
    expect(store.tasks().length).toBeLessThanOrEqual(20);
  });

  it('restores archived conversations without restoring their lifecycle', async () => {
    const { store, bridge, start } = setup(true); saved(bridge);
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.state === 'archived' ? [{ ...session, status: 'archived' }] : [])));
    await start(); await settle(); TestBed.tick(); await settle();
    expect(store.selectedSession()?.status).toBe('archived');
    expect(bridge.workspaceSessions.mock.calls.filter(([, query]) => query.state === 'archived')).toHaveLength(1);
    expect(bridge.workspaceRestoreSession).not.toHaveBeenCalled();
  });

  it('falls back to the first project window after the saved project is deleted', async () => {
    const { store, bridge, start } = setup(); saved(bridge, { projectId: 77, taskId: null, sessionId: null });
    bridge.workspaceProjects.mockImplementation(async (_scope, query) => ok(page(query.cursor ? [] : [project])));
    await start(); await settle(); TestBed.tick(); await settle();
    expect(store.activeProject()).toBe('all'); expect(store.projects()).toHaveLength(1);
    expect(store.projectPage()).toBe(false); expect(store.restoring()).toBe(false);
  });

  it('clears a deleted session while keeping its project and side-panel layout', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, id: 7 }])));
    await start(); await settle(); TestBed.tick(); await settle();
    expect(store.selected()).toBeNull(); expect(store.activeProject()).toBe('1');
    expect(store.panel()).toBe('terminal'); expect(store.panelOpen()).toBe(true);
    expect(store.restoring()).toBe(false); expect(store.error()).toBeNull();
  });

  it('opens the active project even while a saved Closed view and its exact task are loading', async () => {
    const { store, bridge, start } = setup(); saved(bridge, { workspace: savedClosedView });
    const sibling = { ...task, id: 4 };
    let complete!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.state === 'finished' ? [finishedTask] : [sibling])));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.taskId === 3 ? [{ ...session, status: 'archived' }] : [])));
    bridge.workspaceTask.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await start();
    expect(store.loading()).toBe(true); expect(store.closed()).toBe(false); expect(store.filter()).toBeNull();
    expect(bridge.workspaceTasks).toHaveBeenCalledExactlyOnceWith('scope', { projectId: 1, state: 'active', limit: 20 });
    expect(bridge.workspaceTask).toHaveBeenCalledWith('scope', 3);
    complete(ok(finishedTask)); await settle(); TestBed.tick(); await settle();
    expect(store.closed()).toBe(false); expect(store.selected()).toBeNull();
    expect(store.activeProject()).toBe('1'); expect(store.tasks().map(row => row.id)).toEqual(['4']);
    expect(store.taskPage()).toBe(false); expect(store.focused()).toBe(true);
    expect(bridge.workspaceSessions).not.toHaveBeenCalledWith('scope', expect.objectContaining({ taskId: 3 }));
    expect(bridge.workspaceReopenTask).not.toHaveBeenCalled();

    await store.showClosed(true);
    expect(bridge.workspaceTasks).toHaveBeenLastCalledWith('scope', { projectId: 1, state: 'finished', limit: 20 });
    store.selectSession({ taskId: '3', sessionId: '5' });
    expect(store.closed()).toBe(true); expect(store.selectedSession()?.status).toBe('archived');
    expect(store.tasks()[0]?.archive).toBeUndefined();
    await store.showClosed(false);
    expect(store.closed()).toBe(false); expect(store.selected()).toBeNull();
    expect(bridge.workspaceTasks).toHaveBeenLastCalledWith('scope', { projectId: 1, state: 'active', limit: 20 });
  });

  it('restores a reopened task on the active list using its own keyset window', async () => {
    const { store, bridge, start } = setup(); saved(bridge, { workspace: savedClosedView });
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.cursor === '4' ? [task] : [{ ...task, id: 8 }])));
    await start();
    expect(store.closed()).toBe(false); expect(store.selected()?.sessionId).toBe(5);
    expect(bridge.workspaceTasks.mock.calls).toEqual([
      ['scope', { projectId: 1, state: 'active', limit: 20 }],
      ['scope', { projectId: 1, state: 'active', limit: 20, cursor: '4' }],
    ]);
  });

  it('starts with the default empty active list when Closed was saved without a selection', async () => {
    const { store, bridge, start } = setup(); saved(bridge, { taskId: null, sessionId: null, workspace: savedClosedView });
    bridge.workspaceTasks.mockResolvedValue(ok(page([])));
    await start();
    expect(store.closed()).toBe(false); expect(store.activeProject()).toBe('1');
    expect(store.tasks()).toEqual([]); expect(store.taskPage()).toBe(false);
    expect(bridge.workspaceTasks).toHaveBeenCalledExactlyOnceWith('scope', { projectId: 1, state: 'active', limit: 20 });
    expect(bridge.workspaceTask).not.toHaveBeenCalled();
  });

  it('keeps explicit Closed navigation when a pending startup task lookup completes', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    let complete!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.state === 'finished' ? [finishedTask] : [])));
    bridge.workspaceTask.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await start();
    expect(bridge.workspaceTask).toHaveBeenCalled();
    await store.showClosed(true);
    complete(ok(task)); await settle();
    expect(store.closed()).toBe(true); expect(store.tasks().map(row => row.id)).toEqual(['3']);
    expect(store.restoring()).toBe(false); expect(store.loading()).toBe(false);
    expect(bridge.workspaceTasks).toHaveBeenCalledTimes(2);
  });

  it('keeps explicit navigation on Refresh after the initial saved context read was superseded', async () => {
    const { store, bridge, start } = setup();
    const snapshot = saved(bridge, { workspace: savedClosedView });
    let complete!: (value: typeof snapshot) => void;
    bridge.environmentStatus.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await start();
    await store.selectProject('all');
    complete(snapshot); await settle();
    await store.refresh();
    expect(store.activeProject()).toBe('all'); expect(store.closed()).toBe(false);
    expect(store.selected()).toBeNull(); expect(store.restoring()).toBe(false);
    expect(bridge.workspaceTasks).toHaveBeenLastCalledWith('scope', { projectId: null, state: 'active', limit: 20 });
  });

  it.each([false, true])('reconnects in the live view when Closed was explicitly chosen: %s', async closed => {
    const { store, bridge, start, emit } = setup();
    await start();
    const sibling = { ...task, id: 4 };
    if (closed) {
      bridge.workspaceTasks.mockResolvedValueOnce(ok(page([finishedTask])));
      await store.showClosed(true);
    }
    store.selectSession({ taskId: '3', sessionId: '5' });
    emit({ revision: 2, scope: null }); TestBed.tick();
    bridge.workspaceTask.mockResolvedValue(ok(finishedTask));
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.state === 'finished' ? [finishedTask] : [sibling])));
    emit({ revision: 3, scope: { id: 'recovered', environment: { kind: 'local' } } }); TestBed.tick();
    await start();
    expect(store.restoring()).toBe(false); expect(store.closed()).toBe(closed);
    expect(store.tasks().map(row => row.id)).toEqual([closed ? '3' : '4']);
    expect(store.selected()).toEqual(closed ? { scopeId: 'recovered', taskId: 3, sessionId: 5 } : null);
    expect(bridge.workspaceTasks.mock.calls.filter(([scope]) => scope === 'recovered')).toEqual([
      ['recovered', { projectId: null, state: closed ? 'finished' : 'active', limit: 20 }],
    ]);
  });

  it('does not carry the live Closed view or saved Closed pagination to a different machine', async () => {
    const { store, bridge, start, emit } = setup(); await start(); await store.showClosed(true);
    const selection = { kind: 'remote', hostId: 'other' } as const;
    bridge.environmentStatus.mockResolvedValue({ selection, connection: null, challenge: null, forwards: [], context: {
      projectId: 1, taskId: null, sessionId: null, draft: '', cursor: null, workspace: savedClosedView,
    } });
    store.connect({ id: 'other', name: 'Other server', kind: 'ssh', conn: 'live' }, true);
    emit({ revision: 2, scope: { id: 'other-scope', environment: selection } }); TestBed.tick();
    await start();
    expect(store.closed()).toBe(false); expect(store.activeProject()).toBe('1');
    expect(bridge.workspaceTasks.mock.calls.filter(([scope]) => scope === 'other-scope')).toEqual([
      ['other-scope', { projectId: 1, state: 'active', limit: 20 }],
    ]);
  });

  it('drops deleted tasks and sessions without replaying mutations', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    bridge.workspaceTasks.mockResolvedValue(ok(page([])));
    bridge.workspaceTask.mockResolvedValue({ ok: false, error: { code: 'http', status: 404, message: 'Missing' } });
    await start(); await settle();
    expect(store.selected()).toBeNull(); expect(store.error()).toBeNull(); expect(store.restoring()).toBe(false);
    expect(store.panelOpen()).toBe(true);
    bridge.workspaceTasks.mockResolvedValue(ok(page([task]))); bridge.workspaceSessions.mockResolvedValue(ok(page([])));
    await store.refresh();
    expect(store.selected()).toBeNull(); expect(bridge.workspaceCreateSession).not.toHaveBeenCalled();
  });

  it('keeps saved state when loading fails and resumes on an explicit refresh', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    bridge.environmentStatus.mockRejectedValueOnce(new Error('Unavailable'));
    await start(); TestBed.tick(); await settle();
    expect(store.resumeError()).toContain('could not be loaded'); expect(bridge.saveEnvironmentContext).not.toHaveBeenCalled();
    await store.refresh(); TestBed.tick(); await settle();
    expect(store.selectedSession()?.id).toBe(5); expect(store.resumeError()).toBeNull();
  });

  it('rejects late restoration after a scope switch or explicit navigation', async () => {
    const { store, bridge, start, emit } = setup(); saved(bridge);
    let complete!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceTasks.mockResolvedValue(ok(page([{ ...task, id: 99 }])));
    bridge.workspaceTask.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    await start(); await settle();
    expect(bridge.workspaceTask).toHaveBeenCalled();
    await store.selectProject('all');
    complete(ok(task)); await settle(); TestBed.tick(); await settle();
    expect(store.activeProject()).toBe('all'); expect(store.selected()).toBeNull();
    emit({ revision: 2, scope: null }); TestBed.tick(); await settle();
    expect(store.projects()).toHaveLength(1); expect(store.offline()).toBe(true);
  });

  it('reports failed saves and retries on the next layout change', async () => {
    const { store, bridge, start } = setup(); await start(); TestBed.tick(); await settle();
    bridge.saveEnvironmentContext.mockRejectedValueOnce(new Error('Disk unavailable'));
    store.selectPanel('code'); TestBed.tick(); await settle();
    expect(store.resumeError()).toContain('could not be saved');
    store.panelOpen.set(true); TestBed.tick(); await settle();
    expect(store.resumeError()).toBeNull();
    expect(bridge.saveEnvironmentContext).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: expect.objectContaining({ panel: 'code', panelOpen: true }) }), { kind: 'local' });
  });

  it('does not surface a superseded project-restoration error after navigating away', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    let complete!: (value: BackendResult<WorkspacePage<WorkspaceProject>>) => void;
    bridge.workspaceProjects.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await start();
    await store.selectProject('all');
    complete({ ok: false, error: { code: 'transport', message: 'Old connection failed' } });
    await settle(); TestBed.tick(); await settle();
    expect(store.activeProject()).toBe('all'); expect(store.error()).toBeNull();
    expect(store.loading()).toBe(false); expect(store.restoring()).toBe(false);
  });
});

describe('WorkspaceStore', () => {
  it('publishes live status and processes later revisions while archive history is still pending', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup(true); await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    let finish!: (result: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const archived = new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(resolve => { finish = resolve; });
    let status = 'running';
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => query.state === 'archived' ? archived : ok(page([{ ...session, status }])));
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 2, version: 1, sessionArchive: true, sessionArchiveHistory: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()?.status).toBe('running');
    expect(store.loading()).toBe(false);
    status = 'attention';
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 3, version: 1, sessionArchive: true, sessionArchiveHistory: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()?.status).toBe('attention');
    finish(ok(page([]))); await settle();
    expect(store.selectedSession()?.status).toBe('attention');
  });

  it.each([1, 5])('revalidates pinned conversation %s outside the latest bounded session page', async id => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup();
    const selected = { ...session, id };
    bridge.workspaceSessions.mockResolvedValueOnce(ok(page([selected]))); await start();
    store.selectSession({ taskId: '3', sessionId: String(id) });
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 2, version: 1, sessionArchive: true }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.limit === 1
      ? [{ ...selected, status: 'attention' }] : [{ ...session, id: 500, status: 'running' }])));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()?.status).toBe('attention');
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', { taskId: 3, ...(id > 1 ? { cursor: String(id - 1) } : {}), limit: 1 });
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual([String(id), '500']);
  });

  it('revalidates a selected nested conversation and retains its parent outside the latest root page', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup();
    const parent: WorkspaceSession = { ...session, id: 6, parentSessionId: null, childCount: 1 };
    const child: WorkspaceSession = { ...session, parentSessionId: 6 };
    let revision = 1;
    bridge.workspaceRevision.mockImplementation(async () => ok({ revision, version: 1 as const, sessionArchive: true as const, sessionNesting: true as const, sessionNestingOrder: true as const }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.parentSessionId === 6 ? [child] : [parent])));
    await start();
    await store.loadSessionChildren({ taskId: '3', sessionId: '6' });
    store.selectSession({ taskId: '3', sessionId: '5' });
    revision++;
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.parentSessionId === 6 || query.cursor === '4'
      ? [{ ...child, status: 'attention' }] : query.cursor === '5' ? [parent]
        : Array.from({ length: 20 }, (_, index) => ({ ...session, id: 100 + index })))));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()).toMatchObject({ id: 5, status: 'attention', parentSessionId: 6 });
    expect(store.tasks()[0]?.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: '6' }), expect.objectContaining({ id: '5', parentId: '6' })]));
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', { taskId: 3, limit: 20, order: 'latest', parentSessionId: null });
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', { taskId: 3, cursor: '5', limit: 1, state: 'normal' });
    expect(store.tasks()[0]?.sessions.length).toBe(22);
    expect(store.tasks()[0]?.sessions).toContainEqual(expect.objectContaining({ id: '119' }));
  });

  it('refreshes the selected child without moving it ahead of its loaded siblings', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup();
    const parent = { ...session, id: 6, parentSessionId: null, childCount: 2 };
    const selected = { ...session, parentSessionId: 6 };
    const sibling = { ...selected, id: 7 };
    let revision = 1;
    bridge.workspaceRevision.mockImplementation(async () => ok({ revision, version: 1, sessionArchive: true, sessionNesting: true, sessionNestingOrder: true }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page<WorkspaceSession>(
      query.parentSessionId === 6 ? [sibling, selected] :
        query.limit === 1 ? [{ ...selected, name: 'Refreshed selection' }] : [parent],
    )));
    await start();
    await store.loadSessionChildren({ taskId: '3', sessionId: '6' });
    store.selectSession({ taskId: '3', sessionId: '5' });
    revision++;
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()?.name).toBe('Refreshed selection');
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['6', '7', '5']);
  });

  it('keeps priority sessions and their parent across history pages until activity clears', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup();
    const parent = { ...session, id: 3, status: 'done', childCount: 1 };
    const nested = { ...session, parentSessionId: 3, status: 'review' };
    const running = { ...session, id: 8, status: 'running' };
    let revision = 1, cleared = false, broken = false;
    bridge.workspaceRevision.mockImplementation(async () => ok({ revision, version: 1, sessionArchive: true, sessionPriority: true, sessionNesting: true }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => {
      if (query.state !== 'priority') return query.cursor
        ? ok(page([{ ...session, id: 23 }]))
        : ok({ items: [{ ...session, id: 30 }], nextCursor: '30' });
      if (query.cursor === '8' && broken) return { ok: false, error: { code: 'transport', message: 'Priority continuation failed' } };
      if (cleared) return ok({ ...page([running]), parentSessions: [] });
      return query.cursor === '8' ? ok({ ...page([nested]), parentSessions: [parent] })
        : ok({ items: [running], nextCursor: '8', parentSessions: [] });
    });
    await start();
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['3', '8', '30', '5']);
    expect(store.counts().review).toBe(1);
    store.selectSession({ taskId: '3', sessionId: '5' });
    await store.loadOlderSessions({ taskId: '3', limit: 5, cap: 5 });
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', {
      taskId: 3, limit: 5, cursor: '30', order: 'latest', parentSessionId: null,
    });
    expect(store.sessionDisclosures().get('3')?.batches).toEqual([['23']]);
    expect(store.selectedSession()?.id).toBe(5);
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['3', '8', '23', '30', '5']);
    store.selectSession({ taskId: '3', sessionId: '8' });
    revision++; broken = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['3', '8', '23', '30', '5']);
    revision++; broken = false; cleared = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['8', '23', '30']);
    expect(store.counts().review).toBe(0);
  });

  it('opens an agent link outside the loaded session window and ignores a stale link', async () => {
    const { store, bridge, start } = setup();
    await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    const source = store.selected()!;
    const reviewer = { ...session, id: 8, name: 'Reviewer', parentSessionId: 5, status: 'attention' };
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.cursor === '7' ? [reviewer] : [session])));
    expect(await store.openLinkedSession(source, { sessionId: 8 })).toMatchObject({ taskId: 3, sessionId: 8 });
    expect(store.selectedSession()).toMatchObject({ id: 8, status: 'attention' });
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', expect.objectContaining({ taskId: 3, limit: 1, cursor: '7' }));

    let release: (result: BackendResult<WorkspacePage<WorkspaceSession>>) => void = () => undefined;
    bridge.workspaceSessions.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.openLinkedSession(store.selected()!, { sessionId: 9 });
    store.selectSession({ taskId: '3', sessionId: '5' });
    release(ok(page([{ ...reviewer, id: 9 }])));
    expect(await pending).toBeNull();
    expect(store.selectedSession()?.id).toBe(5);
  });

  it('opens an explicit agent link to a finished task as a read-only conversation', async () => {
    const { store, bridge, start } = setup(true); await start();
    const finished = { ...finishedTask, id: 2 };
    const archived = { ...session, taskId: 2, id: 4, status: 'archived' };
    bridge.workspaceTask.mockResolvedValue(ok(finished));
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.state === 'finished' ? [finished] : [task])));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.taskId === finished.id ? [archived] : [session])));
    store.selectSession({ taskId: '3', sessionId: '5' });
    expect(await store.openLinkedSession(store.selected()!, { taskId: 2, sessionId: 4 })).toMatchObject({ taskId: 2, sessionId: 4 });
    expect(store.closed()).toBe(true); expect(store.selectedSession()?.status).toBe('archived');
    expect(store.tasks()[0]?.archive).toBeUndefined();
    expect(bridge.workspaceRestoreSession).not.toHaveBeenCalled();
  });

  it('revalidates in place and retries a failed revision without loading or error flashes', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup(); await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    store.error.set('Keep action feedback');
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 2, version: 1, sessionArchive: true }));
    let complete!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    bridge.workspaceSessions.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.loading()).toBe(false);
    expect(store.error()).toBe('Keep action feedback');
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['5']);
    expect(store.selectedSession()?.id).toBe(5);
    complete({ ok: false, error: { code: 'transport', message: 'Temporary failure' } });
    await settle();
    expect(store.error()).toBe('Keep action feedback');
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['5']);
    bridge.workspaceSessions.mockResolvedValueOnce(ok(page([{ ...session, name: 'Updated in background' }])));
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()?.name).toBe('Updated in background');
    expect(store.loading()).toBe(false);
    expect(store.error()).toBe('Keep action feedback');
  });

  it('discards a background project reply after explicit navigation', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup(); await start();
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 2, version: 1, sessionArchive: true }));
    let complete!: (value: BackendResult<WorkspacePage<WorkspaceProject>>) => void;
    bridge.workspaceProjects.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    await store.selectProject('1');
    const calls = bridge.workspaceTasks.mock.calls.length;
    complete(ok(page([]))); await settle();
    expect(store.activeProject()).toBe('1');
    expect(store.projects()).toHaveLength(1);
    expect(bridge.workspaceTasks).toHaveBeenCalledTimes(calls);
  });

  it('retains the selected archive if a replacement background task window fails', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { store, bridge, start } = setup(true);
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.state === 'archived' ? [{ ...session, id: 8, status: 'archived' }] : [session])));
    await start();
    await store.loadArchivedSessions({ taskId: '3', page: 'latest' });
    store.selectSession({ taskId: '3', sessionId: '8' });
    bridge.workspaceRevision.mockResolvedValue(ok({ revision: 2, version: 1, sessionArchive: true, sessionArchiveHistory: true }));
    bridge.workspaceTasks.mockResolvedValueOnce(ok(page([{ ...task, id: 9 }])));
    bridge.workspaceSessions.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Temporary failure' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.selectedSession()).toMatchObject({ id: 8, status: 'archived' });
    expect(store.tasks()[0]?.id).toBe('3');
    expect(store.error()).toBeNull();
  });

  it('checks names against the backend and rejects replies after scope changes or cancellation', async () => {
    const { store, bridge, start, emit } = setup(); await start();
    const provider = store.projectNameProvider();
    const controller = new AbortController();
    bridge.workspaceProjectNameAvailability.mockResolvedValueOnce(ok({ available: false }));
    expect(await provider('Archived name', controller.signal)).toBe(false);
    expect(bridge.workspaceProjectNameAvailability).toHaveBeenCalledWith('scope', 'Archived name');
    let complete!: (result: BackendResult<{ available: boolean }>) => void;
    bridge.workspaceProjectNameAvailability.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const pending = provider('New name', controller.signal);
    emit({ revision: 2, scope: null }); await settle(); TestBed.tick();
    complete(ok({ available: true }));
    await expect(pending).rejects.toThrow('interrupted');
    controller.abort();
    await expect(provider('New name', controller.signal)).rejects.toThrow('interrupted');
    expect(bridge.workspaceProjectNameAvailability).toHaveBeenCalledTimes(2);
  });
  it('keeps deletion progress and cleanup failures focused inside the modal so Escape can dismiss it', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
    const { store, bridge, start } = setup();
    await start();
    await store.selectProject('1');
    let complete!: (result: BackendResult<{readonly accepted: true}>) => void;
    bridge.workspaceDeleteProject.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const fixture = TestBed.createComponent(WorkspaceDialogsComponent);
    fixture.detectChanges();
    store.requestDeleteProject();
    fixture.detectChanges(); await fixture.whenStable();
    document.querySelector<HTMLButtonElement>('ex-delete-project button[variant="danger"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    expect(document.activeElement?.textContent).toContain('Closing tasks');
    expect(document.querySelector('ex-delete-project')?.closest('[aria-busy]')?.hasAttribute('inert')).toBe(true);
    complete({ ok: false, error: { code: 'http', status: 409, message: 'Could not stop all project processes. The project was kept.' } });
    await settle(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement?.getAttribute('role')).toBe('alert');
    expect(document.activeElement?.textContent).toContain('The project was kept');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(store.dialogOpen()).toBe(false);
    expect(bridge.workspaceDeleteProject).toHaveBeenCalledExactlyOnceWith('scope', project.id);
  });

  it('hides repository hints only when authoritative metadata says the project has one repository', async () => {
    const { store, bridge, start } = setup();
    bridge.workspaceTasks.mockResolvedValue(ok(page([{ ...task, repoName: 'repo', projectRepositoryCount: 1 }])));
    await start();
    expect(store.tasks()[0]?.repo).toBeUndefined();
    bridge.workspaceTasks.mockResolvedValue(ok(page([{ ...task, repoName: 'repo', projectRepositoryCount: 2 }])));
    await store.loadTasks();
    expect(store.tasks()[0]?.repo).toBe('repo');
    bridge.workspaceTasks.mockResolvedValue(ok(page([{ ...task, repoName: 'repo' }])));
    await store.loadTasks();
    expect(store.tasks()[0]?.repo).toBe('repo');
    expect(bridge.workspaceProject).not.toHaveBeenCalled();
  });

  it('retains matching rows after a failed project read and clears them when opening closed history', async () => {
    const { store, bridge, start } = setup(); await start();
    let resolve!: (result: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
    bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const selecting = store.selectProject('1');
    expect(store.loading()).toBe(true);
    expect(store.tasks().map(task => task.id)).toEqual(['3']);
    resolve({ ok: false, error: { code: 'transport', message: 'Unavailable' } });
    await selecting;
    expect(store.tasks().map(task => task.id)).toEqual(['3']);
    expect(store.error()).toBe('Unavailable');
    await store.loadTasks();
    bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const closing = store.showClosed(true);
    expect(store.tasks()).toEqual([]);
    resolve(ok(page([]))); await closing;
    expect(store.closed()).toBe(true);
    await store.showClosed(true);
    expect(store.closed()).toBe(true);
    expect(bridge.workspaceTasks).toHaveBeenLastCalledWith('scope', { projectId: 1, state: 'finished', limit: 20 });
  });

  it.each(['none', 'matching', 'other'])('retains all matching tasks and sessions throughout both project directions (selection: %s)', async selection => {
    const { store, bridge, start } = setup();
    const sibling = { ...task, id: 4 }, other = { ...task, id: 7, projectId: 2 };
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, { ...project, id: 2 }])));
    bridge.workspaceTasks.mockResolvedValue(ok(page([task, sibling, other])));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page([{ ...session, taskId: query.taskId, id: query.taskId + 10 }])));
    await start();
    if (selection !== 'none') {
      const taskId = selection === 'matching' ? 3 : 7;
      store.selectSession({ taskId: String(taskId), sessionId: String(taskId + 10) });
    }
    const matching = store.tasks().filter(task => task.id !== '7');
    for (const projectId of ['1', 'all']) {
      let resolveTasks!: (result: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
      let resolveSessions!: (result: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
      bridge.workspaceTasks.mockImplementationOnce(() => new Promise(resolve => { resolveTasks = resolve; }));
      bridge.workspaceSessions.mockImplementationOnce(() => new Promise(resolve => { resolveSessions = resolve; }));
      const selecting = store.selectProject(projectId);
      expect(store.loading()).toBe(true);
      expect(store.tasks()).toEqual(matching);
      expect(store.selected()?.taskId ?? null).toBe(selection === 'matching' ? 3 : null);
      resolveTasks(ok(page(projectId === 'all' ? [task, sibling, other] : [task, sibling])));
      await settle();
      // A slow session read must not temporarily empty an otherwise retained task.
      expect(store.loading()).toBe(true);
      expect(store.tasks()).toEqual(matching);
      resolveSessions(ok(page([{ ...session, taskId: 3, id: 13 }])));
      await selecting;
      expect(store.tasks().filter(task => task.id !== '7')).toEqual(matching);
      expect(store.tasks().map(task => task.id)).toEqual(projectId === 'all' ? ['3', '4', '7'] : ['3', '4']);
    }
  });

  it('keeps the active outline mounted through disjoint project reads, failures and interrupted returns', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const { store, bridge, start } = setup();
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, { ...project, id: 2 }])));
    await start();
    const fixture = TestBed.createComponent(WorkspaceNavigationComponent);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const list = root.querySelector('ex-task-list')!;
    const row = root.querySelector<HTMLElement>('[data-task-id="3"]')!;
    row.querySelector<HTMLButtonElement>('header .toggle')!.click();
    fixture.detectChanges();
    for (const fails of [false, true]) {
      let resolve!: (value: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
      bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const pending = store.selectProject('2'); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('ex-task-list')).toBe(list);
      expect(row.isConnected).toBe(true);
      expect(row.closest('[inert]')).not.toBeNull();
      expect(list.querySelector('[role="status"]')!.closest('[inert]')).toBeNull();
      expect(list.querySelector('p.empty')!.closest('[inert]')).not.toBeNull();
      resolve(fails ? { ok: false, error: { code: 'transport', message: 'Offline' } } : ok(page([])));
      await pending; fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('ex-task-list')).toBe(list);
      await store.selectProject('1'); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-task-id="3"]')).toBe(row);
      expect(row.closest('[inert]')).toBeNull();
      expect(row.querySelector('header .toggle')!.getAttribute('aria-expanded')).toBe('false');
    }
    fixture.destroy();
  });

  it('retains task disclosures across project navigation and resource mutations, and releases them with the backend scope', async () => {
    const {store,start,emit} = setup(); await start();
    const disclosures = new Map([['3',{taskId:'3',cap:5,hiddenIds:['old']}]]);
    store.sessionDisclosures.set(disclosures);
    await store.selectProject('1'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.selectProject('all'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.createSession('3'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}}); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.refresh(); expect(store.sessionDisclosures()).toBe(disclosures);
    emit({revision:2,scope:null}); TestBed.tick(); expect(store.sessionDisclosures().size).toBe(1); expect(store.offline()).toBe(true);
  });

  it('loads bounded task/session windows and selects a session', async () => {
    const { store, bridge, start } = setup(); await start();
    expect(bridge.workspaceTasks).toHaveBeenCalledWith('scope', { projectId: null, state: 'active', limit: 20 });
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope', { taskId: 3, limit: 20, order: 'latest' });
    store.selectSession({ taskId: '3', sessionId: '5' });
    expect(store.selected()).toEqual({ scopeId: 'scope', taskId: 3, sessionId: 5 });
  });

  it('keeps the matching task and session throughout project navigation, including older sessions', async () => {
    const { store, bridge, start } = setup(); await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    const selected = store.selected();
    let resolve!: (result: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
    bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    bridge.workspaceSessions.mockResolvedValue(ok(page(Array.from({ length: 20 }, (_, index) => ({ ...session, id: 10 + index })))));
    const selecting = store.selectProject('1');
    expect(store.loading()).toBe(true);
    expect(store.selected()).toBe(selected);
    expect(store.selectedTask()).toEqual(task);
    expect(store.selectedSession()).toEqual(session);
    resolve(ok(page([task]))); await selecting;
    expect(store.selected()).toBe(selected);
    expect(store.selectedSession()).toEqual(session);
    expect(store.tasks()[0]?.sessions).toHaveLength(21);
    expect(store.tasks()[0]?.sessions).toContainEqual(expect.objectContaining({ id: '29' }));
    await store.selectProject('all');
    expect(store.selected()).toBe(selected);
    expect(store.selectedSession()).toEqual(session);
  });

  it('keeps the matching view when project navigation fails, then clears it for another project', async () => {
    const { store, bridge, start } = setup();
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, { ...project, id: 2 }])));
    await start(); store.selectSession({ taskId: '3', sessionId: '5' });
    bridge.workspaceTasks.mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Unavailable' } });
    await store.selectProject('1');
    expect(store.selectedSession()).toEqual(session);
    expect(store.error()).toBe('Unavailable');
    let resolve!: (result: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
    bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const selecting = store.selectProject('2');
    expect(store.selected()).toBeNull();
    expect(store.selectedTask()).toBeNull();
    expect(store.selectedSession()).toBeNull();
    expect(store.tasks()).toEqual([]);
    resolve(ok(page([]))); await selecting;
  });

  it('rejects a retained project selection after a newer navigation', async () => {
    const { store, bridge, start } = setup();
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, { ...project, id: 2 }])));
    await start(); store.selectSession({ taskId: '3', sessionId: '5' });
    let resolve!: (result: BackendResult<WorkspacePage<WorkspaceTask>>) => void;
    bridge.workspaceTasks.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const selecting = store.selectProject('1');
    bridge.workspaceTasks.mockResolvedValueOnce(ok(page([])));
    await store.selectProject('2');
    resolve(ok(page([task]))); await selecting;
    expect(store.activeProject()).toBe('2');
    expect(store.selected()).toBeNull();
    expect(store.tasks()).toEqual([]);
  });

  it('does not send old resource IDs after the backend scope changes', async () => {
    const { store, bridge, emit, start } = setup(); await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    emit({ revision: 2, scope: { id: 'other', environment: { kind: 'local' } } });
    await store.createSession('3');
    expect(bridge.workspaceCreateSession).not.toHaveBeenCalled();
    TestBed.tick(); await settle();
    expect(store.selected()).toBeNull();
  });

  it('waits for task preparation and uses the backend-created initial session', async () => {
    const { store, bridge, start } = setup(); await start(); await store.openNewTask();
    await store.createTask({ title: 'Task', branch: 'task', base: 'main', existing: false, workspace: 'auto' });
    await settle();
    expect(bridge.workspaceTask).toHaveBeenCalledWith('scope', 3);
    expect(bridge.workspaceCreateSession).not.toHaveBeenCalled();
    expect(store.selected()).toEqual({ scopeId: 'scope', taskId: 3, sessionId: 5 });
    expect(store.pendingTask()).toBeNull();
  });

  it('stops preparation polling when navigating and preserves failed preparation', async () => {
    vi.useFakeTimers();
    const { store, bridge, start } = setup(); await start(); await store.openNewTask();
    bridge.workspaceTask.mockResolvedValue(ok({ ...task, state: 'preparing' }));
    await store.createTask({ title: 'Task', branch: 'task', base: 'main', existing: false, workspace: 'auto' }); await settle();
    expect(store.pendingTask()?.state).toBe('preparing');
    await store.selectProject('all');
    const calls = bridge.workspaceTask.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(bridge.workspaceTask).toHaveBeenCalledTimes(calls);
    await store.openNewTask();
    bridge.workspaceTask.mockResolvedValue(ok({ ...task, state: 'failed' }));
    await store.createTask({ title: 'Task', branch: 'task', base: 'main', existing: false, workspace: 'auto' }); await settle();
    expect(store.pendingTask()?.state).toBe('failed');
    expect(store.error()).toContain('could not be prepared');
  });

  it('recovers the saved failed task with explicit consent and never creates a second task', async () => {
    const { store, bridge, start } = setup(); await start();
    const failed: WorkspaceTask = { ...task, state: 'failed', setupIssue: { code: 'external-checkout', message: 'The branch is already checked out in another workspace.', workspacePath: '/work/existing', canUseSnapshot: true } };
    bridge.workspaceTask.mockResolvedValueOnce(ok(failed));
    await store.openNewTask(); await store.createTask({ title: 'Task', branch: 'existing', base: null, existing: true, workspace: 'auto' }); await settle();
    expect(store.error()).toBe(failed.setupIssue?.message);
    expect(bridge.workspaceRetryTask).not.toHaveBeenCalled();
    await store.retryPreparation('use-existing'); await settle();
    expect(bridge.workspaceRetryTask).toHaveBeenCalledWith('scope', task.id, 'use-existing');
    expect(bridge.workspaceCreateTask).toHaveBeenCalledTimes(1);
    expect(store.selected()?.taskId).toBe(task.id);
  });
  it('retries quota failures with explicit consent and blocks it for other failures', async () => {
    const { store, bridge, start } = setup(); await start();
    const failed: WorkspaceTask = { ...task, state: 'failed', setupIssue: { code: 'other', message: 'Workspace limit reached.', canUseSnapshot: false } };
    bridge.workspaceTask.mockResolvedValue(ok(failed));
    await store.openNewTask(); await store.createTask({ title: 'Task', branch: 'existing', base: null, existing: true, workspace: 'auto' }); await settle();
    await store.retryPreparation('exceed-worktree-limit');
    expect(bridge.workspaceRetryTask).not.toHaveBeenCalled();
    bridge.workspaceTask.mockResolvedValueOnce(ok({ ...failed, setupIssue: { ...failed.setupIssue!, canExceedWorktreeLimit: true } }));
    await store.reconcilePreparation();
    await store.retryPreparation('exceed-worktree-limit'); await settle();
    expect(bridge.workspaceRetryTask).toHaveBeenCalledWith('scope', task.id, 'exceed-worktree-limit');
    expect(bridge.workspaceCreateTask).toHaveBeenCalledTimes(1);
  });
  it('rejects a recovery reply after navigating away from its task', async () => {
    const { store, bridge, start } = setup(); await start();
    const failed: WorkspaceTask = { ...task, state: 'failed', setupIssue: { code: 'external-checkout', message: 'The branch is checked out.', canUseSnapshot: true } };
    bridge.workspaceTask.mockResolvedValue(ok(failed));
    await store.openNewTask(); await store.createTask({ title: 'Task', branch: 'existing', base: null, existing: true, workspace: 'auto' }); await settle();
    let resolve!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceRetryTask.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const pending = store.retryPreparation('use-existing');
    await store.selectProject('all');
    resolve(ok(task)); await pending; await settle();
    expect(store.pendingTask()).toBeNull(); expect(store.selected()).toBeNull();
  });

  it('blocks unknown setup replay until a focused durable task read reconciles it', async () => {
    const { store, bridge, start } = setup(); await start();
    const failed: WorkspaceTask = { ...task, state: 'failed', setupIssue: { code: 'external-checkout', message: 'The branch is checked out.', canUseSnapshot: true } };
    bridge.workspaceTask.mockResolvedValue(ok(failed));
    await store.openNewTask(); await store.createTask({ title: 'Task', branch: 'existing', base: null, existing: true, workspace: 'auto' }); await settle();
    bridge.workspaceRetryTask.mockResolvedValueOnce({ ok: false, error: { code: 'outcome-unknown', message: 'Unknown outcome.' } });
    await store.retryPreparation('snapshot'); await store.retryPreparation('snapshot');
    expect(bridge.workspaceRetryTask).toHaveBeenCalledTimes(1); expect(store.mutationUncertain()).toBe(true);
    await store.reconcilePreparation(); expect(store.mutationUncertain()).toBe(false);
    await store.retryPreparation('snapshot'); await settle();
    expect(bridge.workspaceRetryTask).toHaveBeenCalledTimes(2);
    expect(bridge.workspaceCreateTask).toHaveBeenCalledTimes(1);
  });

  it('opens a local session immediately, coalesces repeated clicks and adopts its draft on confirmation', async () => {
    const { store, bridge, start } = setup(); await start();
    let finish!: (result: BackendResult<WorkspaceSession>) => void;
    bridge.workspaceCreateSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = store.createSession('3');
    const starting = store.selectedCreation()!;
    expect(starting.status).toBe('creating'); expect(store.chatOpen()).toBe(true);
    expect(store.selected()).toBeNull(); expect(store.selectedTask()).toEqual(task); expect(store.busy()).toBe(false);
    expect(store.taskSelection()).toEqual({ scopeId: 'scope', taskId: 3 });
    expect(store.tasks()[0]!.sessions.at(-1)).toMatchObject({ id: starting.id, local: true, renderId: starting.id });
    expect(store.sessionMentionItems().some(item => item.id === starting.id)).toBe(false);
    starting.draft.setText('Writing before the server responds');
    await store.createSession('3'); expect(bridge.workspaceCreateSession).toHaveBeenCalledTimes(1);
    finish(ok({ ...session, id: 6 })); await creating;
    expect(store.selectedCreation()).toBeNull();
    expect(store.selected()).toEqual({ scopeId: 'scope', taskId: 3, sessionId: 6 });
    expect(store.tasks()[0]!.sessions.at(-1)).toMatchObject({ id: '6', renderId: starting.id });
    expect(TestBed.inject(SessionChatDrafts).entry({ scopeId: 'scope', taskId: 3, sessionId: 6 })).toBe(starting.draft);
  });

  it('keeps the created row and draft without taking selection back after navigation', async () => {
    const { store, bridge, start } = setup(); await start();
    let finish!: (result: BackendResult<WorkspaceSession>) => void;
    bridge.workspaceCreateSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = store.createSession('3'); const starting = store.selectedCreation()!;
    starting.draft.setText('Keep this new conversation');
    store.selectSession({ taskId: '3', sessionId: '5' });
    finish(ok({ ...session, id: 6 })); await creating;
    expect(store.selected()?.sessionId).toBe(5);
    expect(TestBed.inject(SessionChatDrafts).entry({ scopeId: 'scope', taskId: 3, sessionId: 6 }).text()).toBe('Keep this new conversation');
    expect(store.tasks()[0]!.sessions.filter(row => row.id === '6')).toHaveLength(1);
  });

  it('retains failed creation and writing for explicit retry, and never retries an uncertain create', async () => {
    const { store, bridge, start } = setup(); await start();
    bridge.workspaceCreateSession.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 409, message: 'Task is preparing.' } });
    await store.createSession('3');
    const starting = store.selectedCreation()!; starting.draft.setText('Keep this');
    expect(starting.status).toBe('failed'); expect(starting.error).toBe('Task is preparing.');
    expect(store.error()).toBeNull(); expect(store.mutationUncertain()).toBe(false);
    bridge.workspaceCreateSession.mockResolvedValueOnce({ ok: false, error: { code: 'outcome-unknown', message: 'Unknown.' } });
    await store.retrySessionCreation();
    expect(store.selectedCreation()?.draft).toBe(starting.draft);
    expect(store.selectedCreation()?.status).toBe('unknown');
    await store.createSession('3'); await store.retrySessionCreation(); await store.refresh(); await store.retrySessionCreation();
    expect(bridge.workspaceCreateSession).toHaveBeenCalledTimes(2);
    expect(store.selectedCreation()?.draft.text()).toBe('Keep this');
    // Ambiguity belongs to this local session, rather than disabling unrelated workspace actions.
    expect(store.busy()).toBe(false); expect(store.mutationUncertain()).toBe(false);
  });

  it('rejects a late creation from a replaced backend without adopting its IDs or writing', async () => {
    const { store, bridge, start, emit } = setup(); await start();
    let finish!: (result: BackendResult<WorkspaceSession>) => void;
    bridge.workspaceCreateSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = store.createSession('3');
    emit({ revision: 2, scope: { id: 'other', environment: { kind: 'local' } } }); TestBed.tick(); await settle();
    finish(ok({ ...session, id: 99 })); await creating;
    expect(store.selectedCreation()).toBeNull(); expect(store.selected()).toBeNull();
    expect(store.tasks().flatMap(task => task.sessions).some(session => session.id === '99')).toBe(false);
  });

  it('searches bounded remote branch windows with separate base choices and debounces input', async () => {
    vi.useFakeTimers();
    const { store, bridge, start } = setup(); await start(); await store.openNewTask();
    bridge.workspaceBranches.mockClear();
    store.searchBranches({ repoId: '2', query: 'feature', kind: 'branch' });
    store.searchBranches({ repoId: '2', query: 'feature-299', kind: 'branch' });
    await vi.advanceTimersByTimeAsync(160);
    expect(bridge.workspaceBranches).toHaveBeenCalledTimes(1);
    expect(bridge.workspaceBranches).toHaveBeenCalledWith('scope', { repoId: 2, query: 'feature-299', limit: 50, includeRemote: true });
    expect(store.taskRepositories()[0]?.base).toBe('main');
    const branches = store.branchesFor('2');
    store.searchBranches({ repoId: '2', query: 'main', kind: 'base' });
    await vi.advanceTimersByTimeAsync(160);
    expect(store.branchesFor('2')).toBe(branches);
    expect(store.basesFor('2')).toHaveLength(1);
  });

  it('loads the current task repository first and saves an existing remote branch as planned', async () => {
    const { store, bridge, start } = setup();
    const repository = detail.repositories.items[0]!;
    bridge.workspaceProject.mockResolvedValue({ ok: true, value: {
      ...detail, repositories: page([{ ...repository, id: 7, name: 'Other repository' }, repository]),
    } });
    bridge.workspaceBranches.mockResolvedValue(ok([
      { name: 'origin/main', ref: 'refs/remotes/origin/main', remoteBranch: 'main', current: false, isDefault: true, defaultBase: 'refs/remotes/origin/main', heldTaskName: 'Base task' },
    ]));
    await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    await store.openNewTask();
    expect(store.draftTaskRepository()).toBe('2');
    expect(bridge.workspaceBranches).toHaveBeenCalledExactlyOnceWith('scope', { repoId: 2, limit: 50, includeRemote: true });
    expect(store.basesFor('2')).toEqual([{ name: 'origin/main', ref: 'refs/remotes/origin/main', remote: true, remoteBranch: 'main', task: 'Base task', isDefault: true }]);
    await store.planTask({ repo: '2', title: 'Continue review', branch: 'refs/remotes/origin/review', existing: true, workspace: 'auto' });
    expect(bridge.workspaceCreateTask).toHaveBeenCalledWith('scope', {
      repoId: 2, name: 'Continue review', branchName: 'refs/remotes/origin/review', mode: 'existing', requestId: expect.any(String),
    });
    expect(bridge.workspaceSetStage).toHaveBeenCalledWith('scope', { taskId: task.id, stage: 'planned' });
  });

  it('clears branch search on close, rejects the old reply and retries a failed lookup', async () => {
    vi.useFakeTimers();
    const { store, bridge, start } = setup(); await start(); await store.openNewTask();
    let finish!: (reply: Awaited<ReturnType<ElevenexBridge['workspaceBranches']>>) => void;
    bridge.workspaceBranches.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const lookup = { repoId: '2', query: 'upstream', kind: 'base' as const };
    store.searchBranches(lookup);
    await vi.advanceTimersByTimeAsync(160);
    expect(store.branchLoading()).toBe(true);
    store.closeDialog();
    expect(store.branchLoading()).toBe(false);
    await store.openNewTask();
    finish(ok([{ name: 'old', current: false, isDefault: false, defaultBase: null, heldTaskName: null }]));
    await settle();
    expect(store.basesFor('2')[0]?.name).toBe('main');
    bridge.workspaceBranches.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 500, message: 'Unavailable' } });
    store.searchBranches(lookup);
    await vi.advanceTimersByTimeAsync(160);
    expect(store.branchLoading()).toBe(false);
    expect(store.branchSearchFailed()).toBe(true);
    bridge.workspaceBranches.mockResolvedValueOnce(ok([{ name: 'upstream/main', current: false, isDefault: false, defaultBase: 'main', heldTaskName: null }]));
    store.searchBranches(lookup);
    await vi.advanceTimersByTimeAsync(160);
    expect(store.branchSearchFailed()).toBe(false);
    expect(store.basesFor('2')[0]?.name).toBe('upstream/main');
  });

  it('retains the outgoing project draft and requests focus on the workspace action after closure', async () => {
    const { store, bridge, start } = setup(); await start();
    const createdProject = { ...project, id: 7, name: 'New project' }, createdDetail = { ...detail, project: createdProject };
    bridge.workspaceCreateProject.mockResolvedValue(ok(createdDetail));
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, createdProject])));
    bridge.workspaceProject.mockResolvedValue(ok(createdDetail));
    const origin = document.createElement('button');
    store.openNewProject(origin);
    expect(store.dialogFrom()).toBe(origin);
    const draftKey = store.dialogKey();
    await store.createProject({ project: { name: 'New project', repos: [{ id: 'repo', name: 'repo', path: '/repo' }], look: 'letters', hue: 'ocean' }, card: document.createElement('section') });
    expect(store.dialog()).toBe('project'); expect(store.dialogKey()).toBe(draftKey);
    expect(store.dialogOpen()).toBe(false); expect(store.dialogFrom()).toBeNull();
    expect(store.projects().some(project => project.id === '7')).toBe(true);
    expect(bridge.workspaceProject).not.toHaveBeenCalled();
    expect(store.projectCreated()).toBeNull();
    store.dialogClosed();
    expect(bridge.workspaceProject).not.toHaveBeenCalled();
    expect(bridge.workspaceBranches).not.toHaveBeenCalled();
    expect(store.projectCreated()).toBe(7);
    expect(store.dialogOpen()).toBe(false);
    expect(store.dialogKey()).toBe(draftKey);
  });

  it('cancels the post-creation focus request when another project is selected before exit ends', async () => {
    const { store, bridge, start } = setup(); await start();
    const created = { ...project, id: 7, name: 'Created' };
    bridge.workspaceCreateProject.mockResolvedValue(ok({ ...detail, project: created }));
    bridge.workspaceProjects.mockResolvedValue(ok(page([project, created])));
    store.openNewProject();
    await store.createProject({ project: { name: 'Created', repos: [{ id: 'repo', name: 'repo', path: '/repo' }], look: 'letters', hue: 'ocean' }, card: document.createElement('section') });
    await store.selectProject('1'); store.dialogClosed();
    expect(store.projectCreated()).toBeNull();
    expect(store.dialogOpen()).toBe(false);
  });

  it('opens a bounded project window when a created project is beyond the first page', async () => {
    const { store, bridge, start } = setup(); await start();
    const createdProject = { ...project, id: 77, name: 'Newest project' };
    bridge.workspaceCreateProject.mockResolvedValue(ok({ ...detail, project: createdProject }));
    bridge.workspaceProjects.mockResolvedValueOnce(ok(page(Array.from({ length: 50 }, (_, index) => ({ ...project, id: index + 1 }))))).mockResolvedValueOnce(ok(page([createdProject])));
    await store.createProject({ project: { name: 'Newest project', repos: [{ id: 'repo', name: 'repo', path: '/repo' }], look: 'letters', hue: 'ocean' }, card: document.createElement('section') });
    expect(bridge.workspaceProjects).toHaveBeenLastCalledWith('scope', { limit: 50, cursor: '76' });
    expect(store.projects()).toHaveLength(1);
    expect(store.selectedProject()?.id).toBe(77);
  });

  it('rotates folder-provider identity on backend replacement and rejects a retained old provider', async () => {
    const { store, bridge, emit, start } = setup(); await start();
    const previous = store.folderProvider();
    emit({ revision: 2, scope: { id: 'other', environment: { kind: 'local' } } });
    TestBed.tick(); await settle();
    expect(store.folderProvider()).not.toBe(previous);
    expect(await previous('/code/', new AbortController().signal)).toEqual([]);
    expect(bridge.workspaceFolders).not.toHaveBeenCalled();
  });

  it('debounces folder queries, rejects stale results and keeps read errors local to the picker', async () => {
    vi.useFakeTimers();
    const { store, bridge, start } = setup(); await start();
    const old = new AbortController();
    const stale = store.listFolders('/old', old.signal); old.abort();
    await stale;
    expect(bridge.workspaceFolders).not.toHaveBeenCalled();
    const current = store.listFolders('/code', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(140); await current;
    expect(bridge.workspaceFolders).toHaveBeenCalledWith('scope', { query: '/code', limit: 50 });
    bridge.workspaceFolders.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 400, message: 'Folder unavailable.' } });
    const failed = store.listFolders('/unavailable', new AbortController().signal);
    const assertion = expect(failed).rejects.toThrow('Folder unavailable.');
    await vi.advanceTimersByTimeAsync(140); await assertion;
    expect(store.error()).toBeNull();
  });

  it('keeps the project opener on cancellation and never schedules a new task', async () => {
    const { store, bridge, start } = setup(); await start();
    const origin = document.createElement('button');
    store.openNewProject(origin); store.closeDialog(); await store.dialogClosed();
    expect(store.dialogFrom()).toBe(origin);
    expect(bridge.workspaceProject).not.toHaveBeenCalled(); expect(store.dialogOpen()).toBe(false);
  });

  it('updates sidebar counts from backend activity after leaving a session', async () => {
    const { store, bridge, start } = setup(); await start();
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, status: 'running' }, { ...session, id: 6, name: 'Another session' }])));
    await store.loadTasks();
    expect(store.counts().running).toBe(1);
    store.selectSession({ taskId: '3', sessionId: '6' });
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, status: 'done' }, { ...session, id: 6, status: 'attention' }])));
    bridge.workspaceTasks.mockClear(); bridge.workspaceSessions.mockClear();
    await store.loadTasks();
    expect(store.tasks()[0]?.sessions.find(item => item.id === '5')?.status).toBe('done');
    expect(store.counts()).toMatchObject({ running: 0, done: 1, attention: 1 });
    expect(bridge.workspaceTasks).toHaveBeenCalledTimes(1); expect(bridge.workspaceSessions).toHaveBeenCalledTimes(1);
  });
});

it('keeps a temporary task open without changing the selected session', async () => {
  const { store, bridge, start } = setup();
  bridge.workspaceTasks.mockResolvedValue(ok(page([{ ...task, temporary: true }])));
  await start();
  await store.selectSession({ taskId: '3', sessionId: '5' });
  expect(store.selectedTask()?.temporary).toBe(true);
  expect(store.tasks()[0]?.temporary).toBe(true);
  await store.keepTaskOpen();
  expect(bridge.workspaceKeepTaskOpen).toHaveBeenCalledExactlyOnceWith('scope', 3);
  expect(store.selectedTask()?.temporary).toBeUndefined();
  expect(store.tasks()[0]?.temporary).toBeUndefined();
  expect(store.selectedSession()?.id).toBe(5);
  await store.keepTaskOpen();
  expect(bridge.workspaceKeepTaskOpen).toHaveBeenCalledTimes(1);
});

it('retains a scope-bound task Undo after close, and never reuses it in another backend', async () => {
  const {store, bridge, start, emit} = setup(); await start();
  await store.selectSession({taskId: '3', sessionId: '5'});
  bridge.workspaceFinishTask.mockImplementation(async () => { bridge.workspaceTasks.mockResolvedValue(ok(page([]))); return ok({...task,state:'finished',archivedAt:'now'}); });
  await store.closeTask();
  expect(store.closeUndo()?.task.id).toBe(3); expect(store.selected()).toBeNull();
  bridge.workspaceReopenTask.mockImplementation(async () => { bridge.workspaceTasks.mockResolvedValue(ok(page([task]))); return ok(task); });
  await store.undoClose();
  expect(bridge.workspaceReopenTask).toHaveBeenCalledExactlyOnceWith('scope', 3); expect(store.closeUndo()).toBeNull();
  await store.selectSession({taskId:'3',sessionId:'5'}); await store.closeTask();
  emit({revision:2,scope:{id:'other',environment:{kind:'local'}}}); TestBed.tick(); await settle();
  await store.undoClose(); expect(bridge.workspaceReopenTask).toHaveBeenCalledTimes(1);
});


describe('workspace session archive', () => {
  it('permanently deletes unstarted rows without archives or Undo, retaining selection and children', async () => {
    const { store, bridge, start } = setup(true);
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, canDelete: true }, { ...session, id: 6, parentSessionId: 5, status: 'done' }])));
    await start(); store.selectSession({taskId:'3',sessionId:'5'});
    const archiveReads = bridge.workspaceSessions.mock.calls.length;
    expect(store.tasks()[0]?.sessions[0]?.canDelete).toBe(true);
    await store.deleteSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(bridge.workspaceDeleteSession).toHaveBeenCalledWith('scope',{taskId:3,sessionId:5});
    expect(bridge.workspaceArchiveSession).not.toHaveBeenCalled();
    expect(bridge.workspaceSessions.mock.calls.length).toBe(archiveReads);
    expect(store.tasks()[0]?.sessions.map(row=>row.id)).toEqual(['6']);
    expect(store.selected()?.sessionId).toBe(6);
    expect(store.sessionArchiveUndo()).toBeNull();
  });
  it('retains a rejected deletion and refuses to delete without explicit eligibility', async () => {
    const { store, bridge, start } = setup();
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, canDelete: true }])));
    await start();
    bridge.workspaceDeleteSession.mockResolvedValueOnce({ok:false,error:{code:'http',message:'This session has started. Archive it instead.'}});
    await store.deleteSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(store.tasks()[0]?.sessions).toHaveLength(1);
    expect(store.error()).toContain('has started');
    bridge.workspaceSessions.mockResolvedValue(ok(page([{...session,canDelete:false}])));
    await store.refresh();
    await store.deleteSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(bridge.workspaceDeleteSession).toHaveBeenCalledOnce();
  });
  it('ignores a late deletion after the backend scope changes', async () => {
    const { store, bridge, start, emit } = setup();
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, canDelete: true }])));
    await start();
    let complete!: (value: BackendResult<{readonly accepted:true}>)=>void;
    bridge.workspaceDeleteSession.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const pending = store.deleteSession({taskId:'3',session:{id:'5',status:'queued'}});
    emit({revision:2,scope:null}); TestBed.tick(); complete(ok({accepted:true}));
    expect(await pending).toBe(false);
    expect(store.tasks()[0]?.sessions).toHaveLength(1);
  });
  it('removes the row, chooses the next normal session and restores a stopped conversation with Undo', async () => {
    const {store, bridge, start} = setup();
    bridge.workspaceSessions.mockResolvedValue(ok(page([session, {...session, id:6, status:'done'}, {...session, id:7, status:'running'}])));
    await start(); store.selectSession({taskId:'3',sessionId:'5'});
    store.closeUndo.set({scopeId:'scope',task});
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(bridge.workspaceArchiveSession).toHaveBeenCalledWith('scope',{taskId:3,sessionId:5,confirmStop:false});
    expect(store.tasks()[0]?.sessions.map(row=>row.id)).toEqual(['6','7']);
    expect(store.selected()?.sessionId).toBe(6);
    expect(store.sessionArchiveUndo()?.session.id).toBe(5);
    expect(store.closeUndo()).toBeNull();
    await store.undoSessionArchive();
    expect(bridge.workspaceRestoreSession).toHaveBeenCalledWith('scope',{taskId:3,sessionId:5});
    expect(store.tasks()[0]?.sessions.map(row=>row.id)).toEqual(['5','6','7']);
    expect(store.sessionArchiveUndo()).toBeNull();
  });
  it('wraps selection to a stopped session and clears it only after the last session is archived', async () => {
    const {store, bridge, start} = setup();
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, status: 'stopped' }, { ...session, id: 6, status: 'done' }])));
    await start(); await store.selectSession({taskId: '3', sessionId: '6'});
    await store.archiveSession({taskId:'3', session:{id:'6',status:'done'}});
    expect(store.selected()?.sessionId).toBe(5);
    await store.archiveSession({taskId:'3', session:{id:'5',status:'done'}});
    expect(store.selected()).toBeNull();
    expect(store.tasks()[0]?.sessions).toEqual([]);
  });
  it('retains rows on archive rejection and keeps Undo available on restore rejection', async () => {
    const {store,bridge,start} = setup(); await start();
    bridge.workspaceArchiveSession.mockResolvedValueOnce({ok:false,error:{code:'http',message:'Session became running.'}});
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(store.tasks()[0]?.sessions).toHaveLength(1); expect(store.sessionArchiveUndo()).toBeNull();
    await store.archiveSession({taskId:'3',session:{id:'5',status:'running'}});
    expect(bridge.workspaceArchiveSession).toHaveBeenLastCalledWith('scope',{taskId:3,sessionId:5,confirmStop:true});
    bridge.workspaceRestoreSession.mockResolvedValue({ok:false,error:{code:'http',message:'Try again.'}});
    await store.undoSessionArchive(); expect(store.sessionArchiveUndo()).not.toBeNull();
  });
  it('shows the agent turn plus a command count, and confirms stopping when commands remain', async () => {
    const {store,bridge,start} = setup();
    bridge.workspaceSessions.mockResolvedValue(ok(page([{ ...session, status: 'running', turnStatus: 'review', commandCount: 2 }, { ...session, id: 6, status: 'running' }])));
    await start();
    const [finished, working] = store.tasks()[0]!.sessions;
    expect(finished).toMatchObject({ id: '5', status: 'review', commands: 2 });
    expect(working).toMatchObject({ id: '6', status: 'running' });
    expect(working && 'commands' in working).toBe(false);
    expect(store.counts().running).toBe(1);
    await store.archiveSession({taskId:'3',session:{id:'5',status:'review'}});
    expect(bridge.workspaceArchiveSession).toHaveBeenLastCalledWith('scope',{taskId:3,sessionId:5,confirmStop:true});
  });
  it('rejects late replies and clears Undo when the backend scope changes', async () => {
    const {store,bridge,start,emit} = setup(); await start();
    let complete!: (value: BackendResult<{readonly accepted:true}>)=>void;
    bridge.workspaceArchiveSession.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    emit({revision:2,scope:null}); TestBed.tick(); complete(ok({accepted:true})); await pending;
    expect(store.sessionArchiveUndo()).toBeNull(); expect(store.tasks()).toHaveLength(1); expect(store.offline()).toBe(true);
    await store.undoSessionArchive(); expect(bridge.workspaceRestoreSession).not.toHaveBeenCalled();
  });
});


describe('workspace archived history', () => {
  it('loads persisted history lazily, keeps it separate through refresh, and restores without Undo', async () => {
    const { store, bridge, start } = setup(true);
    let records: WorkspaceSession[] = [session, { ...session, id: 8, name: 'Earlier archived work', status: 'archived' }];
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(records.filter(row => query.state === 'archived' ? row.status === 'archived' : row.status !== 'archived'))));
    bridge.workspaceArchiveSession.mockImplementation(async () => { records = records.map(row => row.id === 5 ? { ...row, status: 'archived' } : row); return ok({accepted:true}); });
    bridge.workspaceRestoreSession.mockImplementation(async () => { const restored = { ...session, status: 'stopped' }; records = records.map(row => row.id === 5 ? restored : row); return ok(restored); });
    await start();
    expect(store.tasks()[0]?.archive?.loaded).toBe(false);
    expect(bridge.workspaceSessions.mock.calls.filter(([,query]) => query.state === 'archived').map(([,query]) => query.limit)).toEqual([1]);
    await store.loadArchivedSessions({taskId:'3',page:'latest'});
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['8']);
    store.selectSession({taskId:'3',sessionId:'8'});
    expect(store.selectedSession()?.status).toBe('archived');
    await store.refresh();
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['5']);
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['8']);
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(store.tasks()[0]?.sessions).toEqual([]);
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['5','8']);
    store.sessionArchiveUndo.set(null);
    await store.restoreSession({taskId:'3',session:{id:'5'}});
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['5']);
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['8']);
    expect(store.selected()?.sessionId).toBe(5);
    expect(store.counts().done).toBe(1);
  });

  it('pages history without replacing normal sessions and clears selection that leaves the archive window', async () => {
    const {store,bridge,start} = setup(true); await start();
    bridge.workspaceSessions.mockResolvedValueOnce(ok({items:[{...session,id:8,status:'archived'}],nextCursor:'8'}));
    await store.loadArchivedSessions({taskId:'3',page:'latest'});
    store.selectSession({taskId:'3',sessionId:'8'});
    bridge.workspaceSessions.mockResolvedValueOnce(ok(page([{...session,id:4,status:'archived'}])));
    await store.loadArchivedSessions({taskId:'3',page:'earlier'});
    expect(bridge.workspaceSessions).toHaveBeenLastCalledWith('scope',{taskId:3,state:'archived',order:'latest',limit:20,cursor:'8'});
    expect(store.selected()).toBeNull();
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['5']);
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['4']);
  });

  it('hides empty archives on initial load and refresh, and after restoring the last conversation', async () => {
    const {store,bridge,start} = setup(true);
    let archived = false;
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.state === 'archived' ? archived ? [{...session,status:'archived'}] : [] : archived ? [] : [session])));
    bridge.workspaceArchiveSession.mockImplementation(async () => { archived = true; return ok({accepted:true}); });
    bridge.workspaceRestoreSession.mockImplementation(async () => { archived = false; return ok({...session,status:'stopped'}); });
    await start();
    expect(store.tasks()[0]?.archive).toBeUndefined();
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    expect(store.tasks()[0]?.archive?.sessions.map(row => row.id)).toEqual(['5']);
    await store.loadArchivedSessions({taskId:'3',page:'latest'});
    await store.restoreSession({taskId:'3',session:{id:'5'}});
    expect(store.tasks()[0]?.archive).toBeUndefined();
    await store.refresh();
    expect(store.tasks()[0]?.archive).toBeUndefined();
  });

  it('does not query archive history on older runtimes', async () => {
    const {store,bridge,start} = setup(); await start();
    await store.loadArchivedSessions({taskId:'3',page:'latest'});
    expect(store.tasks()[0]?.archive).toBeUndefined();
    expect(bridge.workspaceSessions).toHaveBeenCalledTimes(1);
  });
});


describe('Workspace outages', () => {
  it.each([false, true])('keeps an interrupted create request ID after another draft opens (recovered: %s)', async recovered => {
    const { store, bridge, start, emit } = setup(); await start(); await store.openNewTask();
    let finish!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceCreateTask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = store.createTask({ title: 'Original', repo: '2', branch: 'original', existing: false, workspace: 'auto', base: 'main' });
    const requestId = bridge.workspaceCreateTask.mock.calls[0]![1].requestId;
    emit({ revision: 2, scope: null }); TestBed.tick();
    await store.openNewTask();
    await store.createTask({ title: 'Later offline task', repo: '2', branch: 'later', existing: false, workspace: 'auto', base: 'main' });
    if (recovered) {
      emit({ revision: 3, scope: { id: 'recovered', environment: { kind: 'local' } } }); TestBed.tick();
      for (let i = 0; i < 150; i++) await Promise.resolve(); TestBed.tick();
      expect(store.mutationUncertain()).toBe(false);
    }
    finish({ ok: false, error: { code: 'outcome-unknown', message: 'Lost reply' } }); await creating;
    expect(store.waitingTasks().find(item => item.draft.title === 'Original')).toMatchObject({ id: requestId, status: 'unknown' });
  });

  it('does not put a late task result in a different machine’s outbox', async () => {
    const { store, bridge, start, emit } = setup(); await start(); await store.openNewTask();
    let finish!: (value: BackendResult<WorkspaceTask>) => void;
    bridge.workspaceCreateTask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const creating = store.createTask({ title: 'Original', repo: '2', branch: 'original', existing: false, workspace: 'auto', base: 'main' });
    emit({ revision: 2, scope: null }); TestBed.tick();
    store.connect({ id: 'other', name: 'Other server', kind: 'ssh', conn: 'idle' }, true); TestBed.tick();
    finish({ ok: false, error: { code: 'outcome-unknown', message: 'Lost reply' } }); await creating;
    expect(store.waitingTasks()).toEqual([]);
  });

  it('returns a cancelled edit to the queue and opens a clean task form after recovery', async () => {
    const { store, start, emit } = setup(); await start(); await store.openNewTask();
    emit({ revision: 2, scope: null }); TestBed.tick();
    await store.createTask({ title: 'Queued original', repo: '2', branch: 'queued', existing: false, workspace: 'auto', base: 'main' });
    const id = store.waitingTasks()[0]!.id;
    store.editWaitingTask(id); store.closeDialog();
    expect(store.waitingTasks()[0]).toMatchObject({ id, status: 'waiting', draft: { title: 'Queued original' } });
    expect(store.editingTask()).toBeNull();
    emit({ revision: 3, scope: { id: 'recovered', environment: { kind: 'local' } } }); TestBed.tick();
    for (let i = 0; i < 150; i++) await Promise.resolve(); TestBed.tick();
    await store.openNewTask();
    expect(store.dialogOpen()).toBe(true); expect(store.editingTask()).toBeNull();
  });

  it('retains loaded selection and dialog draft through loss, then reconciles resources before rebinding', async () => {
    const { store, bridge, start, emit } = setup(); await start();
    store.selectSession({ taskId: '3', sessionId: '5' });
    await store.openNewTask(); const dialog = store.dialogKey();
    emit({ revision: 2, scope: null }); TestBed.tick(); await settle();
    expect(store.offline()).toBe(true); expect(store.tasks()).toHaveLength(1);
    expect(store.selected()).toEqual({ scopeId: 'scope', taskId: 3, sessionId: 5 });
    expect(store.dialogOpen()).toBe(true); expect(store.dialogKey()).toBe(dialog);
    await store.deleteProject(); expect(bridge.workspaceDeleteProject).not.toHaveBeenCalled();
    emit({ revision: 3, scope: { id: 'recovered', environment: { kind: 'local' } } }); TestBed.tick();
    for (let i = 0; i < 80; i++) await Promise.resolve(); TestBed.tick();
    expect(store.selected()).toEqual({ scopeId: 'recovered', taskId: 3, sessionId: 5 });
    expect(store.dialogKey()).toBe(dialog); expect(bridge.workspaceCreateTask).not.toHaveBeenCalled();
  });
  it('queues cached task drafts once and allows removal before reconnection', async () => {
    const { store, bridge, start, emit } = setup(); await start(); await store.openNewTask();
    emit({ revision: 2, scope: null }); TestBed.tick();
    await store.createTask({ title: 'Wait here', repo: '2', branch: 'wait-here', existing: false, workspace: 'auto', base: 'main' });
    expect(store.waitingTasks()).toHaveLength(1); expect(bridge.workspaceCreateTask).not.toHaveBeenCalled();
    store.removeWaitingTask(store.waitingTasks()[0]!.id);
    emit({ revision: 3, scope: { id: 'recovered', environment: { kind: 'local' } } }); TestBed.tick(); await settle();
    expect(bridge.workspaceCreateTask).not.toHaveBeenCalled();
  });
});

describe('session organization', () => {
  it('archives the group and moves selection out of a removed child', async () => {
    const { store, bridge, start } = setup();
    const parent = { ...session, childCount: 25, childStopRequired: true, activeChildAgents: [6] };
    const child = { ...session, id: 6, status: 'running', parentSessionId: parent.id };
    const other = { ...session, id: 7 };
    bridge.workspaceRevision.mockImplementation(async () => ok({
      revision: 1, version: 1 as const, sessionArchive: true as const,
      sessionArchiveChildren: true as const, sessionNesting: true as const, sessionPriority: true as const,
    }));
    bridge.workspaceSessions.mockImplementation(async (_scope, query) => {
      if (query.state === 'priority') return ok({ ...page([child]), parentSessions: [parent] });
      return ok(page(query.parentSessionId === parent.id ? [child] : [other]));
    });
    await start();
    await store.loadSessionChildren({ taskId: '3', sessionId: '5' });
    store.selectSession({ taskId: '3', sessionId: '6' });
    const parentRow = store.tasks()[0]!.sessions.find(row => row.id === '5')!;
    expect(parentRow.childStopRequired).toBe(true);
    await store.archiveSession({ taskId: '3', session: parentRow });
    expect(bridge.workspaceArchiveSession).toHaveBeenCalledWith('scope', {
      taskId: 3, sessionId: 5, includeChildren: true, confirmStop: true, stopAgents: [6],
    });
    expect(store.tasks()[0]?.sessions.map(row => row.id)).toEqual(['7']);
    expect(store.hierarchy.windows().has(parent.id)).toBe(false);
    expect(store.selected()?.sessionId).toBe(other.id);
  });
  it('uses bounded root and child pages, then keeps the selected child through a confirmed move', async () => {
    const {store,bridge,start} = setup();
    let parentSessionId: number | null = null;
    const parent = {...session,id:6,name:'Plan',parentSessionId:null};
    bridge.workspaceRevision.mockImplementation(async()=>ok({revision:1,version:1 as const,sessionArchive:true as const,sessionNesting:true as const,sessionNestingOrder:true as const}));
    bridge.workspaceSessions.mockImplementation(async(_scope,query)=>ok(page(query.parentSessionId === 6 ? [{...session,parentSessionId}] : parentSessionId === null ? [{...session,parentSessionId},parent] : [{...parent,childCount:1}])));
    bridge.workspaceMoveSession.mockImplementation(async(_scope,input)=>{ parentSessionId=input.parentSessionId; return ok({...session,parentSessionId}); });
    await start(); await store.selectSession({taskId:'3',sessionId:'5'});
    await store.moveSession({taskId:'3',sessionId:'5',parentSessionId:'6'});
    expect(bridge.workspaceMoveSession).toHaveBeenCalledWith('scope',{taskId:3,sessionId:5,parentSessionId:6});
    expect(bridge.workspaceSessions).toHaveBeenCalledWith('scope',{taskId:3,parentSessionId:6,limit:20,order:'latest',childOrder:'nested'});
    expect(store.selectedSession()?.parentSessionId).toBe(6);
    expect(store.tasks()[0]?.sessions.find(row=>row.id==='5')?.parentId).toBe('6');
    await store.moveSession({taskId:'3',sessionId:'5',parentSessionId:null});
    expect(store.selectedSession()?.parentSessionId).toBeNull();
  });
  it('does not replay or optimistically apply an uncertain move', async () => {
    const {store,bridge,start}=setup();
    bridge.workspaceRevision.mockImplementation(async()=>ok({revision:1,version:1 as const,sessionArchive:true as const,sessionNesting:true as const}));
    bridge.workspaceSessions.mockResolvedValue(ok(page([session,{...session,id:6}])));
    bridge.workspaceMoveSession.mockResolvedValue({ok:false,error:{code:'outcome-unknown',message:'Unknown'}});
    await start();
    await store.moveSession({taskId:'3',sessionId:'5',parentSessionId:'6'});
    await store.moveSession({taskId:'3',sessionId:'5',parentSessionId:'6'});
    expect(bridge.workspaceMoveSession).toHaveBeenCalledTimes(1);
    expect(store.tasks()[0]?.sessions.find(row=>row.id==='5')?.parentId).toBeNull();
    expect(store.error()).toContain('could not be confirmed');
  });
});
