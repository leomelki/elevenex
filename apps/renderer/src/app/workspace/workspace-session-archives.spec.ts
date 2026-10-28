import { describe, expect, it, vi } from 'vitest';
import type { BackendResult, WorkspacePage, WorkspaceSession } from '@elevenex/shared';
import { WorkspaceSessionArchives } from './workspace-session-archives';

const session: WorkspaceSession = { id: 21, taskId: 1, repoId: 1, name: 'Saved conversation', provider: 'codex', status: 'archived', updatedAt: '' };
const ok = (items: readonly WorkspaceSession[], nextCursor: string | null = null): BackendResult<WorkspacePage<WorkspaceSession>> => ({ ok: true, value: { items, nextCursor } });

describe('scoped archived session windows', () => {
  it('adopts a restored page only for an owned task and ignores earlier in-flight replies', async () => {
    let complete!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const bridge = { workspaceSessions: vi.fn(() => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(resolve => { complete = resolve; })) };
    const archives = new WorkspaceSessionArchives(bridge, scope => scope === 'scope');
    const restored = { items: [session], nextCursor: '20' };
    archives.acceptRestoredWindow('scope', 1, restored, '22');
    expect(archives.pages().size).toBe(0);
    archives.retain([1]);
    archives.acceptRestoredWindow('old-scope', 1, restored, '22');
    expect(archives.pages().size).toBe(0);
    const pending = archives.load('scope', 1);
    archives.acceptRestoredWindow('scope', 1, restored, '22');
    complete(ok([])); await pending;
    expect(archives.pages().get(1)).toMatchObject({ sessions: [session], cursor: '22', loaded: true, nextCursor: '20' });
    archives.reset();
    archives.acceptRestoredWindow('scope', 1, restored, '22');
    expect(archives.pages().size).toBe(0);
  });
  it('probes one row before opening history and reconciles an empty older window against the latest page', async () => {
    const bridge = { workspaceSessions: vi.fn()
      .mockResolvedValueOnce(ok([session], '21'))
      .mockResolvedValueOnce(ok([session], '21'))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([])) };
    const archives = new WorkspaceSessionArchives(bridge, () => true);
    archives.retain([1]);
    await archives.refresh('scope', 1);
    expect(bridge.workspaceSessions).toHaveBeenLastCalledWith('scope', { taskId: 1, state: 'archived', order: 'latest', limit: 1 });
    expect(archives.pages().get(1)?.loaded).toBe(false);
    await archives.load('scope', 1);
    expect(bridge.workspaceSessions).toHaveBeenLastCalledWith('scope', { taskId: 1, state: 'archived', order: 'latest', limit: 20 });
    await archives.load('scope', 1, 'earlier');
    expect(bridge.workspaceSessions).toHaveBeenCalledTimes(4);
    expect(archives.pages().get(1)).toMatchObject({ sessions: [], loaded: true, cursor: null, nextCursor: null });
  });

  it('coalesces reads, replaces bounded pages and rejects scope/task replies after cleanup', async () => {
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const bridge = { workspaceSessions: vi.fn(() => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; })) };
    const archives = new WorkspaceSessionArchives(bridge, scope => scope === 'scope');
    archives.retain([1]);
    const first = archives.load('scope', 1);
    await archives.load('scope', 1);
    expect(bridge.workspaceSessions).toHaveBeenCalledTimes(1);
    resolve(ok([session], '21')); await first;
    const earlier = archives.load('scope', 1, 'earlier');
    expect(bridge.workspaceSessions).toHaveBeenLastCalledWith('scope', { taskId: 1, state: 'archived', order: 'latest', limit: 20, cursor: '21' });
    resolve(ok([{ ...session, id: 1 }])); await earlier;
    expect(archives.pages().get(1)?.sessions.map(row => row.id)).toEqual([1]);
    const removed = archives.load('scope', 1);
    archives.retain([]); resolve(ok([session])); await removed;
    expect(archives.pages().size).toBe(0);
    archives.retain([1]); const stale = archives.load('scope', 1);
    archives.reset(); resolve(ok([session])); await stale;
    expect(archives.pages().size).toBe(0);
  });

  it('keeps failed history retryable and waits out pre-mutation reads before reconciling', async () => {
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const bridge = { workspaceSessions: vi.fn(() => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; })) };
    const archives = new WorkspaceSessionArchives(bridge, () => true);
    archives.retain([1]);
    const failed = archives.load('scope', 1);
    resolve({ ok: false, error: { code: 'transport', message: 'Offline' } }); await failed;
    expect(archives.pages().get(1)).toMatchObject({ loading: false, loaded: false, error: 'Offline' });
    const retry = archives.load('scope', 1);
    const reconcile = archives.changed('scope', 1, session.id);
    expect(bridge.workspaceSessions).toHaveBeenCalledTimes(2);
    resolve(ok([session])); await retry;
    expect(archives.pages().get(1)?.sessions).toEqual([]);
    resolve(ok([])); await reconcile;
    expect(archives.pages().get(1)).toMatchObject({ loaded: true, loading: false, error: null, sessions: [] });
  });
});
