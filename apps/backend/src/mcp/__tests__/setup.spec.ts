import { ConflictException } from '@nestjs/common';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { ToolError } from '../tool-registry/tool.types.js';
import { findOrCreateProjectTool } from '../tools/setup/find-or-create-project.tool.js';
import { addRepoTool } from '../tools/setup/add-repo.tool.js';
import { removeRepoTool } from '../tools/setup/remove-repo.tool.js';
import { assessWorktreePoolTool } from '../tools/setup/assess-worktree-pool.tool.js';
import { createWorktreeTool } from '../tools/setup/create-worktree.tool.js';
import { deleteWorktreeTool } from '../tools/setup/delete-worktree.tool.js';
import { getWorktreeJobTool } from '../tools/setup/get-worktree-job.tool.js';
import { linkWorktreeTool } from '../tools/setup/link-worktree.tool.js';
import { stealWorktreeTool } from '../tools/setup/steal-worktree.tool.js';
import { createSessionTool } from '../tools/setup/create-session.tool.js';
import { generateWorktreeContextTool } from '../tools/setup/generate-worktree-context.tool.js';
import { setTodoTool } from '../tools/setup/set-todo.tool.js';
import { setScratchpadTool } from '../tools/setup/set-scratchpad.tool.js';
import { SETUP_TOOLS } from '../tools/setup/index.js';

function makeCtx(services: any): ToolContext {
  return {
    services,
    agentSessionId: 42,
    caps: {
      isAgent: true,
      canMutate: true,
      canDestroy: true,
      canUseHumanChannel: true,
    },
    cursors: new DeltaCursorStore(),
    deepLink: new DeepLinkBuilder(),
    human: {} as any,
    signal: new AbortController().signal,
    mcpSessionId: 't',
  } as any;
}

/** A WorktreePoolItem double with sensible defaults. */
function poolItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    repoRootPath: '/repo',
    path: '/repo/.worktrees/wt1',
    name: 'wt1',
    createdFromRef: 'main',
    currentBranch: 'feature/a',
    head: 'abc',
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockReason: null,
    isMissing: false,
    isDirty: false,
    hasConflicts: false,
    runningAgentCount: 0,
    activeSessionCount: 0,
    lastUsedAt: null,
    lastSessionActivityAt: null,
    owner: null,
    projectWorkspace: null,
    ...overrides,
  };
}

/** A worktreePool mock that streams no items (empty pool). */
function emptyPool() {
  return { streamForRepo: jest.fn(async () => 0) };
}

describe('setup tool group', () => {
  it('registers all 16 setup tools', () => {
    expect(SETUP_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'add_repo',
        'assess_worktree_pool',
        'create_session',
        'create_worktree',
        'delete_project',
        'delete_worktree',
        'find_or_create_project',
        'generate_worktree_context',
        'get_worktree_job',
        'link_worktree',
        'remove_repo',
        'rename_worktree',
        'set_scratchpad',
        'set_todo',
        'steal_worktree',
        'switch_branch',
      ].sort(),
    );
    expect(stealWorktreeTool.destructive).toBe(true);
    expect(deleteWorktreeTool.destructive).toBe(true);
  });

  describe('create_session', () => {
    it('creates a session from a workspaceId and returns a handle', async () => {
      const create = jest.fn().mockResolvedValue({
        id: 55,
        name: 'Session 1',
        repoId: 5,
        branchName: 'feat/x',
        worktreePath: '/wt/x',
        status: 'created',
        activeAgentProvider: 'claude',
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 5, path: '/repos/api' }) },
        sessions: { create },
      });

      const res = await createSessionTool.handler(
        { repoId: 5, workspaceId: 9, provider: 'claude' } as never,
        ctx,
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId: 5,
          workspaceId: 9,
          surface: 'session',
          activeAgentProvider: 'claude',
        }),
      );
      expect(res.data).toMatchObject({ sessionId: 55, provider: 'claude' });
      expect(res.touched).toEqual({ sessionId: 55 });
      expect(res.deepLink).toBe('/sessions/55');
    });

    it('creates a session from worktreePath + branchName', async () => {
      const create = jest.fn().mockResolvedValue({
        id: 7,
        name: 'Session 2',
        repoId: 5,
        branchName: 'main',
        worktreePath: '/wt/main',
        status: 'created',
        activeAgentProvider: 'codex',
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 5 }) },
        sessions: { create },
      });

      await createSessionTool.handler(
        { repoId: 5, worktreePath: '/wt/main', branchName: 'main', provider: 'codex' } as never,
        ctx,
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: '/wt/main', branchName: 'main' }),
      );
    });

    it('rejects when neither workspaceId nor worktreePath+branchName is given', async () => {
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 5 }) },
        sessions: { create: jest.fn() },
      });
      await expect(
        createSessionTool.handler({ repoId: 5 } as never, ctx),
      ).rejects.toMatchObject({ code: 'scope_required' });
    });

    it('errors cleanly when the repo does not exist', async () => {
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockRejectedValue(new Error('not found')) },
        sessions: { create: jest.fn() },
      });
      await expect(
        createSessionTool.handler({ repoId: 999, workspaceId: 1 } as never, ctx),
      ).rejects.toMatchObject({ code: 'repo_not_found' });
    });
  });

  describe('find_or_create_project', () => {
    it('reuses an existing project (created:false, idempotent)', async () => {
      const create = jest.fn();
      const ctx = makeCtx({
        projects: {
          findAll: jest.fn().mockResolvedValue([{ id: 5, name: 'Demo' }]),
          create,
        },
      });
      const res = await findOrCreateProjectTool.handler({ name: 'Demo' }, ctx);
      expect(res.data).toMatchObject({ projectId: 5, name: 'Demo', created: false });
      expect(res.touched).toEqual({ projectId: 5 });
      expect(create).not.toHaveBeenCalled();
    });

    it('creates when missing (created:true)', async () => {
      const create = jest.fn().mockResolvedValue({ id: 9, name: 'New' });
      const ctx = makeCtx({
        projects: { findAll: jest.fn().mockResolvedValue([]), create },
      });
      const res = await findOrCreateProjectTool.handler({ name: 'New' }, ctx);
      expect(res.data).toMatchObject({ projectId: 9, created: true });
      expect(create).toHaveBeenCalledWith('New');
    });
  });

  describe('add_repo', () => {
    it('reuses an existing repo at the same path (find-or-create)', async () => {
      const addRepo = jest.fn();
      const ctx = makeCtx({
        repos: {
          findByProject: jest
            .fn()
            .mockResolvedValue([{ id: 2, projectId: 1, name: 'r', path: '/r' }]),
          addRepo,
        },
      });
      const res = await addRepoTool.handler({ projectId: 1, repoPath: '/r' }, ctx);
      expect(res.data).toMatchObject({ repoId: 2, reused: true });
      expect(addRepo).not.toHaveBeenCalled();
    });

    it('creates when absent', async () => {
      const ctx = makeCtx({
        repos: {
          findByProject: jest.fn().mockResolvedValue([]),
          addRepo: jest
            .fn()
            .mockResolvedValue({ id: 3, projectId: 1, name: 'r', path: '/r' }),
        },
      });
      const res = await addRepoTool.handler({ projectId: 1, repoPath: '/r' }, ctx);
      expect(res.data).toMatchObject({ repoId: 3, reused: false });
      expect(res.touched).toEqual({ repoId: 3 });
    });

    it('recovers from a unique-conflict by reusing the existing row', async () => {
      const findByProject = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 4, projectId: 1, name: 'r', path: '/r' }]);
      const ctx = makeCtx({
        repos: {
          findByProject,
          addRepo: jest.fn().mockRejectedValue(new ConflictException('dup')),
        },
      });
      const res = await addRepoTool.handler({ projectId: 1, repoPath: '/r' }, ctx);
      expect(res.data).toMatchObject({ repoId: 4 });
    });
  });

  describe('remove_repo', () => {
    it('removes the repo', async () => {
      const remove = jest.fn().mockResolvedValue({ id: 7 });
      const ctx = makeCtx({ repos: { remove } });
      const res = await removeRepoTool.handler({ repoId: 7 }, ctx);
      expect(res.data).toEqual({ repoId: 7, removed: true });
      expect(remove).toHaveBeenCalledWith(7);
    });
  });

  describe('delete_worktree', () => {
    it('deletes sessions bound to the worktree, then removes it', async () => {
      const deleteByRepoAndWorktreePath = jest.fn().mockResolvedValue(undefined);
      const removeWorktree = jest.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/repo' }) },
        sessions: { deleteByRepoAndWorktreePath },
        worktrees: { removeWorktree },
      });
      const res = await deleteWorktreeTool.handler(
        { repoId: 1, worktreePath: '/repo/.worktrees/feature' },
        ctx,
      );
      expect(deleteByRepoAndWorktreePath).toHaveBeenCalledWith(
        1,
        '/repo/.worktrees/feature',
      );
      expect(removeWorktree).toHaveBeenCalledWith(
        '/repo',
        '/repo/.worktrees/feature',
      );
      expect(res.data).toEqual({
        repoId: 1,
        worktreePath: '/repo/.worktrees/feature',
        deleted: true,
      });
    });

    it('still removes the worktree if session cleanup fails', async () => {
      const removeWorktree = jest.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/repo' }) },
        sessions: {
          deleteByRepoAndWorktreePath: jest.fn().mockRejectedValue(new Error('boom')),
        },
        worktrees: { removeWorktree },
      });
      await deleteWorktreeTool.handler(
        { repoId: 1, worktreePath: '/repo/.worktrees/feature' },
        ctx,
      );
      expect(removeWorktree).toHaveBeenCalledWith('/repo', '/repo/.worktrees/feature');
    });

    it('wraps a git failure in a retryable ToolError', async () => {
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/repo' }) },
        sessions: { deleteByRepoAndWorktreePath: jest.fn().mockResolvedValue(undefined) },
        worktrees: {
          removeWorktree: jest.fn().mockRejectedValue(new Error('not a worktree')),
        },
      });
      await expect(
        deleteWorktreeTool.handler(
          { repoId: 1, worktreePath: '/repo/.worktrees/feature' },
          ctx,
        ),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('assess_worktree_pool', () => {
    function ctxWithItems(items: ReturnType<typeof poolItem>[]) {
      return makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, path: '/repo' }) },
        worktreePool: {
          streamForRepo: jest.fn(async (_repo: unknown, onItem: any) => {
            for (const it of items) await onItem(it);
            return items.length;
          }),
        },
      });
    }

    it('derives category from owner flags and filters to available', async () => {
      const ctx = ctxWithItems([
        poolItem({ id: 1, owner: null }),
        poolItem({
          id: 2,
          owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
        }),
      ]);
      const res = await assessWorktreePoolTool.handler(
        { repoId: 1, category: 'available', limit: 20 },
        ctx,
      );
      const data = res.data as any;
      expect(data.count).toBe(1);
      expect(data.worktrees[0]).toMatchObject({ worktreeId: 1, category: 'available' });
    });

    it("derives 'yours' for owned worktrees", async () => {
      const ctx = ctxWithItems([
        poolItem({ id: 2, owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 } }),
      ]);
      const res = await assessWorktreePoolTool.handler(
        { repoId: 1, category: 'yours', limit: 20 },
        ctx,
      );
      const data = res.data as any;
      expect(data.count).toBe(1);
      expect(data.worktrees[0]).toMatchObject({ category: 'yours' });
      expect(data.worktrees[0].owner).toEqual({ project: 'P', workspace: 'W' });
    });

    it('caps at limit and sets truncated when more match', async () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        poolItem({ id: i + 1, path: `/repo/wt${i}`, owner: null }),
      );
      const ctx = ctxWithItems(items);
      const res = await assessWorktreePoolTool.handler(
        { repoId: 1, category: 'available', limit: 2 },
        ctx,
      );
      const data = res.data as any;
      expect(data.count).toBe(2);
      expect(data.matchedTotal).toBe(5);
      expect(res.truncated).toBe(true);
    });
  });

  describe('create_worktree', () => {
    it('returns a jobId immediately without blocking', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-1', status: 'pending' });
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: emptyPool(),
      });
      const res = await createWorktreeTool.handler(
        { repoId: 1, branchName: 'feature/x' },
        ctx,
      );
      const data = res.data as any;
      expect(data.jobId).toBe('job-1');
      expect(data.status).toBe('pending');
      expect(res.touched).toEqual({ jobId: 'job-1' });
      // default path was derived and passed to startJob; no startPoint
      expect(startJob).toHaveBeenCalledWith(
        1,
        '/repo',
        'feature/x',
        expect.stringContaining('.worktrees'),
        undefined,
      );
    });

    it('creates a new branch from startPoint without hitting remote check', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-2', status: 'pending' });
      const remoteBranchExists = jest.fn();
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: {
          localBranchExists: jest.fn().mockResolvedValue(false),
          remoteBranchExists,
        },
        worktreeJobs: { startJob },
        worktreePool: emptyPool(),
      });
      const res = await createWorktreeTool.handler(
        { repoId: 1, branchName: 'user/new-feature', startPoint: 'origin/main' },
        ctx,
      );
      const data = res.data as any;
      expect(data.jobId).toBe('job-2');
      // startPoint must be threaded through to startJob
      expect(startJob).toHaveBeenCalledWith(
        1,
        '/repo',
        'user/new-feature',
        expect.stringContaining('.worktrees'),
        'origin/main',
      );
      // remote existence must NOT be checked when startPoint is provided
      expect(remoteBranchExists).not.toHaveBeenCalled();
    });

    it('auto-detects default branch when startPoint is omitted and branch is new', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-3', status: 'pending' });
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: {
          localBranchExists: jest.fn().mockResolvedValue(false),
          getDefaultBranch: jest.fn().mockResolvedValue('origin/main'),
        },
        worktreeJobs: { startJob },
        worktreePool: emptyPool(),
      });
      const res = await createWorktreeTool.handler(
        { repoId: 1, branchName: 'user/auto-detect-test' },
        ctx,
      );
      expect((res.data as any).jobId).toBe('job-3');
      // auto-detected default branch must be passed as startPoint
      expect(startJob).toHaveBeenCalledWith(
        1,
        '/repo',
        'user/auto-detect-test',
        expect.stringContaining('.worktrees'),
        'origin/main',
      );
    });

    it('errors with branch_not_found_locally when auto-detect finds no default branch', async () => {
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: {
          localBranchExists: jest.fn().mockResolvedValue(false),
          getDefaultBranch: jest.fn().mockResolvedValue(null),
          remoteBranchExists: jest.fn().mockResolvedValue(false),
        },
        worktreeJobs: { startJob: jest.fn() },
        worktreePool: emptyPool(),
      });
      await expect(
        createWorktreeTool.handler({ repoId: 1, branchName: 'user/no-remote' }, ctx),
      ).rejects.toMatchObject({ code: 'branch_not_found_locally' });
    });

    it('fetches the base ref before forking when fetch_start_point is true', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-4', status: 'pending' });
      const fetchBranch = jest.fn().mockResolvedValue(undefined);
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: {
          localBranchExists: jest.fn().mockResolvedValue(false),
          getDefaultBranch: jest.fn().mockResolvedValue('origin/main'),
          fetchBranch,
        },
        worktreeJobs: { startJob },
        worktreePool: emptyPool(),
      });
      await createWorktreeTool.handler(
        { repoId: 1, branchName: 'user/fresh-branch', fetch_start_point: true },
        ctx,
      );
      // must fetch 'main' (not 'origin/main') without creating a local branch
      expect(fetchBranch).toHaveBeenCalledWith('/repo', 'main', false);
      expect(startJob).toHaveBeenCalledWith(
        1, '/repo', 'user/fresh-branch',
        expect.stringContaining('.worktrees'),
        'origin/main',
      );
    });

    it('does not fetch when fetch_start_point is true but branch already exists locally', async () => {
      const fetchBranch = jest.fn();
      const ctx = makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }),
        },
        worktrees: {
          localBranchExists: jest.fn().mockResolvedValue(true),
          fetchBranch,
        },
        worktreeJobs: { startJob: jest.fn().mockReturnValue({ id: 'j', status: 'pending' }) },
        worktreePool: emptyPool(),
      });
      await createWorktreeTool.handler(
        { repoId: 1, branchName: 'feature/existing', fetch_start_point: true },
        ctx,
      );
      expect(fetchBranch).not.toHaveBeenCalled();
    });

    it('returns reclaimable candidates instead of creating when clean available worktrees exist', async () => {
      const startJob = jest.fn();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(poolItem({ id: 10, owner: null, isDirty: false }));
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      const data = res.data as any;
      expect(data.poolCheckResult).toBe('reclaimable_worktrees_found');
      expect(data.candidates).toHaveLength(1);
      expect(data.candidates[0].reclaimAction).toBe('link_worktree');
      expect(startJob).not.toHaveBeenCalled();
    });

    it('returns stale owned worktree as steal candidate when last used >72 h ago', async () => {
      const staleTs = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 20,
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            isDirty: false,
            lastUsedAt: staleTs,
          }),
        );
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob: jest.fn() },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      const data = res.data as any;
      expect(data.poolCheckResult).toBe('reclaimable_worktrees_found');
      expect(data.candidates[0].reclaimAction).toBe('steal_worktree');
    });

    it('proceeds to create when force:true even if reclaimable worktrees exist', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-f', status: 'pending' });
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(poolItem({ id: 10, owner: null, isDirty: false }));
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler(
        {
          repoId: 1,
          branchName: 'feature/x',
          force: true,
          forceReason: 'user_confirmed',
        },
        ctx,
      );
      expect((res.data as any).jobId).toBe('job-f');
      expect(startJob).toHaveBeenCalled();
    });

    it('rejects force:true without a forceReason instead of creating', async () => {
      const startJob = jest.fn();
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: emptyPool(),
      });
      await expect(
        createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x', force: true }, ctx),
      ).rejects.toMatchObject({ code: 'force_reason_required' });
      expect(startJob).not.toHaveBeenCalled();
    });

    it('excludes a worktree with sessions attached and reports why', async () => {
      const startJob = jest.fn().mockReturnValue({ id: 'job-b', status: 'pending' });
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 40,
            name: 'scout',
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            // Idle agent, but the session is still attached — the worktree is
            // in use and must not be offered for reuse.
            runningAgentCount: 0,
            activeSessionCount: 1,
            lastSessionActivityAt: new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString(),
          }),
        );
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      // No reclaimable candidate left, so creation proceeds without force.
      expect((res.data as any).jobId).toBe('job-b');
    });

    it('offers an owned session-free worktree with no recorded activity', async () => {
      const startJob = jest.fn();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 50,
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            lastUsedAt: null,
            lastSessionActivityAt: null,
          }),
        );
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      const data = res.data as any;
      expect(data.candidates[0]).toMatchObject({
        worktreeId: 50,
        reclaimAction: 'steal_worktree',
      });
      expect(startJob).not.toHaveBeenCalled();
    });

    it('ranks candidates unowned-first then longest-idle, independent of stream order', async () => {
      const hoursAgo = (hours: number) =>
        new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 1,
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            lastSessionActivityAt: hoursAgo(100),
          }),
        );
        await onItem(poolItem({ id: 2, owner: null, lastUsedAt: hoursAgo(1) }));
        await onItem(poolItem({ id: 3, owner: null, lastUsedAt: hoursAgo(50) }));
        return 3;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob: jest.fn() },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      const data = res.data as any;
      expect(data.candidateCount).toBe(3);
      expect(data.candidates.map((c: any) => c.worktreeId)).toEqual([3, 2, 1]);
    });

    it('skips owned worktree that was recently used (within 72 h)', async () => {
      const recentTs = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const startJob = jest.fn().mockReturnValue({ id: 'job-r', status: 'pending' });
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 30,
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            isDirty: false,
            lastUsedAt: recentTs,
          }),
        );
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      expect((res.data as any).jobId).toBe('job-r');
    });

    it('offers the worktree that already holds the requested branch instead of creating a doomed job', async () => {
      const startJob = jest.fn();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(poolItem({ id: 60, owner: null, currentBranch: 'feature/x', isDirty: false }));
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx);
      const data = res.data as any;
      expect(data.poolCheckResult).toBe('branch_already_checked_out');
      expect(data.candidates).toEqual([
        expect.objectContaining({ worktreeId: 60, branch: 'feature/x', reclaimAction: 'link_worktree' }),
      ]);
      expect(startJob).not.toHaveBeenCalled();
    });

    it('throws branch_checked_out_elsewhere when the branch owner cannot be reclaimed', async () => {
      const startJob = jest.fn();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(
          poolItem({
            id: 61,
            name: 'busy',
            currentBranch: 'feature/x',
            owner: { projectName: 'P', workspaceName: 'W', workspaceId: 9 },
            activeSessionCount: 1,
          }),
        );
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      await expect(
        createWorktreeTool.handler({ repoId: 1, branchName: 'feature/x' }, ctx),
      ).rejects.toMatchObject({ code: 'branch_checked_out_elsewhere' });
      expect(startJob).not.toHaveBeenCalled();
    });

    it('still refuses to create when force:true and the branch is already checked out elsewhere', async () => {
      const startJob = jest.fn();
      const streamForRepo = jest.fn(async (_repo: unknown, onItem: any) => {
        await onItem(poolItem({ id: 62, owner: null, currentBranch: 'feature/x', isDirty: false }));
        return 1;
      });
      const ctx = makeCtx({
        repos: { findOne: jest.fn().mockResolvedValue({ id: 1, name: 'repo', path: '/repo' }) },
        worktrees: { localBranchExists: jest.fn().mockResolvedValue(true) },
        worktreeJobs: { startJob },
        worktreePool: { streamForRepo },
      });
      const res = await createWorktreeTool.handler(
        { repoId: 1, branchName: 'feature/x', force: true, forceReason: 'user_confirmed' },
        ctx,
      );
      const data = res.data as any;
      expect(data.poolCheckResult).toBe('branch_already_checked_out');
      expect(startJob).not.toHaveBeenCalled();
    });
  });

  describe('get_worktree_job', () => {
    it('maps a succeeded job to a compact handle', async () => {
      const ctx = makeCtx({
        worktreeJobs: {
          waitForCompletion: jest.fn().mockResolvedValue({
            id: 'j',
            status: 'succeeded',
            branchName: 'feature/x',
            worktreePath: '/repo/wt',
            result: { path: '/repo/wt' },
            error: null,
          }),
        },
      });
      const res = await getWorktreeJobTool.handler({ repoId: 1, jobId: 'j' }, ctx);
      expect(res.data).toMatchObject({ status: 'succeeded', worktreePath: '/repo/wt' });
    });

    it('raises a structured error when the job is gone', async () => {
      const ctx = makeCtx({
        worktreeJobs: {
          waitForCompletion: jest.fn(() => {
            throw new Error('not found');
          }),
        },
      });
      await expect(
        getWorktreeJobTool.handler({ repoId: 1, jobId: 'x' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  describe('link_worktree vs steal_worktree', () => {
    function ctxWithLink(linkToProject: jest.Mock) {
      return makeCtx({
        repos: {
          findOne: jest.fn().mockResolvedValue({ id: 1, projectId: 3, path: '/repo' }),
        },
        worktreePool: { linkToProject },
      });
    }

    it('link_worktree does NOT pass confirmTakeover', async () => {
      const linkToProject = jest.fn().mockResolvedValue({
        id: 11,
        repoId: 1,
        name: 'ws',
        path: '/repo/wt',
        linkStatus: 'linked',
      });
      const ctx = ctxWithLink(linkToProject);
      const res = await linkWorktreeTool.handler(
        { repoId: 1, worktreeId: 5, branchName: 'feature/x' },
        ctx,
      );
      expect((res.data as any).workspace).toMatchObject({ workspaceId: 11 });
      const opts = linkToProject.mock.calls[0][2];
      expect(opts.confirmTakeover).toBeUndefined();
    });

    it('steal_worktree passes confirmTakeover:true', async () => {
      const linkToProject = jest.fn().mockResolvedValue({
        id: 12,
        repoId: 1,
        name: 'ws',
        path: '/repo/wt',
        linkStatus: 'linked',
      });
      const ctx = ctxWithLink(linkToProject);
      await stealWorktreeTool.handler(
        { repoId: 1, worktreeId: 5, branchName: 'feature/x' },
        ctx,
      );
      expect(linkToProject.mock.calls[0][2]).toMatchObject({ confirmTakeover: true });
    });

    it('surfaces an ownership conflict as a structured ToolError (no auto-confirm)', async () => {
      const linkToProject = jest
        .fn()
        .mockRejectedValue(new ConflictException('owned by another project'));
      const ctx = ctxWithLink(linkToProject);
      await expect(
        linkWorktreeTool.handler(
          { repoId: 1, worktreeId: 5, branchName: 'feature/x' },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'link_requires_confirmation' });
    });
  });

  describe('generate_worktree_context', () => {
    it('returns the snapshot compactly', async () => {
      const ctx = makeCtx({
        worktreeContext: {
          generate: jest.fn().mockResolvedValue({
            repoId: 1,
            worktreePath: '/repo/wt',
            generationStatus: 'ready',
            contextSentence: 'Adds X',
            hasChanges: true,
            generatedAt: 'now',
            errorMessage: null,
          }),
        },
      });
      const res = await generateWorktreeContextTool.handler(
        { repoId: 1, worktreePath: '/repo/wt', force: false, provider: 'claude' },
        ctx,
      );
      expect(res.data).toMatchObject({
        generationStatus: 'ready',
        contextSentence: 'Adds X',
      });
    });
  });

  describe('set_todo / set_scratchpad', () => {
    it('set_todo creates a todo', async () => {
      const create = jest
        .fn()
        .mockResolvedValue({ id: 1, text: 'do it', completed: false });
      const ctx = makeCtx({ todos: { create, update: jest.fn() } });
      const res = await setTodoTool.handler(
        { projectId: 1, text: 'do it' },
        ctx,
      );
      expect(res.data).toMatchObject({ todoId: 1, text: 'do it' });
      expect(create).toHaveBeenCalledWith(1, 'do it');
    });

    it('set_todo updates when todoId is given', async () => {
      const update = jest
        .fn()
        .mockResolvedValue({ id: 1, text: 'done', completed: true });
      const ctx = makeCtx({ todos: { create: jest.fn(), update } });
      const res = await setTodoTool.handler(
        { projectId: 1, todoId: 1, completed: true },
        ctx,
      );
      expect(res.data).toMatchObject({ completed: true });
      expect(update).toHaveBeenCalledWith(1, { completed: true });
    });

    it('set_scratchpad find-or-creates and sets content', async () => {
      const create = jest.fn().mockResolvedValue({ id: 8, name: 'Notes', content: '' });
      const update = jest
        .fn()
        .mockResolvedValue({ id: 8, name: 'Notes', content: 'hello' });
      const ctx = makeCtx({
        scratchpad: { findByProject: jest.fn().mockResolvedValue([]), create, update },
      });
      const res = await setScratchpadTool.handler(
        { projectId: 1, name: 'Notes', content: 'hello' },
        ctx,
      );
      expect(res.data).toMatchObject({ sectionId: 8, created: true, contentLength: 5 });
      expect(update).toHaveBeenCalledWith(8, { content: 'hello' });
    });
  });
});
