import { CodexMcpService } from './codex-mcp.service.js';
import type { SessionsService } from '../sessions/sessions.service.js';
import type { CodexAppServerClient } from './codex-app-server.js';

jest.mock('../sessions/sessions.service.js', () => ({
  SessionsService: class {},
}));
jest.mock('./codex-app-server.js', () => ({ CodexAppServerClient: class {} }));

describe('Codex MCP protocol adapter', () => {
  let client: { isRunning: boolean; request: jest.Mock };
  let service: CodexMcpService;
  beforeEach(() => {
    client = { isRunning: true, request: jest.fn() };
    service = new CodexMcpService(
      {
        findOne: () => Promise.resolve({ codexSessionId: 'thread-1' }),
      } as unknown as SessionsService,
      client as unknown as CodexAppServerClient,
    );
  });

  it('does not launch Codex to inspect a cold session', async () => {
    client.isRunning = false;
    expect((await service.getSnapshot(1)).servers).toHaveLength(0);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('pages through the thread inventory and uses live connection status', async () => {
    client.request
      .mockResolvedValueOnce({
        data: [
          {
            name: 'docs',
            runtimeStatus: 'connected',
            authStatus: 'unsupported',
            tools: { lookup: { name: 'lookup' } },
            resources: [],
          },
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: 'issues',
            runtimeStatus: 'authenticationRequired',
            authStatus: 'notLoggedIn',
            tools: {},
            resources: [],
          },
        ],
        nextCursor: null,
      });
    const snapshot = await service.getSnapshot(1);
    expect(snapshot.summary).toMatchObject({
      connected: 1,
      needsAuth: 1,
      total: 2,
    });
    expect(snapshot.servers[0].tools).toEqual([
      { name: 'lookup', displayName: 'lookup' },
    ]);
    expect(client.request).toHaveBeenLastCalledWith(
      'mcpServerStatus/list',
      { threadId: 'thread-1', cursor: 'next', limit: 100 },
      2000,
    );
  });

  it('returns the native OAuth authorization URL', async () => {
    client.request.mockResolvedValue({
      authorizationUrl: 'https://example.com/authorize',
    });
    expect(await service.startAuth(1, 'docs')).toMatchObject({
      serverName: 'docs',
      url: 'https://example.com/authorize',
      mode: 'external',
    });
    expect(client.request).toHaveBeenCalledWith(
      'mcpServer/oauth/login',
      { name: 'docs', threadId: 'thread-1' },
      30000,
    );
  });

  it('checks user servers against global inventory without a loaded thread', async () => {
    client.request
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ data: [], nextCursor: null });
    await service.recheckServer(1, 'docs', true);
    expect(client.request).toHaveBeenLastCalledWith(
      'mcpServerStatus/list',
      { serverName: 'docs', cursor: null, limit: 100 },
      2000,
    );
  });

  it('authenticates user servers without using a persisted cold thread id', async () => {
    client.request.mockResolvedValue({
      authorizationUrl: 'https://example.com/authorize',
    });
    await service.startAuth(1, 'docs', true);
    expect(client.request).toHaveBeenCalledWith(
      'mcpServer/oauth/login',
      { name: 'docs' },
      30000,
    );
  });

  it('reloads the native configuration without restarting the app server', async () => {
    client.request.mockResolvedValue({});
    await service.reloadConfiguration();
    expect(client.request).toHaveBeenCalledWith(
      'config/mcpServer/reload',
      {},
      15000,
    );
  });
});
