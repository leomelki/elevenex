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
import { getWorktreeJobTool } from '../tools/setup/get-worktree-job.tool.js';
import { linkWorktreeTool } from '../tools/setup/link-worktree.tool.js';
import { stealWorktreeTool } from '../tools/setup/steal-worktree.tool.js';
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
    owner: null,
    projectWorkspace: null,
    ...overrides,
  };
}

describe('setup tool group', () => {
  it('registers all 11 setup tools', () => {
    expect(SETUP_TOOLS).toHaveLength(11);
    expect(SETUP_TOOLS.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'find_or_create_project',
        'add_repo',
        'remove_repo',
        'assess_worktree_pool',
        'create_worktree',
        'get_worktree_job',
        'link_worktree',
        'steal_worktree',
        'generate_worktree_context',
        'set_todo',
        'set_scratchpad',
      ]),
    );
    expect(stealWorktreeTool.destructive).toBe(true);
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
        worktreeJobs: { startJob },
      });
      const res = await createWorktreeTool.handler(
        { repoId: 1, branchName: 'feature/x' },
        ctx,
      );
      const data = res.data as any;
      expect(data.jobId).toBe('job-1');
      expect(data.status).toBe('pending');
      expect(res.touched).toEqual({ jobId: 'job-1' });
      // default path was derived and passed to startJob
      expect(startJob).toHaveBeenCalledWith(
        1,
        '/repo',
        'feature/x',
        expect.stringContaining('.worktrees'),
      );
    });
  });

  describe('get_worktree_job', () => {
    it('maps a succeeded job to a compact handle', async () => {
      const ctx = makeCtx({
        worktreeJobs: {
          getJob: jest.fn().mockReturnValue({
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
          getJob: jest.fn(() => {
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
