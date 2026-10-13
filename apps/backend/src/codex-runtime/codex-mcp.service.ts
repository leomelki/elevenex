import { Injectable } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service.js';
import { CodexAppServerClient } from './codex-app-server.js';
import type { CodexMcpSnapshot } from './codex-runtime.types.js';

interface McpStatus {
  name: string;
  runtimeStatus?: string | null;
  authStatus: string;
  tools: Record<string, { name?: string; title?: string }>;
  toolsError?: string | null;
  resources: unknown[];
  resourceTemplates: unknown[];
  serverInfo?: { name: string; version: string } | null;
}

/** Live protocol adapter. Native configuration belongs to the shared MCP manager. */
@Injectable()
export class CodexMcpService {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly appServer: CodexAppServerClient,
  ) {}

  async getSnapshot(
    sessionId: number,
    globalServerName?: string,
  ): Promise<CodexMcpSnapshot> {
    const servers: CodexMcpSnapshot['servers'] = [];
    if (this.appServer.isRunning || globalServerName) {
      const session = await this.sessionsService.findOne(sessionId);
      const threadId = session.codexSessionId;
      if (threadId || globalServerName) {
        let cursor: string | null = null;
        do {
          const page: { data: McpStatus[]; nextCursor: string | null } =
            await this.appServer.request(
              'mcpServerStatus/list',
              {
                ...(globalServerName
                  ? { serverName: globalServerName }
                  : { threadId }),
                cursor,
                limit: 100,
              },
              2_000,
            );
          for (const item of page.data) {
            const tools = Object.entries(item.tools ?? {}).map(
              ([key, tool]) => ({
                name: tool.name ?? key,
                displayName: tool.title ?? tool.name ?? key,
              }),
            );
            const status = item.runtimeStatus;
            const connectionStatus =
              status === 'authenticationRequired'
                ? 'needs-auth'
                : ['connected', 'failed', 'disabled'].includes(status ?? '')
                  ? (status as 'connected' | 'failed' | 'disabled')
                  : 'unknown';
            servers.push({
              entryId: `codex:runtime:${item.name}`,
              name: item.name,
              scope: globalServerName ? 'user' : 'runtime',
              transport: 'unknown',
              configLocation: 'Codex runtime',
              enabled: status !== 'disabled',
              connectionStatus,
              configStatus: 'valid',
              error: item.toolsError ?? undefined,
              serverInfo: item.serverInfo ?? undefined,
              tools,
              counts: {
                tools: tools.length,
                resources: item.resources?.length ?? 0,
                prompts: 0,
                loadedContextTools: tools.length,
              },
              actions: {
                canToggle: false,
                canRecheck: true,
                canAuth: item.authStatus === 'notLoggedIn',
                canReauth: item.authStatus === 'oAuth',
                canViewTools: tools.length > 0,
              },
            });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
    }
    return {
      servers,
      diagnostics: [],
      summary: {
        connected: servers.filter((s) => s.connectionStatus === 'connected')
          .length,
        needsAuth: servers.filter((s) => s.connectionStatus === 'needs-auth')
          .length,
        failed: servers.filter((s) => s.connectionStatus === 'failed').length,
        disabled: servers.filter((s) => !s.enabled).length,
        malformed: 0,
        total: servers.length,
      },
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async reloadConfiguration(): Promise<void> {
    if (this.appServer.isRunning)
      await this.appServer.request('config/mcpServer/reload', {}, 15_000);
  }

  async recheckServer(
    sessionId: number,
    serverName: string,
    userScope = false,
  ): Promise<CodexMcpSnapshot> {
    await this.reloadConfiguration();
    return this.getSnapshot(sessionId, userScope ? serverName : undefined);
  }

  async startAuth(sessionId: number, serverName: string, userScope = false) {
    const session = await this.sessionsService.findOne(sessionId);
    const result = await this.appServer.request<{ authorizationUrl: string }>(
      'mcpServer/oauth/login',
      {
        name: serverName,
        ...(!userScope && session.codexSessionId
          ? { threadId: session.codexSessionId }
          : {}),
      },
      30_000,
    );
    return {
      serverName,
      url: result.authorizationUrl,
      authUrl: result.authorizationUrl,
      mode: 'external' as const,
      message: 'Authorize this MCP server, then check its connection.',
    };
  }
}
