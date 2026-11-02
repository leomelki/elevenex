import type { BackendResult, WorkspaceSession, WorkspaceTask } from '@elevenex/shared';
import { WorkspaceSessionOutbox } from './workspace-session-outbox';
const task: WorkspaceTask = { id: 1, projectId: 1, repoId: 1, name: 'Task', branchName: 'task', stage: 'active', state: 'ready', archivedAt: null, updatedAt: '' };
const ok = <T>(value: T): BackendResult<T> => ({ ok: true, value });
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
describe('New sessions while disconnected', () => {
  it('checks the existing task before first dispatch and never retries an unknown create', async () => {
    const bridge = { workspaceTask: vi.fn(async () => ok(task)), workspaceCreateSession: vi.fn(async (): Promise<BackendResult<WorkspaceSession>> => ({ ok: false, error: { code: 'outcome-unknown', message: 'Unconfirmed' } })) };
    const box = new WorkspaceSessionOutbox(bridge, () => true, async () => undefined);
    box.enqueue(1, 'Task'); expect(bridge.workspaceCreateSession).not.toHaveBeenCalled(); box.connect('one'); await settle();
    expect(bridge.workspaceCreateSession).toHaveBeenCalledExactlyOnceWith('one', { taskId: 1 });
    box.connect(null); box.connect('two'); await settle(); expect(bridge.workspaceCreateSession).toHaveBeenCalledOnce(); expect(box.items()[0]?.status).toBe('unknown'); box.dispose();
  });
  it('does not create a conversation in a task closed during the outage', async () => {
    const bridge = { workspaceTask: vi.fn(async () => ok({ ...task, state: 'finished' as const })), workspaceCreateSession: vi.fn(async () => ok({ id: 2, taskId: 1, repoId: 1, name: 'New', provider: 'codex', status: 'created', updatedAt: '' })) };
    const box = new WorkspaceSessionOutbox(bridge, () => true, async () => undefined); box.enqueue(1, 'Task'); box.connect('one'); await settle();
    expect(bridge.workspaceCreateSession).not.toHaveBeenCalled(); expect(box.items()[0]?.error).toContain('Nothing was sent'); box.dispose();
  });
});
