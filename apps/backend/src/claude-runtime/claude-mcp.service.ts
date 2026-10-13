import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpAuthStartResult,
  McpScope,
  McpServerEntry,
  McpSnapshot,
  McpTransport,
} from '../mcp/mcp.types.js';
import { ClaudeRuntimeService } from './claude-runtime.service.js';

/** Live SDK adapter. Configuration and persistence belong to the shared MCP manager. */
@Injectable()
export class ClaudeMcpService {
  constructor(private readonly runtimeService: ClaudeRuntimeService) {}

  async getSnapshot(
    sessionId: number,
    forceRefresh = false,
  ): Promise<McpSnapshot> {
    void forceRefresh;
    const statuses = await this.runtimeService.getMcpServerStatuses(sessionId);
    const { sessionMetadata, contextUsage } =
      this.runtimeService.getMcpRuntimeState(sessionId);
    const servers: McpServerEntry[] = statuses.map((server) => {
      const transport = this.transport(server);
      const prefix = `mcp__${server.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_')}__`;
      const names =
        server.tools?.map((tool) => tool.name) ??
        sessionMetadata?.tools.filter((name) => name.startsWith(prefix)) ??
        [];
      const tools = names.map((name) => ({
        name,
        displayName: (name.startsWith(prefix)
          ? name.slice(prefix.length)
          : name
        ).replace(/_/g, ' '),
      }));
      const canAuth = ['http', 'sse', 'claudeai-proxy'].includes(transport);
      const scope = this.scope(server);
      return {
        entryId: `claude:${scope}:${server.name}`,
        origin:
          server.source === 'sdk' || server.source === 'plugin'
            ? server.source
            : 'configuration',
        name: server.name,
        scope,
        transport,
        configLocation: 'Claude runtime',
        enabled: server.status !== 'disabled',
        connectionStatus:
          server.status === 'pending' ? 'unknown' : server.status,
        configStatus: 'valid',
        error: server.error,
        serverInfo: server.serverInfo,
        tools,
        counts: {
          tools: tools.length,
          resources: 0,
          prompts:
            sessionMetadata?.slashCommands.filter((name) =>
              name.startsWith(prefix),
            ).length ?? 0,
          loadedContextTools:
            contextUsage?.mcpTools.filter(
              (tool) => tool.serverName === server.name,
            ).length ?? 0,
        },
        actions: {
          canToggle: false,
          canRecheck:
            server.status !== 'disabled' &&
            this.runtimeService.canReconnectMcpServers(sessionId),
          canAuth: canAuth && server.status === 'needs-auth',
          canReauth:
            transport === 'claudeai-proxy' && server.status === 'connected',
          canViewTools: tools.length > 0,
        },
      };
    });
    return {
      servers,
      diagnostics: [],
      lastUpdatedAt: new Date().toISOString(),
      summary: {
        total: servers.length,
        connected: servers.filter((s) => s.connectionStatus === 'connected')
          .length,
        failed: servers.filter((s) => s.connectionStatus === 'failed').length,
        needsAuth: servers.filter((s) => s.connectionStatus === 'needs-auth')
          .length,
        disabled: servers.filter((s) => !s.enabled).length,
        malformed: 0,
      },
    };
  }

  async recheckServer(
    sessionId: number,
    serverName: string,
  ): Promise<McpSnapshot> {
    await this.runtimeService.reconnectMcpServer(sessionId, serverName);
    return this.getSnapshot(sessionId);
  }

  async startAuth(
    sessionId: number,
    serverName: string,
  ): Promise<McpAuthStartResult> {
    const server = (await this.getSnapshot(sessionId)).servers.find(
      (server) => server.name === serverName,
    );
    if (!server)
      throw new NotFoundException(`MCP server "${serverName}" not found.`);
    if (!server.actions.canAuth && !server.actions.canReauth)
      throw new BadRequestException(
        `MCP server "${serverName}" does not expose browser auth.`,
      );
    const url =
      server.transport === 'claudeai-proxy'
        ? 'https://claude.ai/settings/connectors'
        : await this.runtimeService.startMcpAuthFlow(sessionId, serverName);
    if (!url)
      throw new BadRequestException(
        `MCP server "${serverName}" did not provide an authorization URL.`,
      );
    return {
      serverName,
      url,
      mode: 'external',
      message:
        'Complete authentication in your browser, then check the server connection.',
    };
  }

  private transport(server: McpServerStatus): McpTransport {
    const type = server.config?.type;
    if (
      type === 'http' ||
      type === 'sse' ||
      type === 'claudeai-proxy' ||
      type === 'stdio'
    )
      return type;
    if (server.config && 'url' in server.config) return 'http';
    if (server.config && 'command' in server.config) return 'stdio';
    return 'unknown';
  }

  private scope(server: McpServerStatus): McpScope {
    if (server.source === 'sdk' || server.source === 'plugin') return 'runtime';
    if (server.scope === 'managed' || server.scope === 'enterprise')
      return 'enterprise';
    if (
      server.scope === 'user' ||
      server.scope === 'project' ||
      server.scope === 'local'
    )
      return server.scope;
    return 'runtime';
  }
}
