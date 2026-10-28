import type { BackendResult, EnvironmentContext, WorkspacePage, WorkspacePageQuery, WorkspaceProject, WorkspaceSession, WorkspaceSessionQuery, WorkspaceTask, WorkspaceTaskQuery } from '@elevenex/shared';
import { WorkspaceRestoration } from './workspace-restoration';

const project: WorkspaceProject = { id: 1, name: 'Project', agentInstructions: null };
const task: WorkspaceTask = { id: 3, projectId: 1, repoId: 2, name: 'Task', branchName: 'task', stage: 'active', state: 'ready', archivedAt: null, updatedAt: '' };
const session: WorkspaceSession = { id: 5, taskId: 3, repoId: 2, name: 'Session', status: 'created', provider: 'claude', updatedAt: '' };
const saved: EnvironmentContext = { projectId: 1, taskId: 3, sessionId: 5, draft: '', cursor: null };
const page = <T>(items: readonly T[], nextCursor: string | null = null): WorkspacePage<T> => ({ items, nextCursor });
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });

function setup() {
  const bridge = {
    workspaceProjects: vi.fn(async (scope: string, query: WorkspacePageQuery) => { void scope; void query; return ok(page([project])); }),
    workspaceTasks: vi.fn(async (scope: string, query: WorkspaceTaskQuery) => { void scope; void query; return ok(page([task])); }),
    workspaceTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ok(task)),
    workspaceSessions: vi.fn(async (_scope: string, query: WorkspaceSessionQuery): Promise<BackendResult<WorkspacePage<WorkspaceSession>>> => ok(page(query.state === 'archived' ? [] : [session]))),
  };
  return { bridge, restoration: new WorkspaceRestoration(bridge) };
}

it('resolves older project, task and session windows without enumerating history', async () => {
  const { bridge, restoration } = setup();
  const target = { ...saved, projectId: 77 };
  bridge.workspaceProjects.mockImplementation(async (_scope, query) => ok(page(query.cursor === '76' ? [{ ...project, id: 77 }] : [project])));
  bridge.workspaceTasks.mockImplementation(async (_scope, query) => ok(page(query.cursor === '4' ? [{ ...task, projectId: 77 }] : [])));
  bridge.workspaceTask.mockResolvedValue(ok({ ...task, projectId: 77 }));
  bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.cursor === '6' ? [session] : [{ ...session, id: 500 }])));
  expect(await restoration.projects('scope', target, () => true)).toEqual(ok({ page: page([{ ...project, id: 77 }]), cursor: '76' }));
  const result = await restoration.tasks('scope', { saved: target, projectId: 77, archiveHistory: true }, () => true);
  expect(result).toMatchObject({ ok: true, value: { cursor: '4', selection: { taskId: 3, sessionId: 5 }, sessions: { taskId: 3, page: page([session]) } } });
  expect(bridge.workspaceProjects).toHaveBeenCalledTimes(2);
  expect(bridge.workspaceTasks).toHaveBeenCalledTimes(2);
  expect(bridge.workspaceSessions).toHaveBeenCalledTimes(2);
  for (const [, query] of bridge.workspaceTasks.mock.calls) expect(query.limit).toBe(20);
});

it('returns archived pages for their owner to adopt, preserving the normal session window', async () => {
  const { bridge, restoration } = setup();
  const normal = { ...session, id: 20 };
  const archived = { ...session, status: 'archived' };
  bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.state === 'archived' ? [archived] : [normal])));
  const result = await restoration.tasks('scope', { saved, projectId: 1, archiveHistory: true }, () => true);
  expect(result).toMatchObject({ ok: true, value: {
    sessions: { taskId: 3, page: page([normal]) },
    archive: { taskId: 3, cursor: '6', page: page([archived]) }, selection: { taskId: 3, sessionId: 5 },
  } });
});

it('retains archived history when the saved session was deleted from its older window', async () => {
  const { bridge, restoration } = setup();
  const newerArchive = { ...session, id: 20, status: 'archived' };
  bridge.workspaceSessions.mockImplementation(async (_scope, query) => ok(page(query.state === 'archived' && !query.cursor ? [newerArchive] : [])));
  const result = await restoration.tasks('scope', { saved, projectId: 1, archiveHistory: true }, () => true);
  expect(result).toMatchObject({ ok: true, value: { archive: { cursor: undefined, page: page([newerArchive]) } } });
  if (result.ok) expect(result.value.selection).toBeUndefined();
});

it('returns a paused preparation context without preparing or creating a session', async () => {
  const { bridge, restoration } = setup();
  const preparing = { ...task, state: 'preparing' as const };
  bridge.workspaceTasks.mockResolvedValue(ok(page([preparing])));
  const result = await restoration.tasks('scope', { saved: { ...saved, sessionId: null }, projectId: 1, archiveHistory: false }, () => true);
  expect(result).toMatchObject({ ok: true, value: { pendingTask: preparing } });
  expect(bridge.workspaceSessions).not.toHaveBeenCalled();
});

it('does not dispatch reads after cancellation and stops follow-up reads after a late result', async () => {
  const { bridge, restoration } = setup();
  expect(await restoration.projects('scope', saved, () => false)).toMatchObject({ ok: false, error: { code: 'stale-scope' } });
  expect(bridge.workspaceProjects).not.toHaveBeenCalled();
  let active = true;
  let complete!: (value: BackendResult<WorkspaceTask>) => void;
  bridge.workspaceTasks.mockResolvedValue(ok(page([])));
  bridge.workspaceTask.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const pending = restoration.tasks('scope', { saved, projectId: 1, archiveHistory: false }, () => active);
  await vi.waitFor(() => expect(bridge.workspaceTask).toHaveBeenCalled());
  active = false; complete(ok(task));
  expect(await pending).toMatchObject({ ok: false, error: { code: 'stale-scope' } });
  expect(bridge.workspaceTasks).toHaveBeenCalledTimes(1);
  expect(bridge.workspaceSessions).not.toHaveBeenCalled();
});

it('distinguishes deleted tasks from transient read failures', async () => {
  const { bridge, restoration } = setup();
  bridge.workspaceTasks.mockResolvedValue(ok(page([])));
  bridge.workspaceTask.mockResolvedValueOnce({ ok: false, error: { code: 'http', status: 404, message: 'Missing' } });
  expect(await restoration.tasks('scope', { saved, projectId: 1, archiveHistory: false }, () => true)).toEqual(ok({ page: page([]), cursor: undefined, closed: false }));
  bridge.workspaceTask.mockRejectedValueOnce(new Error('Connection closed'));
  expect(await restoration.tasks('scope', { saved, projectId: 1, archiveHistory: false }, () => true)).toMatchObject({ ok: false, error: { code: 'transport' } });
});
