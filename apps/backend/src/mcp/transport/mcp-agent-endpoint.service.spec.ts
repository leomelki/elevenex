import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpAgentEndpointService } from './mcp-agent-endpoint.service.js';
import { ElevenexMcpHttpTransport } from './elevenex-mcp-http.transport.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import { elevenexMcpUrl } from '../session-tool-context.js';
import { ToolRegistryService } from '../tool-registry/tool-registry.service.js';
import { DeepLinkBuilder } from '../deep-link/deep-link.builder.js';
import { AgentHumanChannelService } from '../human-channel/human-channel.js';
import type { McpToolServices } from '../tool-registry/mcp-tool-services.js';
import type { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpServerFactory } from './mcp-server.factory.js';

// Keep database access mocked while exercising real discovery and tool dispatch.
jest.mock('../identity/mcp-agent-token.service.js', () => ({
  McpAgentTokenService: class {},
}));

describe('agent MCP endpoint for private-socket backends', () => {
  const previousEnvironment = {
    socket: process.env.ELEVENEX_DESKTOP_SOCKET,
    url: process.env.ELEVENEX_MCP_URL,
    port: process.env.ELEVENEX_PROXY_PORT,
  };
  let endpoint: McpAgentEndpointService;
  let transport: ElevenexMcpHttpTransport;
  let resolveSessionId: jest.Mock;
  const clients: Client[] = [];

  beforeEach(() => {
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/task-backend.sock';
    process.env.ELEVENEX_PROXY_PORT = '11111';
    delete process.env.ELEVENEX_MCP_URL;
    resolveSessionId = jest.fn((token?: string) =>
      Promise.resolve(token === 'current-token' ? 42 : null),
    );
    const services = {
      sessions: {
        findOne: () =>
          Promise.resolve({
            id: 42,
            workspaceId: 5,
            surface: 'session',
            status: 'idle',
          }),
      },
      tasks: {
        record: () =>
          Promise.resolve({ id: 5, taskState: 'ready', archivedAt: null }),
      },
      projects: { findOne: () => Promise.resolve({ name: 'Project' }) },
      repos: { findOne: () => Promise.resolve({ name: 'Repo' }) },
      browsers: {
        desktops: () => [],
        requestCode: () =>
          Promise.resolve({
            sandboxId: 'sandbox',
            value: 42,
            logs: [],
            images: [],
          }),
      },
    } as unknown as McpToolServices;
    const tokens = { resolveSessionId } as unknown as McpAgentTokenService;
    const cursors = new DeltaCursorStore();
    const connections = new McpConnectionRegistryService();
    const registry = new ToolRegistryService(
      services,
      cursors,
      new DeepLinkBuilder(),
      new AgentHumanChannelService(),
      tokens,
      connections,
      { invalidate: jest.fn() } as never,
    );
    transport = new ElevenexMcpHttpTransport(
      new McpServerFactory(registry),
      cursors,
      connections,
    );
    endpoint = new McpAgentEndpointService(transport, {
      resolveSessionId,
    } as unknown as McpAgentTokenService);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await endpoint.onModuleDestroy();
    await transport.onModuleDestroy();
    for (const [key, value] of Object.entries({
      ELEVENEX_DESKTOP_SOCKET: previousEnvironment.socket,
      ELEVENEX_MCP_URL: previousEnvironment.url,
      ELEVENEX_PROXY_PORT: previousEnvironment.port,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('connects HTTP agent clients to their own runtime instead of the legacy port', async () => {
    await Promise.all([endpoint.prepare(), endpoint.prepare()]);
    const url = elevenexMcpUrl();
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(new URL(url).port).not.toBe('11111');
    const client = new Client({ name: 'agent', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: 'Bearer current-token' } },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_current_session',
        'browser_run',
        'browser_reset',
        'browser_wait_user',
      ]),
    );
    expect(
      (await client.callTool({ name: 'get_current_session', arguments: {} }))
        .structuredContent,
    ).toMatchObject({ data: { sessionId: 42, taskId: 5 } });
    const guide = await client.callTool({ name: 'browser_run', arguments: {} });
    expect(guide.isError).not.toBe(true);
    expect(JSON.stringify(guide.structuredContent)).toContain(
      'browser.tabs.new',
    );
    const result = await client.callTool({
      name: 'browser_run',
      arguments: { code: 'return 42' },
    });
    expect(result.structuredContent).toMatchObject({ data: { value: 42 } });

    resolveSessionId.mockResolvedValue(null);
    await expect(client.listTools()).rejects.toThrow();
  });

  it('requires a current bearer token and rejects browser requests and all other backend routes', async () => {
    await endpoint.prepare();
    const url = elevenexMcpUrl();
    for (const path of [
      '/api/info',
      '/api/sessions',
      '/api/desktop-browser/runtime/tasks/1/frame',
      '/api/mcp/other',
    ]) {
      expect(
        (
          await fetch(new URL(path, url), {
            headers: { Authorization: 'Bearer current-token' },
          })
        ).status,
      ).toBe(404);
    }
    for (const headers of [
      {},
      { Authorization: 'Bearer other-runtime-token' },
    ]) {
      expect((await fetch(url, { headers })).status).toBe(401);
    }
    for (const headers of [
      { Origin: 'http://untrusted.test' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      expect(
        (
          await fetch(url, {
            headers: { ...headers, Authorization: 'Bearer current-token' },
          })
        ).status,
      ).toBe(403);
    }
  });

  it('closes its listener and clears its published URL on shutdown', async () => {
    await endpoint.prepare();
    const url = elevenexMcpUrl();
    await endpoint.onModuleDestroy();
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();
    await expect(fetch(url)).rejects.toThrow();
    await expect(endpoint.prepare()).rejects.toThrow('shutting down');
  });

  it('cleans up when shutdown interrupts listener startup', async () => {
    const preparing = endpoint.prepare();
    await endpoint.onModuleDestroy();
    await preparing;
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();
  });

  it('preserves legacy TCP defaults and explicitly configured MCP endpoints', async () => {
    delete process.env.ELEVENEX_DESKTOP_SOCKET;
    await endpoint.prepare();
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:11111/api/mcp');
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();

    endpoint = new McpAgentEndpointService(transport, {
      resolveSessionId,
    } as unknown as McpAgentTokenService);
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/task-backend.sock';
    process.env.ELEVENEX_MCP_URL = 'https://explicit.example/api/mcp';
    await endpoint.prepare();
    await endpoint.onModuleDestroy();
    expect(elevenexMcpUrl()).toBe('https://explicit.example/api/mcp');
  });
});
