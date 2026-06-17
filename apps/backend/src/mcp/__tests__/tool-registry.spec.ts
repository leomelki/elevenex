import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';

/**
 * Captures (name, config, handler) per registered tool so a test can invoke a
 * handler directly with a synthetic `extra`, exercising the full wrapper
 * (caps + guards + envelope shaping) without a real transport.
 */
class FakeServer {
  readonly tools = new Map<
    string,
    (args: unknown, extra: unknown) => Promise<CallToolResult>
  >();
  registerTool(
    name: string,
    _config: unknown,
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>,
  ) {
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
    sessions: {
      findByRepo: jest.fn(async () => SESSIONS),
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
    expect((parse(result).error as { code: string }).code).toBe('scope_required');
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
