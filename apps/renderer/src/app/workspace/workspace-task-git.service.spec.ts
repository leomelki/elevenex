import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendResult, ElevenexBridge, WorkspaceCommitPreview, WorkspaceGitSummary } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';
import type { WorkspaceSelection } from './workspace.models';

const summary: WorkspaceGitSummary = { taskId: 1, branch: 'work', upstream: null, ahead: 0, behind: 0, files: 2, additions: 5, deletions: 1, conflicted: false, changesRevision: 'a'.repeat(64) };
const defaultQuery = { taskId: 1, query: '', includeUnstaged: true, excluded: [], includedSecrets: [] };
const ok = (value: WorkspaceGitSummary): BackendResult<WorkspaceGitSummary> => ({ ok: true, value });
const preview: WorkspaceCommitPreview = { taskId: 1, revision: 'revision', items: [{ path: 'app.ts', status: 'M', add: 5, del: 1, staged: false }], nextCursor: null, total: 2, matches: 2, unstaged: 2, selected: { files: 2, add: 5, del: 1, staged: 0, unstaged: 2 }, running: [], runningCount: 0 };
async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function setup() {
  const selected = signal<WorkspaceSelection | null>({ scopeId: 'scope', taskId: 1, sessionId: 2 });
  const store = { selected, selectedTask: () => ({ state: 'ready', archivedAt: null }), commitPanelAvailable: signal(true), reconcileTaskBranch: vi.fn() };
  const bridge = { workspaceGit: vi.fn(async () => ok(summary)), workspaceGitAction: vi.fn(async () => ok(summary)), workspaceCommitPreview: vi.fn(async (): Promise<BackendResult<WorkspaceCommitPreview>> => ({ ok: true, value: preview })) } satisfies Pick<ElevenexBridge, 'workspaceGit' | 'workspaceGitAction' | 'workspaceCommitPreview'>;
  TestBed.configureTestingModule({ providers: [WorkspaceTaskGitService, { provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: bridge }, { provide: BackendClientService, useValue: { state: signal({ revision: 1, scope: { id: 'scope', environment: { kind: 'local' } } }) } }] });
  const git = TestBed.inject(WorkspaceTaskGitService); TestBed.tick();
  return { git, bridge, store, selected };
}
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('WorkspaceTaskGitService', () => {
  it('preloads once and skips unchanged polls, including upstream-only updates', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    expect(git.commitPreview()).toEqual(preview);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledExactlyOnceWith('scope', defaultQuery);
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, behind: 20 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(1);
    TestBed.resetTestingModule(); await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(1);
  });

  it('reloads after a local version change even when all counts are identical', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'b'.repeat(64) }));
    await git.refresh(); await settle();
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(2);
  });

  it('reuses recent default pages and shares expired revalidation with an opening panel', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    expect(await git.readCommitPreview('scope', defaultQuery)).toEqual(preview);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    let resolve!: (value: BackendResult<WorkspaceCommitPreview>) => void;
    bridge.workspaceCommitPreview.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const first = git.readCommitPreview('scope', defaultQuery);
    const second = git.readCommitPreview('scope', defaultQuery);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(2);
    resolve({ ok: true, value: { ...preview, revision: 'fresh' } });
    expect((await first).revision).toBe('fresh'); expect((await second).revision).toBe('fresh');
    await git.readCommitPreview('scope', { ...defaultQuery, query: 'app' });
    await git.readCommitPreview('scope', { ...defaultQuery, excluded: ['app.ts'] });
    await git.readCommitPreview('scope', { ...defaultQuery, cursor: '100' });
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(5);
    expect(git.commitPreview()?.revision).toBe('fresh');
  });

  it('retains bounded periodic refreshes for engines without a change token', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { bridge } = setup(); await settle();
    bridge.workspaceGit.mockResolvedValue(ok({ ...summary, changesRevision: undefined }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(3);
  });

  it('rejects an older pending page when a newer local revision is observed in the same task', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    let resolve!: (value: BackendResult<WorkspaceCommitPreview>) => void;
    bridge.workspaceCommitPreview.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'b'.repeat(64) }));
    await git.refresh();
    const rejected = expect(git.readCommitPreview('scope', defaultQuery)).rejects.toThrow('moved on');
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'c'.repeat(64) }));
    bridge.workspaceCommitPreview.mockResolvedValueOnce({ ok: true, value: { ...preview, revision: 'current' } });
    await git.refresh(); await settle();
    resolve({ ok: true, value: { ...preview, revision: 'old' } }); await rejected;
    expect(git.commitPreview()?.revision).toBe('current');
  });

  it('skips preloading for hidden windows, clean tasks and unsupported engines', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { git, bridge, store } = setup(); await settle();
    expect(bridge.workspaceCommitPreview).not.toHaveBeenCalled();
    hidden.mockReturnValue(false); store.commitPanelAvailable.set(false);
    await git.refresh();
    expect(bridge.workspaceCommitPreview).not.toHaveBeenCalled();
    store.commitPanelAvailable.set(true); bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, files: 0 }));
    await git.refresh();
    expect(bridge.workspaceCommitPreview).not.toHaveBeenCalled();
    expect(git.commitPreview()).toBeNull();
  });

  it('discards a pending preload across navigation away and back to the same task', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge, selected } = setup(); await settle();
    let resolve!: (value: BackendResult<WorkspaceCommitPreview>) => void;
    bridge.workspaceCommitPreview.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'b'.repeat(64) }));
    await git.refresh();
    selected.set(null); TestBed.tick();
    expect(git.commitPreview()).toBeNull();
    selected.set({ scopeId: 'scope', taskId: 1, sessionId: 2 }); TestBed.tick(); await settle();
    resolve({ ok: true, value: { ...preview, revision: 'old' } }); await settle();
    expect(git.commitPreview()?.revision).toBe('revision');
  });

  it('drops preloaded files during mutations and ignores a preload finishing after teardown', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    const action = git.perform({ type: 'commit', message: 'Commit changes' });
    expect(git.commitPreview()).toBeNull();
    await action; await settle();
    expect(git.commitPreview()).toEqual(preview);
    let resolve!: (value: BackendResult<WorkspaceCommitPreview>) => void;
    bridge.workspaceCommitPreview.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'b'.repeat(64) }));
    await git.refresh(); TestBed.resetTestingModule();
    resolve({ ok: true, value: { ...preview, revision: 'late' } }); await settle();
    expect(git.commitPreview()).toBeNull();
  });

  it('keeps preload errors silent so the panel can perform its own check', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    bridge.workspaceCommitPreview.mockRejectedValueOnce(new Error('Unavailable'));
    bridge.workspaceGit.mockResolvedValueOnce(ok({ ...summary, changesRevision: 'b'.repeat(64) }));
    await git.refresh(); await settle();
    expect(git.commitPreview()).toEqual(preview); expect(git.error()).toBeNull();
    await expect(git.readCommitPreview('scope', defaultQuery)).resolves.toEqual(preview);
    expect(bridge.workspaceCommitPreview).toHaveBeenCalledTimes(3);
  });

  it('polls only the selected visible task and releases its timer on teardown', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const { git, bridge } = setup(); await settle();
    expect(git.state()).toMatchObject({ files: 2, add: 5, del: 1 });
    await vi.advanceTimersByTimeAsync(5000); expect(bridge.workspaceGit).toHaveBeenCalledTimes(2);
    TestBed.resetTestingModule(); await vi.advanceTimersByTimeAsync(10000);
    expect(bridge.workspaceGit).toHaveBeenCalledTimes(2);
  });

  it('rejects an old mutation after navigating away and returning to the same task', async () => {
    const { git, bridge, store, selected } = setup(); await settle();
    let resolve!: (value: BackendResult<WorkspaceGitSummary>) => void;
    bridge.workspaceGitAction.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const operation = git.perform({ type: 'rename-branch', branchName: 'old' });
    selected.set(null); TestBed.tick();
    selected.set({ scopeId: 'scope', taskId: 1, sessionId: 2 }); TestBed.tick(); await settle();
    resolve(ok({ ...summary, branch: 'old' }));
    expect(await operation).toBe(false);
    expect(git.summary()?.branch).toBe('work');
    expect(store.reconcileTaskBranch).not.toHaveBeenCalled();
  });
});
