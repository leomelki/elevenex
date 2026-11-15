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
    const pending = hierarchy.load(1,1,false,read,()=>true);
    await hierarchy.load(1,1,false,read,()=>true); expect(read).toHaveBeenCalledTimes(1);
    resolve(ok([child],'2')); await pending;
    const earlier = vi.fn(async () => ok([{...child,id:3}],null));
    await hierarchy.load(1,1,true,earlier,()=>true);
    expect(earlier).toHaveBeenCalledWith('2'); expect(hierarchy.windows().get(1)?.sessions.map(row=>row.id)).toEqual([3]);
    await hierarchy.load(1,1,false,async()=>({ok:false,error:{code:'transport',message:'Offline'}}),()=>true);
    expect(hierarchy.windows().get(1)).toMatchObject({sessions:[{id:3}],loading:false,error:'Offline'});
  });
  it('discards reset, stale-navigation and evicted replies', async () => {
    const hierarchy = new WorkspaceSessionHierarchy();
    let resolve!: (value: BackendResult<WorkspacePage<WorkspaceSession>>) => void;
    let current = true;
    const read = () => new Promise<BackendResult<WorkspacePage<WorkspaceSession>>>(done => { resolve = done; });
    const pending = hierarchy.load(1,1,false,read,()=>current);
    current = false; resolve(ok([child])); await pending;
    expect(hierarchy.windows().get(1)).toMatchObject({sessions:[],loading:false});
    current = true;
    const reset = hierarchy.load(1,1,false,read,()=>current); hierarchy.reset(); resolve(ok([child])); await reset;
    expect(hierarchy.windows().size).toBe(0);
    const evicted = hierarchy.load(1,1,false,read,()=>true); hierarchy.retain([]); resolve(ok([child])); await evicted;
    expect(hierarchy.windows().size).toBe(0);
  });
});
