import type { BackendResult, WorkspaceProjectDetail, WorkspaceTask } from '@elevenex/shared';
import { WorkspaceTaskOutbox } from './workspace-task-outbox';
const task: WorkspaceTask = { id: 3, projectId: 1, repoId: 2, name: 'task', branchName: 'task', stage: 'active', state: 'preparing', archivedAt: null, updatedAt: '' };
const detail: WorkspaceProjectDetail = { project: { id: 1, name: 'Project', agentInstructions: null }, repositories: { items: [{ id: 2, projectId: 1, name: 'repo', path: '/repo', defaultBase: 'main' }], nextCursor: null } };
const input = { id: 'stable-request', repoId: 2, projectId: 1, planned: false, draft: { title: 'task', repo: '2', branch: 'task', existing: false, workspace: 'auto', base: 'main' } };
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve(); }
describe('Waiting task creation', () => {
  it('claims a request once, keeps its identity, and never retries a dispatched unknown create', async () => {
    const bridge = { workspaceProject: vi.fn(async () => ok(detail)), workspaceCreateTask: vi.fn(async (): Promise<BackendResult<WorkspaceTask>> => ({ ok: false, error: { code: 'outcome-unknown', message: 'Unconfirmed' } })), workspaceSetStage: vi.fn(async () => ok(task)) };
    const box = new WorkspaceTaskOutbox(bridge, () => true, async () => undefined);
    expect(box.enqueue(input)).toBe(true); expect(box.enqueue(input)).toBe(false);
    box.connect('one'); box.connect('one'); await settle();
    expect(bridge.workspaceCreateTask).toHaveBeenCalledExactlyOnceWith('one', expect.objectContaining({ requestId: 'stable-request' }));
    box.connect(null); box.connect('two'); await settle();
    expect(bridge.workspaceCreateTask).toHaveBeenCalledTimes(1); expect(box.items()[0]?.status).toBe('unknown'); box.dispose();
  });
  it('reads the original project and respects cancellation while checking its repository', async () => {
    let resolve!: (value: BackendResult<WorkspaceProjectDetail>) => void;
    const bridge = { workspaceProject: vi.fn(() => new Promise<BackendResult<WorkspaceProjectDetail>>(done => { resolve = done; })), workspaceCreateTask: vi.fn(async () => ok(task)), workspaceSetStage: vi.fn(async () => ok(task)) };
    const box = new WorkspaceTaskOutbox(bridge, () => true, async () => undefined);
    box.enqueue(input); box.connect('one'); box.remove(input.id); resolve(ok(detail)); await settle();
    expect(bridge.workspaceProject).toHaveBeenCalledExactlyOnceWith('one', 1); expect(bridge.workspaceCreateTask).not.toHaveBeenCalled(); box.dispose();
  });
  it('dispatches the saved edit when it changes during repository validation', async () => {
    let resolve!: (value: BackendResult<WorkspaceProjectDetail>) => void;
    const bridge = { workspaceProject: vi.fn(() => new Promise<BackendResult<WorkspaceProjectDetail>>(done => { resolve = done; })), workspaceCreateTask: vi.fn(async () => ok(task)), workspaceSetStage: vi.fn(async () => ok(task)) };
    const box = new WorkspaceTaskOutbox(bridge, () => true, async () => undefined);
    box.enqueue(input); box.connect('one'); const original = box.take(input.id)!;
    box.enqueue({ ...original, draft: { ...original.draft, title: 'Edited', branch: 'edited' } });
    resolve(ok(detail)); await settle();
    expect(bridge.workspaceCreateTask).toHaveBeenCalledExactlyOnceWith('one', expect.objectContaining({ requestId: input.id, name: 'Edited', branchName: 'edited' })); box.dispose();
  });

});
