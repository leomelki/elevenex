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

  it('opens the OAuth authorization endpoint from metadata instead of the MCP url', async () => {
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

    const fetchMock = jest.spyOn(globalThis, 'fetch' as never).mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint: '/authorize',
      }),
    } as Response);

    await expect(service.startAuth(7, 'linear')).resolves.toEqual(
      expect.objectContaining({
        url: 'https://auth.example.com/authorize',
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/oauth-authorization-server',
      expect.objectContaining({
        headers: {
          accept: 'application/json',
        },
      }),
    );
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
