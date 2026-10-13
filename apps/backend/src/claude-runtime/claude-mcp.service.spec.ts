import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeMcpService } from './claude-mcp.service.js';
import type { ClaudeRuntimeService } from './claude-runtime.service.js';

jest.mock('./claude-runtime.service.js', () => ({
  ClaudeRuntimeService: class {},
}));

describe('Claude MCP SDK adapter', () => {
  let service: ClaudeMcpService;
  const runtime = {
    getMcpServerStatuses: jest.fn(),
    getMcpRuntimeState: jest.fn(),
    canReconnectMcpServers: jest.fn(),
    reconnectMcpServer: jest.fn(),
    startMcpAuthFlow: jest.fn(),
  };
  beforeEach(() => {
    jest.resetAllMocks();
    runtime.getMcpServerStatuses.mockResolvedValue([]);
    runtime.getMcpRuntimeState.mockReturnValue({
      sessionMetadata: null,
      contextUsage: null,
    });
    runtime.canReconnectMcpServers.mockReturnValue(true);
    service = new ClaudeMcpService(runtime as unknown as ClaudeRuntimeService);
  });
  const server = (status: McpServerStatus['status']): McpServerStatus => ({
    name: 'docs',
    status,
    scope: 'project',
    config: {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'secret' },
    },
    tools: [{ name: 'lookup' }],
  });

  it('uses live SDK status and tools without exposing credentials', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('connected')]);
    const snapshot = await service.getSnapshot(1);
    expect(snapshot.summary.connected).toBe(1);
    expect(snapshot.servers[0].tools).toEqual([
      { name: 'lookup', displayName: 'lookup' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(snapshot.servers[0].actions.canReauth).toBe(false);
  });

  it('reconnects the actual conversation connection before reporting status', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('connected')]);
    expect((await service.recheckServer(1, 'docs')).summary.connected).toBe(1);
    expect(runtime.reconnectMcpServer).toHaveBeenCalledWith(1, 'docs');
  });

  it('offers native browser authentication when the SDK reports needs-auth', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('needs-auth')]);
    runtime.startMcpAuthFlow.mockResolvedValue('https://example.com/authorize');
    expect(await service.startAuth(1, 'docs')).toMatchObject({
      url: 'https://example.com/authorize',
      serverName: 'docs',
    });
    expect(runtime.startMcpAuthFlow).toHaveBeenCalledWith(1, 'docs');
  });

  it('does not offer authentication for public connected servers', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('connected')]);
    await expect(service.startAuth(1, 'docs')).rejects.toThrow(
      'does not expose browser auth',
    );
    expect(runtime.startMcpAuthFlow).not.toHaveBeenCalled();
  });

  it('keeps SDK and plugin servers in the managed runtime scope', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([
      { ...server('connected'), source: 'plugin', scope: 'user' },
    ]);
    expect((await service.getSnapshot(1)).servers[0].scope).toBe('runtime');
  });

  it('avoids reconnect controls while a response is running', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('connected')]);
    runtime.canReconnectMcpServers.mockReturnValue(false);
    expect((await service.getSnapshot(1)).servers[0].actions.canRecheck).toBe(
      false,
    );
  });

  it('maps pending connections to unverified rather than failed', async () => {
    runtime.getMcpServerStatuses.mockResolvedValue([server('pending')]);
    expect((await service.getSnapshot(1)).servers[0].connectionStatus).toBe(
      'unknown',
    );
  });
});
