import { describe, expect, it, vi } from 'vitest';
import type { BackendResult, WorkspaceSession } from '@elevenex/shared';
import { WorkspaceSessionCreation } from './workspace-session-creation';

const session: WorkspaceSession = { id: 20, taskId: 1, repoId: 2, name: 'Explore', provider: 'codex', status: 'created', updatedAt: '' };
function setup() {
  let finish!: (reply: BackendResult<WorkspaceSession>) => void;
  const bridge = { workspaceCreateSession: vi.fn(() => new Promise<BackendResult<WorkspaceSession>>(resolve => { finish = resolve; })) };
  const created = vi.fn();
  const valid = vi.fn(() => true);
  const creation = new WorkspaceSessionCreation(bridge, valid, created);
  return { creation, bridge, created, valid, finish: (reply: BackendResult<WorkspaceSession>) => finish(reply) };
}

describe('workspace session creation ownership', () => {
  it('bounds local drafts and coalesces dispatches without blocking another task', async () => {
    const { creation, bridge, finish } = setup();
    const first = creation.start('scope', 1)!;
    expect(creation.start('scope', 1)).toBe(first);
    const sent = creation.send(first.id); await creation.send(first.id);
    expect(bridge.workspaceCreateSession).toHaveBeenCalledExactlyOnceWith('scope', { taskId: 1 });
    for (let task = 2; task <= 10; task++) expect(creation.start('scope', task)).not.toBeNull();
    expect(creation.start('scope', 11)).toBeNull();
    creation.discard(first.id); expect(creation.items()).toHaveLength(10);
    finish({ ok: true, value: session }); await sent;
    expect(creation.start('scope', 11)).not.toBeNull();
  });

  it('does not adopt a late reply after disposal', async () => {
    const { creation, created, finish } = setup();
    const first = creation.start('scope', 1)!;
    const sent = creation.send(first.id); creation.dispose();
    finish({ ok: true, value: session }); await sent;
    expect(created).not.toHaveBeenCalled(); expect(creation.items()).toEqual([]);
    expect(creation.start('scope', 1)).toBeNull();
  });

  it('retains writing across same-machine recovery without replaying or adopting an old reply', async () => {
    const { creation, created, bridge, finish } = setup();
    const first = creation.start('old', 1)!; first.draft.text.set('Keep this across recovery');
    const sent = creation.send(first.id); creation.rebind('old', 'new');
    finish({ ok: true, value: session }); await sent;
    expect(creation.items()[0]).toMatchObject({ scopeId: 'new', status: 'unknown', draft: first.draft });
    expect(created).not.toHaveBeenCalled();
    await creation.retry(first.id); await creation.send(first.id);
    expect(bridge.workspaceCreateSession).toHaveBeenCalledTimes(1);
    expect(creation.items()[0]!.draft.text()).toBe('Keep this across recovery');
  });

  it('treats a lost connection as uncertain and retains the draft until explicit dismissal', async () => {
    const { creation, valid, created, finish } = setup();
    const first = creation.start('scope', 1)!;
    const sent = creation.send(first.id); valid.mockReturnValue(false);
    finish({ ok: true, value: session }); await sent;
    expect(created).not.toHaveBeenCalled(); expect(creation.items()[0]!.status).toBe('unknown');
    creation.discard(first.id); expect(creation.items()).toEqual([]);
  });
});
