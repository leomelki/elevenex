import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { request } from 'node:http';
import { McpAgentEndpointService } from './mcp-agent-endpoint.service.js';
import { ElevenexMcpHttpTransport } from './elevenex-mcp-http.transport.js';
import type { McpServerFactory } from './mcp-server.factory.js';
import type { McpAgentTokenService } from '../identity/mcp-agent-token.service.js';
import { McpConnectionRegistryService } from '../connection/mcp-connection-registry.service.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';
import { elevenexMcpUrl } from '../session-tool-context.js';

// Exercise real HTTP/MCP, without loading unrelated domain/native services.
jest.mock('./mcp-server.factory.js', () => ({ McpServerFactory: class {} }));
jest.mock('../identity/mcp-agent-token.service.js', () => ({
  McpAgentTokenService: class {},
}));

describe('harness MCP endpoint for socket-only backends', () => {
  let endpoint: McpAgentEndpointService;
  let transport: ElevenexMcpHttpTransport;
  let clients: Client[];
  let tokens: {
    resolveSessionId: jest.Mock<Promise<number | null>, [string | undefined]>;
  };

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env });
    delete process.env.ELEVENEX_MCP_URL;
    process.env.ELEVENEX_DESKTOP_SOCKET = '/private/backend.sock';
    clients = [];
    tokens = {
      resolveSessionId: jest.fn((token: string | undefined) =>
        Promise.resolve(token === 'evx_test' ? 7 : null),
      ),
    };
    const factory = {
      create: () => {
        const server = new McpServer({ name: 'elevenex', version: '1' });
        server.registerTool('get_current_session', {}, async (extra) => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sessionId: await tokens.resolveSessionId(extra.authInfo?.token),
              }),
            },
          ],
        }));
        server.registerTool('create_task', {}, () =>
          Promise.resolve({ content: [] }),
        );
        return server;
      },
    };
    transport = new ElevenexMcpHttpTransport(
      factory as unknown as McpServerFactory,
      new DeltaCursorStore(),
      new McpConnectionRegistryService(),
    );
    endpoint = new McpAgentEndpointService(
      transport,
      tokens as unknown as McpAgentTokenService,
    );
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await endpoint.onModuleDestroy();
    await transport.onModuleDestroy();
    jest.restoreAllMocks();
  });

  async function connect() {
    const client = new Client({ name: 'harness-test', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(elevenexMcpUrl()), {
        requestInit: { headers: { Authorization: 'Bearer evx_test' } },
      }),
    );
    return client;
  }

  it('publishes an assigned loopback port and supports authenticated discovery and session identity', async () => {
    await Promise.all([endpoint.prepare(), endpoint.prepare()]);
    expect(elevenexMcpUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mcp$/);
    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'get_current_session',
      'create_task',
    ]);
    expect(
      await client.callTool({ name: 'get_current_session' }),
    ).toMatchObject({
      content: [{ type: 'text', text: '{"sessionId":7}' }],
    });
  });

  it('rejects missing, invalid and revoked credentials, including after initialization', async () => {
    await endpoint.prepare();
    for (const authorization of [undefined, 'Bearer invalid']) {
      const response = await fetch(elevenexMcpUrl(), {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      await response.text();
    }
    const client = await connect();
    tokens.resolveSessionId.mockResolvedValue(null);
    await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
  });

  it('does not expose API, terminal, or alternate MCP paths', async () => {
    await endpoint.prepare();
    const origin = new URL(elevenexMcpUrl()).origin;
    for (const path of [
      '/api/sessions',
      '/user-terminal',
      '/api/mcp/other',
      '/',
    ]) {
      const response = await fetch(`${origin}${path}`, {
        headers: { Authorization: 'Bearer evx_test' },
      });
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(tokens.resolveSessionId).not.toHaveBeenCalled();
  });

  it('rejects cross-origin browser and rebinding requests before authentication', async () => {
    await endpoint.prepare();
    for (const headers of [
      { Origin: 'https://untrusted.example' },
      { Host: 'untrusted.example' },
    ]) {
      // Fetch owns Host; raw HTTP lets this test send a rebinding hostname.
      const status = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(
            elevenexMcpUrl(),
            { headers: { ...headers, Authorization: 'Bearer evx_test' } },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
      expect(status).toBe(403);
    }
    expect(tokens.resolveSessionId).not.toHaveBeenCalled();
  });

  it('fails closed if token lookup fails without returning credentials', async () => {
    await endpoint.prepare();
    tokens.resolveSessionId.mockRejectedValue(
      new Error('private lookup error'),
    );
    const response = await fetch(elevenexMcpUrl(), {
      headers: { Authorization: 'Bearer evx_test' },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
  });

  it('preserves explicit URLs without opening a listener', async () => {
    process.env.ELEVENEX_MCP_URL = ' https://mcp.example/api/mcp ';
    await endpoint.prepare();
    expect(elevenexMcpUrl()).toBe('https://mcp.example/api/mcp');
    await endpoint.onModuleDestroy();
    expect(process.env.ELEVENEX_MCP_URL).toBe(' https://mcp.example/api/mcp ');
  });

  it('preserves the legacy TCP endpoint and configured proxy port', async () => {
    delete process.env.ELEVENEX_DESKTOP_SOCKET;
    process.env.ELEVENEX_PROXY_PORT = '12345';
    await endpoint.prepare();
    expect(elevenexMcpUrl()).toBe('http://127.0.0.1:12345/api/mcp');
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();
  });

  it('shuts down with an open SSE client and removes its published URL', async () => {
    await endpoint.prepare();
    await connect();
    const url = elevenexMcpUrl();
    await endpoint.onModuleDestroy();
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();
    await expect(fetch(url)).rejects.toThrow();
    await expect(endpoint.prepare()).rejects.toThrow('shutting down');
  });

  it('cleans up when shutdown races startup and does not overwrite later configuration', async () => {
    await Promise.all([endpoint.prepare(), endpoint.onModuleDestroy()]);
    expect(process.env.ELEVENEX_MCP_URL).toBeUndefined();
    endpoint = new McpAgentEndpointService(
      transport,
      tokens as unknown as McpAgentTokenService,
    );
    await endpoint.prepare();
    process.env.ELEVENEX_MCP_URL = 'https://replacement.example/mcp';
    await endpoint.onModuleDestroy();
    expect(process.env.ELEVENEX_MCP_URL).toBe(
      'https://replacement.example/mcp',
    );
  });
});
