import { TestBed } from '@angular/core/testing';
import type { BackendResult, CodeSurfaceState, CodeTarget, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { CodeWorkspaceStore } from './code-workspace.store';
const target = { scopeId: 'old', taskId: 1 };
const state: CodeSurfaceState = { identity: 'a'.repeat(64), taskId: 1, phase: 'ready', message: 'Task connected' };
describe('task-owned Code state', () => {
  afterEach(() => TestBed.resetTestingModule());
  function setup() {
    let resolve!: (value: BackendResult<CodeSurfaceState>) => void;
    let event!: (value: { target: CodeTarget; state: CodeSurfaceState }) => void;
    const stop = vi.fn(), release = vi.fn().mockResolvedValue(undefined);
    const bridge = { onCodeChanged: vi.fn(fn => { event = fn; return stop; }), codeOpen: vi.fn(() => new Promise<BackendResult<CodeSurfaceState>>(done => { resolve = done; })), codeRecover: vi.fn().mockRejectedValue(new Error('Disconnected')), codeRelease: release, codeOpenFile: vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }) };
    TestBed.configureTestingModule({ providers: [CodeWorkspaceStore, { provide: ELEVENEX_BRIDGE, useValue: bridge satisfies Partial<ElevenexBridge> }] });
    return { store: TestBed.inject(CodeWorkspaceStore), bridge, resolve: (value: BackendResult<CodeSurfaceState>) => resolve(value), emit: (value: { target: CodeTarget; state: CodeSurfaceState }) => event(value), stop };
  }
  it('shares startup, retains task ownership across conversations, and drops late results after task switch', async () => {
    const fixture = setup(); fixture.store.select(target);
    const first = fixture.store.open(), second = fixture.store.open(); expect(first).toBe(second); expect(fixture.bridge.codeOpen).toHaveBeenCalledOnce();
    fixture.store.select({ ...target }); expect(fixture.bridge.codeRelease).not.toHaveBeenCalled();
    fixture.store.select({ scopeId: 'new', taskId: 2 }); fixture.resolve({ ok: true, value: state }); await first;
    expect(fixture.store.state()).toBeNull(); expect(fixture.bridge.codeRelease).toHaveBeenCalledExactlyOnceWith(target);
    fixture.emit({ target, state }); expect(fixture.store.state()).toBeNull();
  });
  it('never dispatches a file-opening intent after its original task changes, and cleans up its subscription', async () => {
    const fixture = setup(); fixture.store.select(target);
    const pending = fixture.store.openFile({ path: 'a.ts', line: 3 });
    fixture.store.select({ scopeId: 'other-backend', taskId: 1 }); fixture.resolve({ ok: true, value: state }); await pending;
    expect(fixture.bridge.codeOpenFile).not.toHaveBeenCalled();
    TestBed.resetTestingModule(); expect(fixture.stop).toHaveBeenCalledOnce();
  });
  it('retains the editor and reports a failed recovery without an unhandled rejection', async () => {
    const fixture = setup(); fixture.store.select(target); fixture.store.adopt(state);
    await fixture.store.recover(); expect(fixture.store.state()).toEqual(state); expect(fixture.store.error()).toContain('could not reconnect');
    const pending = fixture.store.recover(); fixture.store.select({ scopeId: 'new', taskId: 2 }); await pending;
    expect(fixture.store.error()).toBe(''); expect(fixture.store.state()).toBeNull();
  });
});
