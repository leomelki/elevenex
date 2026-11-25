import { describe, expect, it, vi } from 'vitest';
import type { BackendResult, WorkspacePage, WorkspaceSession } from '@elevenex/shared';
import { WorkspaceSessionHierarchy } from './workspace-session-hierarchy';
const root: WorkspaceSession = { id:1,taskId:1,repoId:1,name:'Plan',status:'done',provider:'codex',updatedAt:'' };
const child = { ...root,id:2,parentSessionId:1 };
const ok = (items: readonly WorkspaceSession[], nextCursor: string | null = null): BackendResult<WorkspacePage<WorkspaceSession>> => ({ok:true,value:{items,nextCursor}});
describe('bounded child windows', () => {
  it('coalesces pending reads, replaces pages and preserves a loaded page on failure', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const read = vi.fn(() => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; }));
    const pending = hierarchy.load(1,1,'latest',read,()=>true);
    await hierarchy.load(1,1,'latest',read,()=>true); expect(read).toHaveBeenCalledTimes(1);
    resolve(ok([child],'2')); await pending;
    const earlier = vi.fn(async () => ok([{...child,id:3}],null));
    await hierarchy.load(1,1,'earlier',earlier,()=>true);
    expect(earlier).toHaveBeenCalledWith('2'); expect(hierarchy.windows().get(1)?.sessions.map(row=>row.id)).toEqual([3]);
    await hierarchy.load(1,1,'latest',async()=>({ok:false,error:{code:'transport',message:'Offline'}}),()=>true);
    expect(hierarchy.windows().get(1)).toMatchObject({sessions:[{id:3}],loading:false,error:'Offline'});
  });
  it('discards reset, stale-navigation and evicted replies', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    let current = true;
    const read = () => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; });
    const pending = hierarchy.load(1,1,'latest',read,()=>current);
    current = false; resolve(ok([child])); await pending;
    expect(hierarchy.windows().get(1)).toMatchObject({sessions:[],loading:false});
    current = true;
    const reset = hierarchy.load(1,1,'latest',read,()=>current); hierarchy.reset(); resolve(ok([child])); await reset;
    expect(hierarchy.windows().size).toBe(0);
    const evicted = hierarchy.load(1,1,'latest',read,()=>true); hierarchy.retain([]); resolve(ok([child])); await evicted;
    expect(hierarchy.windows().size).toBe(0);
  });
});

describe('child page revalidation', () => {
  it('keeps the published older page through a slow or failed refresh and reuses its cursor on success', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    await hierarchy.load(1, 1, 'latest', async () => ok([child], '0:2'), () => true);
    const older = { ...child, id: 1 };
    await hierarchy.load(1, 1, 'earlier', async () => ok([older]), () => true);
    const before = hierarchy.windows();
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const read = vi.fn<(cursor?: string) => Promise<BackendResult<WorkspacePage<WorkspaceSession>>>>(() => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; }));
    const failed = hierarchy.load(1, 1, 'refresh', read, () => true);
    expect(hierarchy.windows()).toBe(before);
    resolve({ ok: false, error: { code: 'transport', message: 'Offline' } });
    await failed;
    expect(hierarchy.windows()).toBe(before);
    const updated = { ...older, name: 'Updated' };
    const recovered = hierarchy.load(1, 1, 'refresh', read, () => true);
    resolve(ok([updated]));
    await recovered;
    expect(read.mock.calls).toEqual([['0:2'], ['0:2']]);
    expect(hierarchy.windows().get(1)).toMatchObject({ cursor: '0:2', sessions: [updated], loading: false, error: null });
  });

  it('coalesces revisions arriving during a refresh into one follow-up read', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    await hierarchy.load(1, 1, 'latest', async () => ok([child]), () => true);
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const initial = hierarchy.load(1, 1, 'refresh', () => new Promise(done => { resolve = done; }), () => true);
    const superseded = vi.fn(async () => ok([child]));
    const updated = { ...child, name: 'Latest revision' };
    const latest = vi.fn(async () => ok([updated]));
    await hierarchy.load(1, 1, 'refresh', superseded, () => true);
    await hierarchy.load(1, 1, 'refresh', latest, () => true);
    expect(latest).not.toHaveBeenCalled();
    resolve(ok([child])); await initial;
    expect(superseded).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(hierarchy.windows().get(1)?.sessions).toEqual([updated]);
  });

  it('lets an explicit page change supersede an in-flight refresh', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    await hierarchy.load(1, 1, 'latest', async () => ok([child], '0:2'), () => true);
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    const refresh = hierarchy.load(1, 1, 'refresh', () => new Promise(done => { resolve = done; }), () => true);
    const older = { ...child, id: 1 };
    await hierarchy.load(1, 1, 'earlier', async () => ok([older]), () => true);
    resolve(ok([child])); await refresh;
    expect(hierarchy.windows().get(1)).toMatchObject({ cursor: '0:2', sessions: [older], loading: false });
  });
});
