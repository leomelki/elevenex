import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendClientState, BackendResult, ElevenexBridge, WorkspacePage, WorkspaceProject, WorkspaceProjectDetail, WorkspaceSession, WorkspaceSessionQuery, WorkspaceTask, WorkspaceTaskRecovery } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceDialogsComponent } from './workspace-dialogs.component';

const project: WorkspaceProject = { id: 1, name: 'Project', agentInstructions: null };
const session: WorkspaceSession = { id: 5, taskId: 3, repoId: 2, name: 'Session', status: 'created', provider: 'claude', updatedAt: '' };
const task: WorkspaceTask = { id: 3, projectId: 1, repoId: 2, name: 'Task', branchName: 'task', stage: 'active', state: 'ready', archivedAt: null, updatedAt: '' };
const detail: WorkspaceProjectDetail = { project, repositories: { items: [{ id: 2, projectId: 1, name: 'repo', path: '/repo', defaultBase: 'main' }], nextCursor: null } };
const page = <T>(items: readonly T[]): WorkspacePage<T> => ({ items, nextCursor: null });
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });

async function settle(): Promise<void> { for (let index = 0; index < 15; index++) await Promise.resolve(); }

function setup(history = false) {
  let listener!: (state: BackendClientState) => void;
  const bridge = {
    environmentStatus: vi.fn(async (): Promise<import('@elevenex/shared').EnvironmentSnapshot> => ({ selection: { kind: 'local' }, context: { projectId: null, taskId: null, sessionId: null, draft: '', cursor: null }, connection: null, challenge: null, forwards: [] })),
    saveEnvironmentContext: vi.fn(async (context: import('@elevenex/shared').EnvironmentContext, selection: import('@elevenex/shared').EnvironmentSelection) => ({ selection, context, connection: null, challenge: null, forwards: [] })),
    backendClientState: vi.fn(async () => ({ revision: 1, scope: { id: 'scope', environment: { kind: 'local' as const } } })),
    onBackendClientChanged: vi.fn((fn: (state: BackendClientState) => void) => { listener = fn; return vi.fn(); }),
    workspaceProjects: vi.fn(async (scope: string, query: import('@elevenex/shared').WorkspacePageQuery) => { void scope; void query; return ok(page([project])); }),
    workspaceProjectNameAvailability: vi.fn(async (scope: string, name: string) => { void scope; void name; return ok({ available: true }); }),
    workspaceTasks: vi.fn(async (scope: string, query: import('@elevenex/shared').WorkspaceTaskQuery) => { void scope; void query; return ok(page([task])); }),
    workspaceSessions: vi.fn<(scope: string, query: WorkspaceSessionQuery) => Promise<BackendResult<WorkspacePage<WorkspaceSession>>>>(async (_scope, query) => ok(page(query.state === 'archived' ? [] : [session]))),
    workspaceProject: vi.fn(async () => ok(detail)),
    workspaceCreateProject: vi.fn(async () => ok(detail)),
    workspaceFolders: vi.fn(async (): Promise<BackendResult<readonly import('@elevenex/shared').WorkspaceFolder[]>> => ok([])),
    workspaceBranches: vi.fn(async () => ok([{ name: 'main', current: false, isDefault: true, defaultBase: 'main', heldTaskName: null }])),
    workspaceCreateTask: vi.fn(async () => ok({ ...task, state: 'preparing' as const })),
    workspaceTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok(task)),
    workspaceRetryTask: vi.fn<(scope: string, taskId: number, recovery?: WorkspaceTaskRecovery) => Promise<BackendResult<WorkspaceTask>>>(async () => ok(task)),
    workspaceArchiveSession: vi.fn(async (): Promise<BackendResult<{readonly accepted: true}>> => ok({accepted: true})),
    workspaceRestoreSession: vi.fn(async (): Promise<BackendResult<WorkspaceSession>> => ok({...session, status:'stopped'})),
    workspaceCreateSession: vi.fn(async (): Promise<BackendResult<WorkspaceSession>> => ok({ ...session, id: 6 })),
    workspaceSetStage: vi.fn(async () => ok(task)),
    workspaceFinishTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok({ ...task, state: 'finished', archivedAt: 'now' })),
    workspaceReopenTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok(task)),
    workspaceDeleteProject: vi.fn(async (): Promise<BackendResult<{readonly accepted: true}>> => ok({ accepted: true })),
    workspaceRevision: vi.fn(async () => ok({ revision: 1, version: 1 as const, sessionArchive: true as const, ...(history ? { sessionArchiveHistory: true as const } : {}) })),
  } satisfies Pick<ElevenexBridge, 'environmentStatus' | 'saveEnvironmentContext' | 'workspaceProjectNameAvailability' | 'backendClientState' | 'onBackendClientChanged' | 'workspaceProjects' | 'workspaceTasks' | 'workspaceSessions' | 'workspaceProject' | 'workspaceCreateProject' | 'workspaceBranches' | 'workspaceCreateTask' | 'workspaceTask' | 'workspaceCreateSession' | 'workspaceArchiveSession' | 'workspaceRestoreSession' | 'workspaceSetStage' | 'workspaceRevision' | 'workspaceFolders' | 'workspaceRetryTask' | 'workspaceFinishTask' | 'workspaceReopenTask' | 'workspaceDeleteProject'>;
  TestBed.configureTestingModule({ providers: [WorkspaceStore, { provide: ELEVENEX_BRIDGE, useValue: bridge }] });
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
  function saved(bridge: ReturnType<typeof setup>['bridge'], context: Partial<import('@elevenex/shared').EnvironmentContext> = {}) {
    bridge.environmentStatus.mockResolvedValue({ selection: { kind: 'local' }, connection: null, challenge: null, forwards: [], context: {
      projectId: 1, taskId: 3, sessionId: 5, draft: 'keep unsent input', cursor: 'keep event cursor',
      workspace: { panel: 'terminal', panelOpen: true, wideReview: false, closed: false, focused: true, filter: 'review', projectCursor: null, taskCursor: null }, ...context,
    } });
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

  it('resumes a closed task read-only and never reopens it', async () => {
    const { store, bridge, start } = setup(); saved(bridge);
    const finished = { ...task, state: 'finished' as const, archivedAt: 'now' };
    bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.state === 'finished' ? [finished] : [])));
    bridge.workspaceTask.mockResolvedValue(ok(finished));
    await start(); await settle(); TestBed.tick(); await settle();
    expect(store.closed()).toBe(true); expect(store.selected()?.sessionId).toBe(5);
    expect(bridge.workspaceReopenTask).not.toHaveBeenCalled();
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
    expect(store.projects()).toEqual([]); expect(store.panelOpen()).toBe(false);
  });

  it('reports failed saves and retries on the next layout change', async () => {
    const { store, bridge, start } = setup(); await start(); TestBed.tick(); await settle();
    bridge.saveEnvironmentContext.mockRejectedValueOnce(new Error('Disk unavailable'));
    store.panel.set('code'); TestBed.tick(); await settle();
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

  it('retains task disclosures across project navigation and resource mutations, and releases them with the backend scope', async () => {
    const {store,start,emit} = setup(); await start();
    const disclosures = new Map([['3',{taskId:'3',cap:5,hiddenIds:['old']}]]);
    store.sessionDisclosures.set(disclosures);
    await store.selectProject('1'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.selectProject('all'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.createSession('3'); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}}); expect(store.sessionDisclosures()).toBe(disclosures);
    await store.refresh(); expect(store.sessionDisclosures()).toBe(disclosures);
    emit({revision:2,scope:null}); TestBed.tick(); expect(store.sessionDisclosures().size).toBe(0);
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
    expect(store.tasks()[0]?.sessions).toHaveLength(20);
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

  it('preserves definite rejection messages and blocks uncertain mutation replay until reconciliation', async () => {
    const { store, bridge, start } = setup(); await start();
    bridge.workspaceCreateSession.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 409, message: 'Task is preparing.' } });
    await store.createSession('3');
    expect(store.error()).toBe('Task is preparing.'); expect(store.mutationUncertain()).toBe(false);
    bridge.workspaceCreateSession.mockResolvedValueOnce({ ok: false, error: { code: 'outcome-unknown', message: 'Unknown.' } });
    await store.createSession('3');
    await store.createSession('3');
    expect(bridge.workspaceCreateSession).toHaveBeenCalledTimes(2);
    expect(store.mutationUncertain()).toBe(true);
    await store.refresh();
    expect(store.mutationUncertain()).toBe(false);
  });

  it('searches bounded remote branch windows with separate base choices and debounces input', async () => {
    vi.useFakeTimers();
    const { store, bridge, start } = setup(); await start(); await store.openNewTask();
    bridge.workspaceBranches.mockClear();
    store.searchBranches({ repoId: '2', query: 'feature', kind: 'branch' });
    store.searchBranches({ repoId: '2', query: 'feature-299', kind: 'branch' });
    await vi.advanceTimersByTimeAsync(160);
    expect(bridge.workspaceBranches).toHaveBeenCalledTimes(1);
    expect(bridge.workspaceBranches).toHaveBeenCalledWith('scope', { repoId: 2, query: 'feature-299', limit: 50 });
    expect(store.taskRepositories()[0]?.base).toBe('main');
    const branches = store.branchesFor('2');
    store.searchBranches({ repoId: '2', query: 'main', kind: 'base' });
    await vi.advanceTimersByTimeAsync(160);
    expect(store.branchesFor('2')).toBe(branches);
    expect(store.basesFor('2')).toHaveLength(1);
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
  it('rejects late replies and clears Undo when the backend scope changes', async () => {
    const {store,bridge,start,emit} = setup(); await start();
    let complete!: (value: BackendResult<{readonly accepted:true}>)=>void;
    bridge.workspaceArchiveSession.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=store.archiveSession({taskId:'3',session:{id:'5',status:'queued'}});
    emit({revision:2,scope:null}); TestBed.tick(); complete(ok({accepted:true})); await pending;
    expect(store.sessionArchiveUndo()).toBeNull(); expect(store.tasks()).toEqual([]);
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
