import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../tool-registry/tool.types.js';
import { APP_TOOLS, startAppTool } from '../tools/apps/index.js';

const task = { id: 5, path: '/task', taskState: 'ready' };
const args = {
  requestId: randomUUID(),
  name: 'App',
  executable: 'my-app',
  args: ['one argument'],
  presentation: 'auto' as const,
};

function fixture(mode = 'bypassPermissions', planMode = false, unrestrictedTurn = mode === 'bypassPermissions') {
  const start = jest.fn(() => ({ runId: randomUUID() }));
  const request = jest.fn(() => ({ runId: randomUUID(), status: 'requested' }));
  const services = {
    actions: {
      appCommand: jest.fn(async () => ({
        executable: '/bin/sh',
        args: ['-lc', 'pnpm dev'],
        name: 'Dev',
        savedAction: { id: 9, command: 'pnpm dev' },
      })),
    },
    sessions: {
      findOne: jest.fn(async () => ({
        id: 7,
        workspaceId: 5,
        surface: 'session',
        activeAgentProvider: 'codex',
      })),
    },
    agentRuntime: {
      getProvider: () => ({
        nativeAppLaunchPolicy: () => planMode ? 'plan' : unrestrictedTurn ? 'launch' : 'request',
      }),
    },
    tasks: {
      record: async () => task,
      startApp: async (
        _session: number,
        _task: unknown,
        _launch: unknown,
        authorize: () => Promise<'launch' | 'request'>,
      ) => {
        return (await authorize()) === 'launch' ? start() : request();
      },
    },
  };
  const ctx = {
    services,
    agentSessionId: 7,
    signal: new AbortController().signal,
  } as unknown as ToolContext;
  return { ctx, start, request };
}

describe('task app launch authority', () => {
  it('restricts all run operations to authenticated callers', async () => {
    expect(APP_TOOLS.every((tool) => tool.requiresAgent)).toBe(true);
    const { ctx, start } = fixture();
    await expect(
      startAppTool.handler(args, { ...ctx, agentSessionId: null }),
    ).rejects.toMatchObject({ code: 'requires_agent_session' });
    await expect(
      startAppTool.handler({ ...args, taskId: 2 }, ctx),
    ).rejects.toMatchObject({ code: 'app_scope' });
    expect(start).not.toHaveBeenCalled();
  });
  it.each(['default', 'acceptEdits'])(
    'offers a human launch in %s mode without spawning',
    async (mode) => {
      const { ctx, start, request } = fixture(mode);
      await startAppTool.handler(args, ctx);
      expect(request).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
    },
  );
  it('supports a saved Action without overriding its stored command, including for restricted callers', async () => {
    const { ctx, start, request } = fixture('default');
    const action = {
      ...args,
      actionId: 9,
      args: [],
      name: undefined,
      executable: undefined,
    };
    await startAppTool.handler(action, ctx);
    expect(ctx.services.actions.appCommand).toHaveBeenCalledWith(
      task.id,
      task.path,
      9,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    await expect(
      startAppTool.handler({ ...action, args: ['override'] }, ctx),
    ).rejects.toMatchObject({ code: 'invalid_app' });
    await expect(
      startAppTool.handler({ ...action, executable: 'other' }, ctx),
    ).rejects.toMatchObject({ code: 'invalid_app' });
  });
  it('keeps a restricted turn on explicit approval after a permission setting changes', async () => {
    const { ctx, start, request } = fixture('bypassPermissions', false, false);
    await startAppTool.handler(args, ctx);
    expect(start).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects plan mode launches', async () => {
    const { ctx, start, request } = fixture('bypassPermissions', true);
    await expect(startAppTool.handler(args, ctx)).rejects.toMatchObject({
      code: 'app_launch_permissions',
    });
    expect(start).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('launches once and returns an app-scoped chat link', async () => {
    const { ctx, start } = fixture();
    expect(await startAppTool.handler(args, ctx)).toMatchObject({
      data: {
        openApp: expect.stringMatching(
          /^\[Open app\]\(elevenex-app:[a-f0-9-]{36}\)$/,
        ),
      },
    });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
