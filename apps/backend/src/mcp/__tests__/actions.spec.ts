import { EventEmitter } from 'events';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { ToolError } from '../tool-registry/tool.types.js';
import { ACTION_TOOLS } from '../tools/actions/index.js';
import { listActionsTool } from '../tools/actions/list-actions.tool.js';
import { setActionTool } from '../tools/actions/set-action.tool.js';
import { deleteActionTool } from '../tools/actions/delete-action.tool.js';
import { runActionTool } from '../tools/actions/run-action.tool.js';
import { stopActionTool } from '../tools/actions/stop-action.tool.js';
import { readActionOutputTool } from '../tools/actions/read-action-output.tool.js';
import { pollActionStatusTool } from '../tools/actions/poll-action-status.tool.js';

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
  };
}

/** Wait until the poll tool has subscribed, so an emit can't race ahead of it. */
async function waitForListener(emitter: EventEmitter): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (emitter.listenerCount('action-status-changed') > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('poll_action_status never subscribed');
}

/** An `actions` row double with sensible defaults. */
function actionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    worktreePath: '/wt/a',
    name: 'test',
    command: 'pnpm test',
    status: 'idle',
    lastRunAt: null,
    lastFinishedAt: null,
    lastExitCode: null,
    currentOutput: '',
    lastOutput: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('actions tool group', () => {
  it('registers all 7 action tools with the right guarantees', () => {
    expect(ACTION_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'delete_action',
        'list_actions',
        'poll_action_status',
        'read_action_output',
        'run_action',
        'set_action',
        'stop_action',
      ].sort(),
    );

    // Reads never mutate; writes are gated on canMutate; nothing here is
    // destructive (no action tool touches files or history).
    for (const tool of ACTION_TOOLS) {
      expect(tool.destructive).toBeFalsy();
    }
    expect(listActionsTool.mutates).toBeFalsy();
    expect(readActionOutputTool.mutates).toBeFalsy();
    expect(pollActionStatusTool.mutates).toBeFalsy();
    expect(setActionTool.mutates).toBe(true);
    expect(deleteActionTool.mutates).toBe(true);
    expect(runActionTool.mutates).toBe(true);
    expect(stopActionTool.mutates).toBe(true);
  });

  describe('list_actions', () => {
    it('returns compact handles and a running count for a worktree', async () => {
      const listByWorktree = jest.fn().mockResolvedValue([
        actionRow({ id: 1, name: 'test', status: 'failed', lastExitCode: 1 }),
        actionRow({
          id: 2,
          name: 'dev',
          command: 'pnpm dev',
          status: 'running',
        }),
      ]);
      const ctx = makeCtx({ actions: { listByWorktree } });

      const res = await listActionsTool.handler({ worktreePath: '/wt/a' }, ctx);
      const data = res.data as any;

      expect(listByWorktree).toHaveBeenCalledWith('/wt/a');
      expect(data.count).toBe(2);
      expect(data.runningCount).toBe(1);
      expect(data.actions[0]).toMatchObject({
        actionId: 1,
        name: 'test',
        command: 'pnpm test',
        status: 'failed',
        isRunning: false,
        lastExitCode: 1,
      });
      // Output blobs never travel in a list result.
      expect(data.actions[0].output).toBeUndefined();
    });

    it('resolves the worktree from a sessionId and deep-links back to it', async () => {
      const listByWorktree = jest.fn().mockResolvedValue([]);
      const ctx = makeCtx({
        actions: { listByWorktree },
        sessions: {
          findOne: jest.fn().mockResolvedValue({
            id: 7,
            worktreePath: '/wt/from-session',
            repoId: 3,
            surface: 'user',
          }),
        },
      });

      const res = await listActionsTool.handler({ sessionId: 7 }, ctx);

      expect(listByWorktree).toHaveBeenCalledWith('/wt/from-session');
      expect(res.deepLink).toBe('/sessions/7');
      expect(res.nextStep).toContain('set_action');
    });

    it('requires a scope', async () => {
      const ctx = makeCtx({ actions: { listByWorktree: jest.fn() } });
      await expect(listActionsTool.handler({}, ctx)).rejects.toThrow(ToolError);
    });
  });

  describe('set_action', () => {
    it('creates a new action when the worktree has no action with that name', async () => {
      const create = jest
        .fn()
        .mockResolvedValue(actionRow({ id: 9, name: 'lint' }));
      const ctx = makeCtx({
        actions: { listByWorktree: jest.fn().mockResolvedValue([]), create },
      });

      const res = await setActionTool.handler(
        // The repo root always exists, so the worktree-exists guard passes.
        {
          worktreePath: process.cwd(),
          name: 'lint',
          command: 'pnpm lint',
        },
        ctx,
      );

      expect(create).toHaveBeenCalledWith({
        worktreePath: process.cwd(),
        name: 'lint',
        command: 'pnpm lint',
      });
      expect((res.data as any).created).toBe(true);
      expect(res.touched).toEqual({ actionId: 9 });
    });

    it('upserts on the name instead of duplicating the panel entry', async () => {
      const existing = actionRow({ id: 4, name: 'Test', command: 'pnpm test' });
      const update = jest
        .fn()
        .mockResolvedValue({ ...existing, command: 'pnpm test --run' });
      const create = jest.fn();
      const ctx = makeCtx({
        actions: {
          listByWorktree: jest.fn().mockResolvedValue([existing]),
          update,
          create,
        },
      });

      const res = await setActionTool.handler(
        {
          worktreePath: '/wt/a',
          name: 'test',
          command: 'pnpm test --run',
        },
        ctx,
      );

      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith(4, { command: 'pnpm test --run' });
      expect(res.data).toMatchObject({
        actionId: 4,
        created: false,
        updated: true,
      });
    });

    it('is a no-op when the same name and command already exist', async () => {
      const existing = actionRow({ id: 4, name: 'test', command: 'pnpm test' });
      const update = jest.fn();
      const create = jest.fn();
      const ctx = makeCtx({
        actions: {
          listByWorktree: jest.fn().mockResolvedValue([existing]),
          update,
          create,
        },
      });

      const res = await setActionTool.handler(
        { worktreePath: '/wt/a', name: 'test', command: 'pnpm test' },
        ctx,
      );

      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(res.data).toMatchObject({ created: false, updated: false });
    });

    it('edits a specific action by id', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest.fn().mockResolvedValue(actionRow({ id: 4 })),
          update: jest
            .fn()
            .mockResolvedValue(
              actionRow({ id: 4, name: 'unit', command: 'x' }),
            ),
        },
      });

      const res = await setActionTool.handler(
        { actionId: 4, name: 'unit', command: 'x' },
        ctx,
      );

      expect(ctx.services.actions.update).toHaveBeenCalledWith(4, {
        name: 'unit',
        command: 'x',
      });
      expect(res.data).toMatchObject({ name: 'unit', updated: true });
    });

    it('surfaces "cannot edit a running action" with a way out', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest
            .fn()
            .mockResolvedValue(actionRow({ id: 4, status: 'running' })),
          update: jest
            .fn()
            .mockRejectedValue(new Error('Cannot edit a running action')),
        },
      });

      await expect(
        setActionTool.handler({ actionId: 4, command: 'x' }, ctx),
      ).rejects.toMatchObject({
        code: 'action_update_failed',
        remediation: expect.stringContaining('stop_action'),
      });
    });

    it('rejects a create that is missing name or command', async () => {
      const ctx = makeCtx({ actions: {} });
      await expect(
        setActionTool.handler({ worktreePath: '/wt/a', name: 'lint' }, ctx),
      ).rejects.toMatchObject({ code: 'action_fields_required' });
    });
  });

  describe('run_action / stop_action', () => {
    it('run returns immediately with a running handle and points at the poll tool', async () => {
      const running = actionRow({
        id: 3,
        status: 'running',
        lastRunAt: '2026-01-02T10:00:00.000Z',
      });
      const ctx = makeCtx({
        actions: {
          findOne: jest.fn().mockResolvedValue(actionRow({ id: 3 })),
          run: jest.fn().mockResolvedValue(running),
        },
      });

      const res = await runActionTool.handler({ actionId: 3 }, ctx);

      expect(res.data).toMatchObject({ actionId: 3, isRunning: true });
      expect(res.nextStep).toContain('poll_action_status');
    });

    it('maps "already running" to a structured error', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest
            .fn()
            .mockResolvedValue(actionRow({ id: 3, status: 'running' })),
          run: jest
            .fn()
            .mockRejectedValue(new Error('Action "test" is already running')),
        },
      });

      await expect(
        runActionTool.handler({ actionId: 3 }, ctx),
      ).rejects.toMatchObject({
        code: 'action_run_failed',
        message: 'Action "test" is already running',
      });
    });

    it('stop reports instead of failing when nothing is running', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest
            .fn()
            .mockResolvedValue(actionRow({ id: 3, status: 'success' })),
          stop: jest.fn().mockRejectedValue(new Error('Action is not running')),
        },
      });

      const res = await stopActionTool.handler({ actionId: 3 }, ctx);

      expect(res.data).toMatchObject({ stopped: false, status: 'success' });
    });

    it('unknown ids fail with a self-correcting error', async () => {
      const ctx = makeCtx({
        actions: { findOne: jest.fn().mockRejectedValue(new Error('nope')) },
      });

      await expect(
        runActionTool.handler({ actionId: 99 }, ctx),
      ).rejects.toMatchObject({
        code: 'action_not_found',
        remediation: expect.stringContaining('list_actions'),
      });
    });
  });

  describe('read_action_output', () => {
    it('strips ANSI, collapses progress rewrites, and tails the log', async () => {
      const raw = [
        'line1',
        'line2',
        '[31mline3 in red[0m',
        'progress 10%\rprogress 100%',
      ].join('\n');
      const ctx = makeCtx({
        actions: {
          findOne: jest.fn().mockResolvedValue(
            actionRow({
              status: 'failed',
              lastExitCode: 1,
              lastOutput: raw,
              lastRunAt: '2026-01-02T10:00:00.000Z',
              lastFinishedAt: '2026-01-02T10:00:12.000Z',
            }),
          ),
        },
      });

      const res = await readActionOutputTool.handler(
        { actionId: 1, tailLines: 2 },
        ctx,
      );
      const data = res.data as any;

      expect(data.output).toBe('line3 in red\nprogress 100%');
      expect(data.totalLines).toBe(4);
      expect(data.source).toBe('last-run');
      expect(data.durationSeconds).toBe(12);
      expect(res.truncated).toBe(true);
    });

    it('reads the live buffer while the action is running', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest.fn().mockResolvedValue(
            actionRow({
              status: 'running',
              currentOutput: 'building…',
              lastOutput: 'old',
            }),
          ),
        },
      });

      const res = await readActionOutputTool.handler(
        { actionId: 1 } as never,
        ctx,
      );

      expect((res.data as any).output).toBe('building…');
      expect((res.data as any).source).toBe('live');
      expect(res.nextStep).toContain('poll_action_status');
    });
  });

  describe('poll_action_status', () => {
    it('returns straight away when the action is not running', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest.fn().mockResolvedValue(
            actionRow({
              status: 'success',
              lastExitCode: 0,
              lastOutput: 'done',
              lastRunAt: '2026-01-02T10:00:00.000Z',
              lastFinishedAt: '2026-01-02T10:00:05.000Z',
            }),
          ),
        },
      });

      const res = await pollActionStatusTool.handler(
        { actionId: 1 } as never,
        ctx,
      );

      expect(res.data).toMatchObject({
        status: 'success',
        exitCode: 0,
        stillRunning: false,
        durationSeconds: 5,
        outputTail: 'done',
      });
    });

    it('waits on the status event, then re-reads the settled row', async () => {
      const emitter = new EventEmitter();
      const findOne = jest
        .fn()
        .mockResolvedValueOnce(actionRow({ status: 'running' }))
        .mockResolvedValueOnce(actionRow({ status: 'running' }))
        .mockResolvedValue(
          actionRow({ status: 'failed', lastExitCode: 2, lastOutput: 'boom' }),
        );
      const actions = Object.assign(emitter, { findOne });
      const ctx = makeCtx({ actions });

      const pending = pollActionStatusTool.handler(
        { actionId: 1 } as never,
        ctx,
      );
      await waitForListener(emitter);
      emitter.emit('action-status-changed', {
        actionId: 1,
        status: 'failed',
        exitCode: 2,
      });

      const res = await pending;

      expect(res.data).toMatchObject({
        status: 'failed',
        exitCode: 2,
        stillRunning: false,
        outputTail: 'boom',
      });
      expect(emitter.listenerCount('action-status-changed')).toBe(0);
    });

    it('ignores status events for other actions', async () => {
      const emitter = new EventEmitter();
      const findOne = jest
        .fn()
        .mockResolvedValue(actionRow({ status: 'running' }));
      const ctx = makeCtx({ actions: Object.assign(emitter, { findOne }) });

      const pending = pollActionStatusTool.handler(
        { actionId: 1 } as never,
        ctx,
      );
      await waitForListener(emitter);
      emitter.emit('action-status-changed', { actionId: 2, status: 'success' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(emitter.listenerCount('action-status-changed')).toBe(1);

      // Unblock the pending promise so the test can finish deterministically.
      findOne.mockResolvedValue(
        actionRow({ status: 'success', lastExitCode: 0 }),
      );
      emitter.emit('action-status-changed', { actionId: 1, status: 'success' });
      await expect(pending).resolves.toMatchObject({
        data: expect.objectContaining({ stillRunning: false }),
      });
    });
  });

  describe('delete_action', () => {
    it('echoes the command so the deletion is reversible', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest
            .fn()
            .mockResolvedValue(actionRow({ id: 5, name: 'old' })),
          remove: jest.fn().mockResolvedValue({ success: true }),
        },
      });

      const res = await deleteActionTool.handler({ actionId: 5 }, ctx);

      expect(ctx.services.actions.remove).toHaveBeenCalledWith(5);
      expect(res.data).toMatchObject({
        actionId: 5,
        name: 'old',
        command: 'pnpm test',
        deleted: true,
      });
    });

    it('refuses a running action with a way out', async () => {
      const ctx = makeCtx({
        actions: {
          findOne: jest
            .fn()
            .mockResolvedValue(actionRow({ id: 5, status: 'running' })),
          remove: jest
            .fn()
            .mockRejectedValue(new Error('Action "test" is running')),
        },
      });

      await expect(
        deleteActionTool.handler({ actionId: 5 }, ctx),
      ).rejects.toMatchObject({
        code: 'action_delete_failed',
        remediation: expect.stringContaining('stop_action'),
      });
    });
  });
});
