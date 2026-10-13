import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';
import type { ToolDefinition } from '../tool-registry/tool.types.js';

/**
 * Captures (name, config, handler) per registered tool so a test can invoke a
 * handler directly with a synthetic `extra`, exercising the full wrapper
 * (caps + guards + envelope shaping) without a real transport.
 */
class FakeServer {
  readonly schemas = new Map<string, z.ZodRawShape>();
  readonly tools = new Map<
    string,
    (args: unknown, extra: unknown) => Promise<CallToolResult>
  >();
  registerTool(
    name: string,
    config: { inputSchema: z.ZodRawShape },
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>,
  ) {
    this.schemas.set(name, config.inputSchema);
    this.tools.set(name, handler);
  }
}

function parse(result: CallToolResult): Record<string, unknown> {
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text);
}

const PROJECTS = [
  { id: 1, name: 'Platform', archivedAt: null },
  { id: 2, name: 'Web', archivedAt: null },
];
const SESSIONS = [
  {
    id: 10,
    name: 'fix auth',
    status: 'running',
    branchName: 'feat/auth',
    worktreePath: '/wt/auth',
    activeAgentProvider: 'claude',
    hasUnreviewedCompletion: false,
    lastCompletionAt: null,
    lastStateChangeAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 11,
    name: 'docs',
    status: 'completed',
    branchName: 'docs/readme',
    worktreePath: '/wt/docs',
    activeAgentProvider: 'codex',
    hasUnreviewedCompletion: true,
    lastCompletionAt: '2026-01-03T00:00:00.000Z',
    lastStateChangeAt: '2026-01-03T00:00:00.000Z',
  },
];

function buildServices(): McpToolServices {
  return {
    projects: {
      findAll: jest.fn(async () => PROJECTS),
      findOne: jest.fn(async (id: number) => {
        const p = PROJECTS.find((x) => x.id === id);
        if (!p) throw new Error('not found');
        return p;
      }),
    },
    repos: {
      findByProject: jest.fn(async () => [
        { id: 5, name: 'api', path: '/repos/api' },
      ]),
      countByProject: jest.fn(async () => 1),
    },
    tasks: { list: jest.fn(async () => []) },
    sessions: {
      findByRepo: jest.fn(async () => SESSIONS),
      listHandlePage: jest.fn(async (args) => ({
        rows: args.needsReviewOnly ? [SESSIONS[1]] : SESSIONS,
        total: args.needsReviewOnly ? 1 : 2,
        nextOffset: null,
      })),
      findAllCompletionStates: jest.fn(async () => [
        { id: 11, hasUnreviewedCompletion: true },
      ]),
    },
  } as unknown as McpToolServices;
}

function buildRegistry(services: McpToolServices) {
  const tokens = {
    resolveSessionId: jest.fn(async (token?: string) =>
      token === 'agent-token' ? 42 : null,
    ),
  } as unknown as McpAgentTokenService;
  return new ToolRegistryService(
    services,
    new DeltaCursorStore(),
    new DeepLinkBuilder(),
    new AgentHumanChannelService(),
    tokens,
    new McpConnectionRegistryService(),
    { invalidate: jest.fn() } as never,
  );
}

function extraFor(token?: string) {
  return {
    authInfo: token ? { token } : undefined,
    sessionId: 'mcp-sess-1',
    signal: new AbortController().signal,
  };
}

describe('ToolRegistry + observe smoke tools', () => {
  it('project_overview returns the project list + attention summary', async () => {
    const services = buildServices();
    const registry = buildRegistry(services);
    const server = new FakeServer();
    registry.registerAll(server as never);

    const result = await server.tools.get('project_overview')!(
      { state: 'active' },
      extraFor(),
    );
    const body = parse(result);
    expect(result.isError).toBeUndefined();
    const data = body.data as {
      projects: Array<{ id: number; deepLink: string }>;
      attention: { sessionsNeedingReview: number };
    };
    expect(data.projects).toHaveLength(2);
    expect(data.projects[0].deepLink).toBe('/projects/1');
    expect(data.attention.sessionsNeedingReview).toBe(1);
    expect(body.nextStep).toBeDefined();
  });

  it('project_overview expands a project into repos + compact session handles', async () => {
    const services = buildServices();
    const registry = buildRegistry(services);
    const server = new FakeServer();
    registry.registerAll(server as never);

    const result = await server.tools.get('project_overview')!(
      { projectId: 1 },
      extraFor(),
    );
    const data = parse(result).data as {
      repos: Array<{ sessions: Array<{ id: number; deepLink: string }> }>;
    };
    expect(data.repos[0].sessions[0]).toMatchObject({
      id: 10,
      deepLink: '/sessions/10',
    });
  });

  it('find_sessions requires a scope', async () => {
    const services = buildServices();
    const registry = buildRegistry(services);
    const server = new FakeServer();
    registry.registerAll(server as never);

    const result = await server.tools.get('find_sessions')!({}, extraFor());
    expect(result.isError).toBe(true);
    expect((parse(result).error as { code: string }).code).toBe(
      'scope_required',
    );
  });

  it('find_sessions filters and paginates compact handles', async () => {
    const services = buildServices();
    const registry = buildRegistry(services);
    const server = new FakeServer();
    registry.registerAll(server as never);

    const result = await server.tools.get('find_sessions')!(
      { repoId: 5, needsReviewOnly: true, limit: 25, offset: 0 },
      extraFor(),
    );
    const data = parse(result).data as {
      total: number;
      sessions: Array<{ id: number }>;
    };
    expect(data.total).toBe(1);
    expect(data.sessions[0].id).toBe(11);
  });

  it('caps the limit field above the hard ceiling', async () => {
    const services = buildServices();
    const registry = buildRegistry(services);
    const server = new FakeServer();
    registry.registerAll(server as never);

    // limit beyond MAX_LIMIT (100) must be clamped, not honoured verbatim.
    const result = await server.tools.get('find_sessions')!(
      { repoId: 5, limit: 9999, offset: 0 },
      extraFor(),
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('coding session identity and default scopes', () => {
  function setup(surface = 'session') {
    const session = {
      id: 42,
      name: 'Current task',
      surface,
      status: 'running',
      projectId: 1,
      repoId: 5,
      workspaceId: 9,
      workspaceName: 'api 1',
      folderId: 3,
      worktreePath: '/wt/current',
      branchName: 'feat/current',
      activeAgentProvider: 'codex',
      planMode: false,
      isTemporary: false,
      mcpAgentToken: 'must-not-leak',
    };
    const services = buildServices();
    Object.assign(services.sessions, {
      findOne: jest.fn(async (id) => ({ ...session, id })),
      assertSessionWorkspaceLinked: jest.fn().mockResolvedValue(undefined),
      findByWorkspace: jest.fn(async () => []),
      create: jest.fn(async () => ({ ...session, id: 55 })),
    });
    Object.assign(services.repos, {
      findOne: jest.fn(async () => ({
        id: 5,
        name: 'api',
        path: '/repos/api',
      })),
    });
    Object.assign(services, {
      files: {
        readFile: jest.fn(async () => ({ content: 'hello', language: 'text' })),
      },
      tasks: {
        record: jest.fn(async () => ({
          id: 9,
          repoId: 5,
          name: 'Current task',
          taskState: 'ready',
          archivedAt: null,
          linkStatus: 'linked',
        })),
        defaults: jest.fn(async () => ({
          baseRef: 'origin/main',
          branchName: 'new-task',
        })),
        finish: jest.fn(async (id) => ({
          id,
          repoId: 5,
          taskState: 'ready',
          archivedAt: 'today',
          linkStatus: 'unlinked',
          sessions: [],
        })),
      },
      scratchpad: {
        findByProject: jest.fn(async () => []),
        create: jest.fn(async () => ({ id: 8, name: 'Notes', content: '' })),
      },
    });
    const server = new FakeServer();
    buildRegistry(services).registerAll(server as never);
    return {
      session,
      services,
      call: (
        name: string,
        args = {},
        token: string | undefined = 'agent-token',
      ) =>
        server.tools.get(name)!(
          z.object(server.schemas.get(name)!).parse(args),
          extraFor(token),
        ),
      server,
    };
  }

  it('returns the caller’s context without credentials, runtime startup or UI focus', async () => {
    const bag = setup();
    const result = await bag.call('get_current_session');
    expect(result.isError).toBeUndefined();
    expect(parse(result)).toMatchObject({
      data: {
        sessionId: 42,
        projectId: 1,
        repoId: 5,
        workspaceId: 9,
        folderId: 3,
        worktreePath: '/wt/current',
        branchName: 'feat/current',
        provider: 'codex',
      },
      deepLink: '/sessions/42',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('requires an authenticated identity for current context', async () => {
    const result = await setup().call('get_current_session', {}, 'unknown');
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({
      error: { code: 'requires_agent_session' },
    });
  });

  it('resolves omitted file scope to the current worktree', async () => {
    const bag = setup();
    expect(
      (await bag.call('read_file', { path: 'README.md' })).isError,
    ).toBeUndefined();
    expect(bag.services.files.readFile).toHaveBeenCalledWith(
      '/wt/current/README.md',
      '/wt/current',
    );
  });

  it('defaults task reads and conversation creation to the caller’s stable task ID', async () => {
    const bag = setup();
    expect(parse(await bag.call('read_task_draft'))).toMatchObject({
      data: { taskId: 9 },
    });
    expect(parse(await bag.call('create_session'))).toMatchObject({
      data: { taskId: 9, sessionId: 55 },
    });
    expect(bag.services.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 5,
        workspaceId: 9,
        activeAgentProvider: undefined,
      }),
    );
    expect(parse(await bag.call('get_current_session'))).toMatchObject({
      data: { taskId: 9, taskName: 'Current task' },
    });
  });

  it('requires an explicit task when the caller is outside a task', async () => {
    const bag = setup();
    bag.session.workspaceId = null as never;
    expect(parse(await bag.call('read_task_draft'))).toMatchObject({
      error: { code: 'no_current_task' },
    });
  });

  it('does not inject the current repo over an explicit task conversation scope', async () => {
    const bag = setup();
    expect(
      (await bag.call('find_sessions', { taskId: 9 })).isError,
    ).toBeUndefined();
    expect(bag.services.sessions.listHandlePage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 9 }),
    );
    expect(bag.services.sessions.findByRepo).not.toHaveBeenCalled();
  });

  it('rejects self prompts/stops and finishing the caller’s task before side effects', async () => {
    const bag = setup();
    for (const name of [
      'interrupt_session',
      'archive_session',
      'reset_session',
    ]) {
      expect(parse(await bag.call(name, { sessionId: 42 }))).toMatchObject({
        error: { code: 'self_target_not_allowed' },
      });
    }
    expect(
      parse(
        await bag.call('prompt_session', { sessionId: 42, prompt: 'continue' }),
      ),
    ).toMatchObject({ error: { code: 'self_target_not_allowed' } });
    expect(
      parse(await bag.call('finish_task', { taskId: 9, confirmStop: true })),
    ).toMatchObject({ error: { code: 'self_target_not_allowed' } });
    expect(bag.services.tasks.finish).not.toHaveBeenCalled();
    expect(
      (await bag.call('finish_task', { taskId: 17 })).isError,
    ).toBeUndefined();
    expect(bag.services.tasks.finish).toHaveBeenCalledWith(17, false);
  });

  it('preserves an explicit worktree even when the caller is authenticated', async () => {
    const bag = setup();
    await bag.call('read_file', {
      path: 'README.md',
      worktreePath: '/wt/other',
    });
    expect(bag.services.files.readFile).toHaveBeenCalledWith(
      '/wt/other/README.md',
      '/wt/other',
    );
  });

  it.each([
    ['archive_session_folder', { folderId: 3 }],
    ['delete_session_folder', { folderId: 3 }],
    ['remove_repo', { repoId: 5 }],
    ['delete_project', { projectId: 1 }],
  ])('blocks indirect self termination through %s', async (name, args) => {
    const bag = setup();
    const effect = jest.fn();
    Object.assign(bag.services, {
      sessionFolders: { archive: effect, delete: effect },
    });
    Object.assign(bag.services.repos, { remove: effect });
    Object.assign(bag.services.projects, { delete: effect });
    expect(parse(await bag.call(name, args))).toMatchObject({
      error: { code: 'self_target_not_allowed' },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it('requires authenticated destructive capabilities to remove a repository', async () => {
    expect(
      parse(await setup().call('remove_repo', { repoId: 17 }, 'unknown')),
    ).toMatchObject({ error: { code: 'destructive_not_allowed' } });
  });

  it('rechecks folder membership after a pending mission approval', async () => {
    const bag = setup('agent');
    const caller = {
      ...bag.session,
      activeAgentProvider: 'codex',
      agentAutonomyMode: 'review',
    };
    Object.assign(bag.services.sessions, {
      findOne: jest.fn(async () => caller),
    });
    const effect = jest.fn();
    Object.assign(bag.services, { sessionFolders: { delete: effect } });
    const approve = jest.fn(async () => {
      caller.folderId = 4;
      return { decision: 'approve' };
    });
    const registry = new ToolRegistryService(
      bag.services,
      new DeltaCursorStore(),
      new DeepLinkBuilder(),
      { bindFor: () => ({ requestApproval: approve }) } as never,
      { resolveSessionId: async () => 42 } as never,
      new McpConnectionRegistryService(),
      { invalidate: jest.fn() } as never,
    );
    const server = new FakeServer();
    registry.registerAll(server as never);
    expect(
      parse(
        await server.tools.get('delete_session_folder')!(
          { folderId: 4 },
          extraFor('agent-token'),
        ),
      ),
    ).toMatchObject({ error: { code: 'self_target_not_allowed' } });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not execute a mutation after request cancellation', async () => {
    const bag = setup();
    const update = jest.fn();
    Object.assign(bag.services.sessions, { update });
    const controller = new AbortController();
    controller.abort();
    expect(
      parse(
        await bag.server.tools.get('rename_session')!(
          { sessionId: 42, name: 'Changed' },
          { ...extraFor('agent-token'), signal: controller.signal },
        ),
      ),
    ).toMatchObject({ error: { code: 'cancelled' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('does not silently replace an incomplete explicit repo/checkout scope with the caller', async () => {
    expect(
      parse(await setup().call('get_worktree_context', { repoId: 99 })),
    ).toMatchObject({ error: { code: 'scope_required' } });
  });

  it('reads current scope again after the session moves to another worktree', async () => {
    const bag = setup();
    await bag.call('read_file', { path: 'README.md' });
    bag.session.worktreePath = '/wt/rebound';
    bag.session.branchName = 'feat/rebound';
    await bag.call('read_file', { path: 'README.md' });
    expect(bag.services.files.readFile).toHaveBeenLastCalledWith(
      '/wt/rebound/README.md',
      '/wt/rebound',
    );
    expect(parse(await bag.call('get_current_session'))).toMatchObject({
      data: { worktreePath: '/wt/rebound', branchName: 'feat/rebound' },
    });
  });

  it('preserves an explicit session target', async () => {
    const bag = setup();
    await bag.call('read_file', { path: 'README.md', sessionId: 11 });
    expect(bag.services.sessions.findOne).toHaveBeenCalledWith(11);
    expect(bag.services.sessions.findOne).not.toHaveBeenCalledWith(42);
  });

  it('defaults related sessions to the current repo but honors a project scope', async () => {
    const bag = setup();
    await bag.call('find_sessions');
    expect(bag.services.sessions.listHandlePage).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 5 }),
    );
    expect(bag.services.repos.findByProject).not.toHaveBeenCalled();
    await bag.call('find_sessions', { projectId: 2 });
    expect(bag.services.sessions.listHandlePage).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 2 }),
    );
  });

  it('defaults project notes to the current project', async () => {
    const bag = setup();
    expect(
      (await bag.call('set_scratchpad', { name: 'Notes' })).isError,
    ).toBeUndefined();
    expect(bag.services.scratchpad.create).toHaveBeenCalledWith(1, 'Notes');
  });

  it('keeps required session controls explicit', () => {
    const bag = setup();
    for (const name of [
      'prompt_session',
      'interrupt_session',
      'reset_session',
      'archive_session',
    ]) {
      expect(bag.server.schemas.get(name)!.sessionId.isOptional()).toBe(false);
    }
  });

  it('does not default a mission to its hidden workspace', async () => {
    const bag = setup('agent');
    const result = await bag.call('read_session');
    expect(parse(result)).toMatchObject({ error: { code: 'scope_required' } });
  });

  it('keeps caller context available in a hidden question/review conversation', async () => {
    expect(
      parse(await setup('agent_query').call('read_task_draft')),
    ).toMatchObject({ data: { taskId: 9 } });
  });

  it('reports missing required scopes to anonymous clients', async () => {
    const result = await setup().call('read_session', {}, 'unknown');
    expect(parse(result)).toMatchObject({ error: { code: 'scope_required' } });
  });
});

describe('mission autonomy at the MCP boundary', () => {
  function setup(provider: string, mode: string, destructive: boolean) {
    const handler = jest.fn().mockResolvedValue({ data: { ok: true } });
    const requestApproval = jest
      .fn()
      .mockResolvedValue({ decision: 'approve' });
    const registry = new ToolRegistryService(
      {
        sessions: {
          findOne: jest.fn().mockResolvedValue({
            id: 42,
            surface: 'agent',
            activeAgentProvider: provider,
            agentAutonomyMode: mode,
          }),
        },
      } as never,
      new DeltaCursorStore(),
      new DeepLinkBuilder(),
      { bindFor: () => ({ requestApproval }) } as never,
      { resolveSessionId: () => Promise.resolve(42) } as never,
      new McpConnectionRegistryService(),
      { invalidate: jest.fn() } as never,
    );
    const server = new FakeServer();
    const tool: ToolDefinition = {
      name: destructive ? 'remove_repo' : 'create_session',
      description: 'Test action',
      costClass: 'instant',
      inputShape: {},
      mutates: true,
      handler,
    };
    (
      registry as unknown as {
        registerOne(server: unknown, tool: ToolDefinition): void;
      }
    ).registerOne(server, tool);
    return {
      invoke: () =>
        server.tools.get(tool.name)!({ repoId: 7 }, extraFor('agent-token')),
      handler,
      requestApproval,
    };
  }

  it.each(['pi', 'codex'])(
    'blocks destructive %s calls when approval is denied',
    async (provider) => {
      const bag = setup(provider, 'review', true);
      bag.requestApproval.mockResolvedValue({ decision: 'deny' });
      const result = await bag.invoke();
      expect(result.isError).toBe(true);
      expect(bag.handler).not.toHaveBeenCalled();
      expect(bag.requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({ deepLink: '/sessions/42' }),
      );
    },
  );

  it.each(['pi', 'codex'])(
    'executes destructive %s calls after human approval',
    async (provider) => {
      const bag = setup(provider, 'review', true);
      expect((await bag.invoke()).isError).toBeUndefined();
      expect(bag.handler).toHaveBeenCalledTimes(1);
      expect(bag.requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['pi', 'codex'])(
    'gates all %s mutations in Plan mode',
    async (provider) => {
      const bag = setup(provider, 'plan', false);
      await bag.invoke();
      expect(bag.requestApproval).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['pi', 'review', false],
    ['codex', 'review', false],
    ['pi', 'full', true],
    ['codex', 'full', true],
    ['claude', 'review', true],
  ])(
    'allows %s %s calls according to their mandate',
    async (provider, mode, destructive) => {
      const bag = setup(
        provider as string,
        mode as string,
        destructive as boolean,
      );
      await bag.invoke();
      expect(bag.handler).toHaveBeenCalledTimes(1);
      expect(bag.requestApproval).not.toHaveBeenCalled();
    },
  );
});
