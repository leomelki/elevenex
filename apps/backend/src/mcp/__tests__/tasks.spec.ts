import { generateWorktreeContextTool } from '../tools/setup/generate-worktree-context.tool.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import { TASK_TOOLS } from '../tools/setup/task.tools.js';
import { createSessionTool } from '../tools/setup/create-session.tool.js';
import { findSessionsTool } from '../tools/observe/find-sessions.tool.js';
import { findBranchesTool } from '../tools/observe/find-branches.tool.js';
import { PROJECT_NOTES_TOOLS } from '../tools/observe/project-notes.tools.js';
import { resolveWorktreeScope } from '../tools/observe/_resolve-scope.js';
import { errorToResult } from '../tool-registry/result-envelope.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type {
  ToolContext,
  ToolDefinition,
} from '../tool-registry/tool.types.js';
import { SESSION_LABEL_TOOLS } from '../tools/drive/session-label.tools.js';
import { ALL_TOOLS } from '../tools/index.js';
import { isDestructiveElevenexTool } from '../agent-tool-policy.js';

const task = {
  id: 9,
  repoId: 5,
  name: 'Fix auth',
  taskState: 'ready',
  archivedAt: null,
  taskBranch: 'fix/auth',
  sourceRef: 'refs/heads/fix/auth',
  checkoutMode: 'branch',
  path: '/wt/current',
  poolWorktreeId: 4,
  linkStatus: 'linked',
  error: null,
  startingCommit: 'abc',
  finalCommit: null,
  preparationStage: null,
  taskDraft: '',
  taskConfig: 'must-not-leak',
  sessions: [
    {
      id: 42,
      name: 'Implement',
      status: 'created',
      activeAgentProvider: 'codex',
    },
  ],
};
function fixture(overrides: Record<string, unknown> = {}) {
  const current = { ...task, ...overrides };
  const tasks = {
    waitForPreparation: jest
      .fn()
      .mockResolvedValue({ task: current, timedOut: false }),
    move: jest.fn().mockResolvedValue({ taskIds: [9, 12] }),
    record: jest.fn().mockResolvedValue(current),
    get: jest.fn().mockResolvedValue(current),
    create: jest.fn().mockResolvedValue(current),
    list: jest.fn().mockResolvedValue([current]),
    defaults: jest
      .fn()
      .mockResolvedValue({ baseRef: 'origin/main', branchName: 'fix-auth' }),
    retry: jest.fn().mockResolvedValue(current),
    rename: jest.fn().mockResolvedValue(current),
    finish: jest.fn().mockResolvedValue({
      ...current,
      archivedAt: 'today',
      linkStatus: 'unlinked',
    }),
    finishAfterTurn: jest.fn().mockResolvedValue({
      taskId: 9,
      finishScheduled: true,
      afterSessionId: 42,
    }),
    cancelScheduledFinish: jest
      .fn()
      .mockResolvedValue({
        taskId: 9,
        cancelled: true,
        finishScheduled: false,
      }),
    reopen: jest.fn().mockResolvedValue({
      ...current,
      taskState: 'preparing',
      path: '',
      linkStatus: 'unlinked',
    }),
    finishPreview: jest
      .fn()
      .mockResolvedValue({ agents: 1, terminals: 2, actions: 3 }),
    openConversation: jest.fn().mockResolvedValue(current.sessions[0]),
    saveDraft: jest.fn().mockResolvedValue({ saved: true }),
  };
  const sessions = {
    create: jest.fn().mockResolvedValue({
      id: 55,
      name: 'Review',
      repoId: 5,
      workspaceId: 9,
      branchName: 'fix/auth',
      worktreePath: '/wt/current',
      activeAgentProvider: 'pi',
      status: 'created',
    }),
    findOne: jest.fn().mockResolvedValue({
      id: 42,
      workspaceId: 9,
      repoId: 5,
      surface: 'session',
      worktreePath: '/wt/current',
      activeAgentProvider: 'codex',
    }),
    assertSessionWorkspaceLinked: jest.fn().mockResolvedValue(undefined),
    findByRepo: jest.fn().mockResolvedValue([]),
    listHandlePage: jest.fn().mockResolvedValue({
      rows: [
        {
          id: 42,
          status: 'archived',
          workspaceId: 9,
          activeAgentProvider: 'codex',
        },
      ],
      total: 1,
      nextOffset: null,
    }),
    findByWorkspace: jest.fn().mockResolvedValue([
      {
        id: 42,
        status: 'archived',
        workspaceId: 9,
        activeAgentProvider: 'codex',
      },
    ]),
    update: jest.fn().mockResolvedValue({ id: 42, name: 'Investigation' }),
    unarchive: jest.fn().mockResolvedValue({ id: 55, status: 'stopped' }),
  };
  const ctx = {
    services: { tasks, sessions },
    signal: new AbortController().signal,
    agentSessionId: 42,
    deepLink: new DeepLinkBuilder(),
  } as unknown as ToolContext;
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = [
      ...TASK_TOOLS,
      createSessionTool,
      findSessionsTool,
      ...SESSION_LABEL_TOOLS,
    ].find((tool) => tool.name === name)! as ToolDefinition;
    return tool.handler(z.object(tool.inputShape).parse(args), ctx);
  };
  return { ctx, tasks, sessions, call };
}

describe('task-aware agent workflow', () => {
  it('reorders tasks within their authoritative repository without changing execution', async () => {
    const f = fixture();
    await f.call('move_task', { taskId: 9, beforeTaskId: 12 });
    expect(f.tasks.move).toHaveBeenCalledWith(5, 9, 12);
    expect(f.tasks.create).not.toHaveBeenCalled();
    expect(f.tasks.finish).not.toHaveBeenCalled();
  });
  it('reports expected session/task state errors as actionable failures', () => {
    expect(
      errorToResult(
        new BadRequestException({
          code: 'environment_missing',
          message: 'Reopen this task.',
          taskId: 9,
        }),
      ).structuredContent,
    ).toMatchObject({
      error: {
        code: 'environment_missing',
        retryable: false,
        details: { taskId: 9 },
      },
    });
  });
  it('gets branch/base suggestions without reserving a checkout', async () => {
    const f = fixture();
    expect(
      (await f.call('get_task_defaults', { repoId: 5, name: 'Fix auth' })).data,
    ).toEqual({ baseRef: 'origin/main', branchName: 'fix-auth' });
    expect(f.tasks.defaults).toHaveBeenCalledWith(5, 'Fix auth');
    expect(f.tasks.create).not.toHaveBeenCalled();
  });

  it('supports stable creation keys, snapshot review and explicit checkout selection', async () => {
    const f = fixture({
      taskState: 'preparing',
      preparationStage: 'refreshing_ref',
      sessions: [],
    });
    const args = {
      repoId: 5,
      requestId: 'review-pr-42',
      mode: 'existing',
      branchName: 'refs/remotes/origin/fix/auth',
      checkoutMode: 'snapshot',
      environment: 'existing',
      worktreeId: 4,
    };
    const result = await f.call('create_task', args);
    expect(f.tasks.create).toHaveBeenCalledWith(
      5,
      expect.objectContaining(args),
    );
    expect(result).toMatchObject({
      data: {
        taskId: 9,
        state: 'preparing',
        preparationStage: 'refreshing_ref',
        environmentAvailable: false,
      },
      deepLink: '/tasks/9',
    });
    expect(result.nextStep).toContain('await_task_ready');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('waits for accepted task preparation with the caller’s cancellation signal', async () => {
    const f = fixture();
    expect(await f.call('await_task_ready', { taskId: 9 })).toMatchObject({
      data: { taskId: 9, timedOut: false },
    });
    expect(f.tasks.waitForPreparation).toHaveBeenCalledWith(
      9,
      30000,
      f.ctx.signal,
    );
  });

  it('uses the scoped session provider for context generation and avoids retry loops on unchanged branches', async () => {
    const f = fixture();
    const generate = jest.fn().mockResolvedValue({
      repoId: 5,
      worktreePath: '/wt/current',
      generationStatus: 'idle',
      hasChanges: false,
    });
    Object.assign(f.ctx.services, { worktreeContext: { generate } });
    const args = z
      .object(generateWorktreeContextTool.inputShape)
      .parse({ sessionId: 42 });
    const result = await generateWorktreeContextTool.handler(args, f.ctx);
    expect(generate).toHaveBeenCalledWith(5, '/wt/current', {
      force: false,
      provider: 'codex',
    });
    expect(result.nextStep).toContain('no repeated generation');
  });

  it('pages tasks using the final ID in returned sidebar order', async () => {
    const f = fixture();
    f.tasks.list.mockResolvedValue([
      { ...task, id: 30 },
      { ...task, id: 8 },
    ]);
    const first = await f.call('list_tasks', { repoId: 5, limit: 2 });
    expect(first.data).toMatchObject({ count: 2, nextCursor: 8 });
    await f.call('list_tasks', { repoId: 5, limit: 2, cursor: 8 });
    expect(f.tasks.list).toHaveBeenLastCalledWith(5, 'active', 2, 8);
  });

  it('pages conversations without dumping task configuration or draft content', async () => {
    const f = fixture({
      sessions: Array.from({ length: 25 }, (_, i) => ({
        ...task.sessions[0],
        id: i + 1,
      })),
      taskDraft: 'unsent prompt',
    });
    const result = await f.call('get_task', {
      taskId: 9,
      sessionOffset: 20,
      sessionLimit: 3,
    });
    expect(result).toMatchObject({
      truncated: true,
      data: {
        sessionCount: 25,
        sessionOffset: 20,
        nextSessionOffset: 23,
        draftLength: 13,
      },
    });
    expect((result.data as { sessions: unknown[] }).sessions).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('unsent prompt');
  });

  it('opens/reuses an existing task conversation without creating or starting another agent', async () => {
    const f = fixture();
    const result = await f.call('open_task_session', { taskId: 9 });
    expect(f.tasks.openConversation).toHaveBeenCalledWith(9);
    expect(f.sessions.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: { taskId: 9, sessionId: 42 } });
    expect(result.nextStep).toContain('current conversation');
  });

  it('creates a conversation using the task’s authoritative repo/checkout and configured provider default', async () => {
    const f = fixture();
    const result = await f.call('create_session', {
      taskId: 9,
      name: 'Review',
      folderId: 7,
    });
    expect(f.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 5,
        workspaceId: 9,
        folderId: 7,
        activeAgentProvider: undefined,
      }),
    );
    expect(result).toMatchObject({
      data: { taskId: 9, sessionId: 55, provider: 'pi' },
    });
    expect(createSessionTool.inputShape).not.toHaveProperty('worktreePath');
    expect(createSessionTool.inputShape).not.toHaveProperty('branchName');
  });

  it('preserves explicit provider selection and rejects unavailable task environments', async () => {
    const f = fixture();
    await f.call('create_session', { taskId: 9, provider: 'opencode' });
    expect(f.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ activeAgentProvider: 'opencode' }),
    );
    f.sessions.create.mockRejectedValue(
      new BadRequestException('Reopen this task before starting a session.'),
    );
    await expect(f.call('create_session', { taskId: 9 })).rejects.toThrow(
      'Reopen this task',
    );
  });

  it('keeps actionable conflict details for snapshot/external recovery', async () => {
    const f = fixture();
    f.tasks.finish.mockRejectedValue(
      new ConflictException({
        code: 'running_work',
        message: 'Stop running work first.',
        agents: 2,
        terminals: 1,
        actions: 0,
      }),
    );
    try {
      await f.call('finish_task', { taskId: 12 });
      throw new Error('expected rejection');
    } catch (error) {
      expect(errorToResult(error).structuredContent).toMatchObject({
        error: {
          code: 'running_work',
          details: { agents: 2, terminals: 1, actions: 0 },
        },
      });
    }
    f.tasks.create.mockRejectedValue(
      new ConflictException({
        code: 'branch_in_use',
        message: 'Branch occupied.',
        existingTaskId: 12,
        canSnapshot: true,
      }),
    );
    await expect(
      f.call('create_task', {
        repoId: 5,
        requestId: 'x',
        mode: 'existing',
        branchName: 'main',
      }),
    ).rejects.toMatchObject({
      details: { existingTaskId: 12, canSnapshot: true },
    });
  });

  it('passes only the recovery patch to retry_task', async () => {
    const f = fixture();
    await f.call('retry_task', {
      taskId: 9,
      checkoutMode: 'snapshot',
      useSavedRef: true,
    });
    expect(f.tasks.retry).toHaveBeenCalledWith(9, {
      checkoutMode: 'snapshot',
      useSavedRef: true,
    });
  });

  it('previews running work without finishing, and does not invent stop confirmation', async () => {
    const f = fixture();
    expect(
      (await f.call('preview_finish_task', { taskId: 9 })).data,
    ).toMatchObject({ agents: 1, terminals: 2, actions: 3 });
    expect(f.tasks.finish).not.toHaveBeenCalled();
    await f.call('finish_task', { taskId: 12 });
    expect(f.tasks.finish).toHaveBeenCalledWith(12, false);
  });

  it('schedules self-finishing only on explicit user request without assuming stop approval', async () => {
    const f = fixture();
    await expect(
      f.call('finish_task', { taskId: 9, confirmStop: true }),
    ).rejects.toMatchObject({ code: 'self_target_not_allowed' });
    expect(f.tasks.finishAfterTurn).not.toHaveBeenCalled();
    const result = await f.call('finish_task', {
      taskId: 9,
      userRequested: true,
    });
    expect(result.data).toEqual({
      taskId: 9,
      finishScheduled: true,
      afterSessionId: 42,
    });
    expect(result.nextStep).toContain('without waiting or polling');
    expect(result.nextStep).toContain('cancel_finish_task');
    expect(f.tasks.finishAfterTurn).toHaveBeenCalledWith(9, 42, false);
    expect(f.tasks.finish).not.toHaveBeenCalled();
  });

  it('cancels using the authenticated caller and tells it to continue working', async () => {
    const f = fixture();
    const result = await f.call('cancel_finish_task', { taskId: 9 });
    expect(f.tasks.cancelScheduledFinish).toHaveBeenCalledWith(9, 42);
    expect(result.data).toEqual({
      taskId: 9,
      cancelled: true,
      finishScheduled: false,
    });
    expect(result.nextStep).toContain('Continue working normally');
    expect(f.tasks.finish).not.toHaveBeenCalled();
  });

  it('reopens with stable identity and polls the new environment', async () => {
    const f = fixture();
    const result = await f.call('reopen_task', { taskId: 9 });
    expect(result).toMatchObject({
      data: { taskId: 9, state: 'preparing', environmentPath: null },
      deepLink: '/tasks/9',
    });
    expect(result.nextStep).toContain('await_task_ready');
  });

  it('reads draft windows and saves unsent text without creating a session', async () => {
    const f = fixture({ taskDraft: '0123456789' });
    expect(
      await f.call('read_task_draft', { taskId: 9, offset: 3, limit: 4 }),
    ).toMatchObject({
      data: { text: '3456', totalCharacters: 10, nextOffset: 7 },
      truncated: true,
    });
    await f.call('set_task_draft', { taskId: 9, text: '' });
    expect(f.tasks.saveDraft).toHaveBeenCalledWith(9, '');
    expect(f.sessions.create).not.toHaveBeenCalled();
  });

  it('discovers finished-task conversations without starting or reacquiring the task', async () => {
    const f = fixture();
    const result = await f.call('find_sessions', { taskId: 9, state: 'all' });
    expect(result.data).toMatchObject({ total: 1 });
    expect(f.sessions.listHandlePage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 9, state: 'all' }),
    );
    expect(f.tasks.reopen).not.toHaveBeenCalled();
    expect(f.sessions.findByRepo).not.toHaveBeenCalled();
  });

  it('rejects conflicting discovery scopes instead of silently overriding an explicit target', async () => {
    await expect(
      fixture().call('find_sessions', { taskId: 9, repoId: 5 }),
    ).rejects.toMatchObject({ code: 'conflicting_scope' });
  });

  it('pages a folder’s full membership beyond its bounded preview', async () => {
    const f = fixture();
    f.sessions.listHandlePage.mockResolvedValue({
      rows: [
        {
          id: 42,
          status: 'archived',
          workspaceId: 9,
          activeAgentProvider: 'codex',
          folderId: 7,
        },
      ],
      total: 1,
      nextOffset: null,
    });
    expect(
      (await f.call('find_sessions', { taskId: 9, state: 'all', folderId: 7 }))
        .data,
    ).toMatchObject({ total: 1, sessions: [{ id: 42, folderId: 7 }] });
  });

  it('validates task checkout ownership before reading files from historical session paths', async () => {
    const f = fixture();
    f.sessions.assertSessionWorkspaceLinked.mockRejectedValue(
      new BadRequestException('Reopen this task before starting a session.'),
    );
    await expect(
      resolveWorktreeScope(f.ctx, { sessionId: 42 }),
    ).rejects.toThrow('Reopen this task');
    await expect(
      resolveWorktreeScope(f.ctx, { worktreePath: '/wt/explicit' }),
    ).resolves.toMatchObject({ worktreePath: '/wt/explicit' });
  });

  it('lets conversations be renamed/restored separately from their task', async () => {
    const f = fixture();
    await f.call('rename_session', { sessionId: 42, name: 'Investigation' });
    expect(f.sessions.update).toHaveBeenCalledWith(42, {
      name: 'Investigation',
    });
    await f.call('unarchive_session', { sessionId: 55 });
    expect(f.sessions.unarchive).toHaveBeenCalledWith(55);
    expect(f.tasks.reopen).not.toHaveBeenCalled();
  });

  it('keeps every advertised destructive tool gated in Claude review autonomy', () => {
    for (const tool of ALL_TOOLS.filter((tool) => tool.destructive)) {
      expect(isDestructiveElevenexTool(`mcp__elevenex__${tool.name}`)).toBe(
        true,
      );
    }
  });
});

describe('branch and project-note discovery', () => {
  it('returns unambiguous local/remote refs in bounded pages without fetching', async () => {
    const getBranches = jest.fn().mockResolvedValue([
      {
        name: 'fix/auth',
        isRemote: false,
        commit: 'abc',
        worktreePath: '/wt/task',
      },
      {
        name: 'origin/fix/auth',
        isRemote: true,
        commit: 'def',
        worktreePath: null,
      },
    ]);
    const ctx = {
      services: {
        repos: { findOne: async () => ({ id: 5, path: '/repo' }) },
        branches: { getBranches },
      },
    } as unknown as ToolContext;
    const args = z
      .object(findBranchesTool.inputShape)
      .parse({ repoId: 5, query: 'auth', limit: 1 });
    const first = await findBranchesTool.handler(args, ctx);
    expect(first).toMatchObject({
      truncated: true,
      data: { nextOffset: 1, branches: [{ ref: 'refs/heads/fix/auth' }] },
    });
    const second = await findBranchesTool.handler({ ...args, offset: 1 }, ctx);
    expect(second.data).toMatchObject({
      branches: [{ ref: 'refs/remotes/origin/fix/auth' }],
    });
    expect(getBranches).toHaveBeenCalledWith('/repo', true);
  });

  it('reads scratchpad windows and pages checklist items separately from Tasks', async () => {
    const ctx = {
      services: {
        scratchpad: {
          readWindow: async (projectId: number, sectionId: number) =>
            projectId === 1 && sectionId === 8
              ? {
                  sectionId: 8,
                  projectId: 1,
                  name: 'Notes',
                  content: '3456',
                  totalCharacters: 10,
                  isMarkdown: true,
                }
              : null,
          listHandles: async () => ({
            sections: [{ sectionId: 8, name: 'Notes', contentLength: 10 }],
            total: 1,
            nextOffset: null,
          }),
        },
        todos: {
          listHandles: async () => ({
            todos: [{ todoId: 2, text: 'pending', completed: false }],
            total: 1,
            nextOffset: null,
          }),
        },
      },
      deepLink: new DeepLinkBuilder(),
    } as unknown as ToolContext;
    async function call(name: string, args: Record<string, unknown>) {
      const tool = PROJECT_NOTES_TOOLS.find(
        (tool) => tool.name === name,
      )! as ToolDefinition;
      return tool.handler(z.object(tool.inputShape).parse(args), ctx);
    }
    expect(
      (
        await call('read_scratchpad', {
          projectId: 1,
          sectionId: 8,
          offset: 3,
          limit: 4,
        })
      ).data,
    ).toMatchObject({ content: '3456', nextOffset: 7 });
    expect((await call('list_todos', { projectId: 1 })).data).toMatchObject({
      todos: [{ todoId: 2 }],
    });
    expect(
      (await call('list_scratchpad', { projectId: 1 })).data,
    ).toMatchObject({ sections: [{ sectionId: 8, contentLength: 10 }] });
    await expect(
      call('read_scratchpad', { projectId: 2, sectionId: 999 }),
    ).rejects.toMatchObject({ code: 'section_not_found' });
  });
});
