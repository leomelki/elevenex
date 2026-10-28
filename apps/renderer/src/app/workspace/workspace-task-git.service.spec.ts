import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendResult, ElevenexBridge, WorkspaceGitSummary } from '@elevenex/shared';
import { BackendClientService, ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { WorkspaceStore } from './workspace.store';
import { WorkspaceTaskGitService } from './workspace-task-git.service';
import type { WorkspaceSelection } from './workspace.models';

const summary: WorkspaceGitSummary = { taskId: 1, branch: 'work', upstream: null, ahead: 0, behind: 0, files: 2, additions: 5, deletions: 1, conflicted: false };
const ok = (value: WorkspaceGitSummary): BackendResult<WorkspaceGitSummary> => ({ ok: true, value });
async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function setup() {
  const selected = signal<WorkspaceSelection | null>({ scopeId: 'scope', taskId: 1, sessionId: 2 });
  const store = { selected, selectedTask: () => ({ state: 'ready', archivedAt: null }), reconcileTaskBranch: vi.fn() };
  const bridge = { workspaceGit: vi.fn(async () => ok(summary)), workspaceGitAction: vi.fn(async () => ok(summary)) } satisfies Pick<ElevenexBridge, 'workspaceGit' | 'workspaceGitAction'>;
  TestBed.configureTestingModule({ providers: [WorkspaceTaskGitService, { provide: WorkspaceStore, useValue: store }, { provide: ELEVENEX_BRIDGE, useValue: bridge }, { provide: BackendClientService, useValue: { state: signal({ revision: 1, scope: { id: 'scope', environment: { kind: 'local' } } }) } }] });
  const git = TestBed.inject(WorkspaceTaskGitService); TestBed.tick();
  return { git, bridge, store, selected };
}
afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('WorkspaceTaskGitService', () => {
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
