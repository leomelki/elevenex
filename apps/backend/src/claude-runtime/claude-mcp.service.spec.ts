import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSubagentMessages: jest.fn(),
  getSessionMessages: jest.fn(),
  query: jest.fn(),
}));
import { ClaudeMcpService } from './claude-mcp.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ClaudeRuntimeService } from './claude-runtime.service.js';

describe('ClaudeMcpService', () => {
  let service: ClaudeMcpService;
  let sessionsService: {
    findOne: jest.Mock;
  };
  let runtimeService: {
    getRuntimeState: jest.Mock;
    getPendingMcpAuthUrl: jest.Mock;
    startMcpAuthFlow: jest.Mock;
  };

  beforeEach(async () => {
    jest.restoreAllMocks();
    sessionsService = {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        worktreePath: '/tmp/project',
      }),
    };
    runtimeService = {
      getRuntimeState: jest.fn().mockResolvedValue({
        sessionMetadata: {
          mcpServers: [],
          tools: [],
          slashCommands: [],
        },
        contextUsage: {
          mcpTools: [],
        },
      }),
      getPendingMcpAuthUrl: jest.fn().mockReturnValue(null),
      startMcpAuthFlow: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeMcpService,
        { provide: SessionsService, useValue: sessionsService },
        { provide: ClaudeRuntimeService, useValue: runtimeService },
      ],
    }).compile();

    service = module.get(ClaudeMcpService);
  });

  it('only exposes auth when the server still needs auth', async () => {
    jest.spyOn(service as never, 'readJsonFile' as never).mockImplementation(async (path: string) => {
      if (path.endsWith('.claude.json')) {
        return {
          data: {
            mcpServers: {
              linear: {
                type: 'http',
                url: 'https://mcp.example.com',
                oauth: {
                  authServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
                },
              },
            },
          },
        };
      }
      return {};
    });

    jest.spyOn(service as never, 'getProbeStatus' as never).mockResolvedValue({
      status: 'connected',
      checkedAt: Date.now(),
    });

    const connectedSnapshot = await service.getSnapshot(7, true);
    expect(connectedSnapshot.servers[0]?.actions.canAuth).toBe(false);

    jest.spyOn(service as never, 'getProbeStatus' as never).mockResolvedValue({
      status: 'needs-auth',
      checkedAt: Date.now(),
    });

    const authRequiredSnapshot = await service.getSnapshot(7, true);
    expect(authRequiredSnapshot.servers[0]?.actions.canAuth).toBe(true);
  });

  it('opens the OAuth URL produced by Claude Code instead of the bare metadata endpoint', async () => {
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({
      servers: [
        {
          entryId: 'user:linear',
          name: 'linear',
          scope: 'user',
          transport: 'http',
          configLocation: '/tmp/.claude.json',
          enabled: true,
          connectionStatus: 'needs-auth',
          configStatus: 'valid',
          actions: {
            canToggle: true,
            canRecheck: true,
            canAuth: true,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
      diagnostics: [],
      summary: {
        connected: 0,
        needsAuth: 1,
        failed: 0,
        disabled: 0,
        malformed: 0,
        total: 1,
      },
      lastUpdatedAt: new Date().toISOString(),
    });

    jest.spyOn(service as never, 'findConfigByServerName' as never).mockResolvedValue({
      type: 'http',
      url: 'https://mcp.example.com',
      oauth: {
        authServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
      },
    });

    runtimeService.startMcpAuthFlow.mockResolvedValue(
      'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abc&code_challenge=pkce',
    );

    await expect(service.startAuth(7, 'linear')).resolves.toEqual(
      expect.objectContaining({
        url: 'https://auth.example.com/authorize?client_id=claude-code&redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback&state=abc&code_challenge=pkce',
      }),
    );

    expect(runtimeService.startMcpAuthFlow).toHaveBeenCalledWith(7, 'linear');
  });

  it('delegates auth URL generation to the runtime SDK helper', async () => {
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({
      servers: [
        {
          entryId: 'user:linear',
          name: 'linear',
          scope: 'user',
          transport: 'http',
          configLocation: '/tmp/.claude.json',
          enabled: true,
          connectionStatus: 'needs-auth',
          configStatus: 'valid',
          actions: {
            canToggle: true,
            canRecheck: true,
            canAuth: true,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
      diagnostics: [],
      summary: {
        connected: 0,
        needsAuth: 1,
        failed: 0,
        disabled: 0,
        malformed: 0,
        total: 1,
      },
      lastUpdatedAt: new Date().toISOString(),
    });

    jest.spyOn(service as never, 'findConfigByServerName' as never).mockResolvedValue({
      type: 'http',
      url: 'https://mcp.example.com',
    });
    runtimeService.startMcpAuthFlow.mockResolvedValue(
      'https://auth.example.com/authorize?client_id=claude-code&state=pending',
    );

    await expect(service.startAuth(7, 'linear')).resolves.toEqual(
      expect.objectContaining({
        url: 'https://auth.example.com/authorize?client_id=claude-code&state=pending',
      }),
    );
  });

  it('opens the Claude connectors page for claude.ai proxy servers', async () => {
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({
      servers: [
        {
          entryId: 'user:claude.ai github',
          name: 'claude.ai github',
          scope: 'user',
          transport: 'claudeai-proxy',
          configLocation: '/tmp/.claude.json',
          enabled: true,
          connectionStatus: 'needs-auth',
          configStatus: 'valid',
          actions: {
            canToggle: true,
            canRecheck: true,
            canAuth: true,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
      diagnostics: [],
      summary: {
        connected: 0,
        needsAuth: 1,
        failed: 0,
        disabled: 0,
        malformed: 0,
        total: 1,
      },
      lastUpdatedAt: new Date().toISOString(),
    });

    jest.spyOn(service as never, 'findConfigByServerName' as never).mockResolvedValue({
      type: 'claudeai-proxy',
      url: 'https://claude.ai/api/mcp/github',
    });

    await expect(service.startAuth(7, 'claude.ai github')).resolves.toEqual(
      expect.objectContaining({
        url: 'https://claude.ai/settings/connectors',
      }),
    );
    expect(runtimeService.startMcpAuthFlow).not.toHaveBeenCalled();
  });

  it('rejects auth start when there is no browser auth endpoint to open', async () => {
    jest.spyOn(service, 'getSnapshot').mockResolvedValue({
      servers: [
        {
          entryId: 'user:linear',
          name: 'linear',
          scope: 'user',
          transport: 'http',
          configLocation: '/tmp/.claude.json',
          enabled: true,
          connectionStatus: 'needs-auth',
          configStatus: 'valid',
          actions: {
            canToggle: true,
            canRecheck: true,
            canAuth: false,
            canReauth: false,
            canViewTools: false,
          },
        },
      ],
      diagnostics: [],
      summary: {
        connected: 0,
        needsAuth: 1,
        failed: 0,
        disabled: 0,
        malformed: 0,
        total: 1,
      },
      lastUpdatedAt: new Date().toISOString(),
    });

    jest.spyOn(service as never, 'findConfigByServerName' as never).mockResolvedValue({
      type: 'http',
      url: 'https://mcp.example.com',
    });

    await expect(service.startAuth(7, 'linear')).rejects.toBeInstanceOf(BadRequestException);
  });
});
