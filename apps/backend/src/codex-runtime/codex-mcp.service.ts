import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { parse, stringify } from 'smol-toml';
import { SessionsService } from '../sessions/sessions.service.js';
import type {
  CodexMcpScope,
  CodexMcpServerEntry,
  CodexMcpSnapshot,
} from './codex-runtime.types.js';

type TomlRecord = Record<string, unknown>;
type CodexMcpServerConfig = {
  command?: string;
  args?: unknown;
  env?: unknown;
  env_vars?: unknown;
  cwd?: string;
  url?: string;
  bearer_token_env_var?: string;
  http_headers?: unknown;
  env_http_headers?: unknown;
  disabled?: boolean;
};

type ScopedServerConfig = {
  scope: CodexMcpScope;
  name: string;
  configLocation: string;
  config: CodexMcpServerConfig;
};

@Injectable()
export class CodexMcpService {
  constructor(private readonly sessionsService: SessionsService) {}

  async getSnapshot(sessionId: number): Promise<CodexMcpSnapshot> {
    const session = await this.sessionsService.findOne(sessionId);
    const userPath = this.getUserConfigPath();
    const projectPath = this.getProjectConfigPath(session.worktreePath);
    const [userConfig, projectConfig] = await Promise.all([
      this.readTomlFile(userPath),
      this.readTomlFile(projectPath),
    ]);
    const scoped = [
      ...this.collectServers('user', userPath, userConfig.data),
      ...this.collectServers('project', projectPath, projectConfig.data),
    ];
    const diagnostics = [
      this.fileDiagnostic('user', userPath, userConfig.error),
      this.fileDiagnostic('project', projectPath, projectConfig.error),
    ].filter((group) => group.errors.length || group.warnings.length);

    const servers = scoped
      .map((server) => this.toServerEntry(server))
      .sort((left, right) =>
        left.scope === right.scope
          ? left.name.localeCompare(right.name)
          : left.scope.localeCompare(right.scope),
      );

    return {
      servers,
      diagnostics,
      summary: {
        connected: servers.filter((server) => server.connectionStatus === 'connected').length,
        needsAuth: 0,
        failed: servers.filter((server) => server.connectionStatus === 'failed').length,
        disabled: servers.filter((server) => server.connectionStatus === 'disabled').length,
        malformed: servers.filter((server) => server.configStatus === 'error').length,
        total: servers.length,
      },
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async toggleServer(sessionId: number, serverName: string): Promise<CodexMcpSnapshot> {
    const server = await this.findServer(sessionId, serverName);
    const config = await this.readTomlFile(server.configLocation);
    const root = config.data ?? {};
    const mcpServers = ensureRecord(root, 'mcp_servers');
    const current = asRecord(mcpServers[server.name]) ?? {};
    current.disabled = !Boolean(current.disabled);
    mcpServers[server.name] = current;
    await this.writeTomlFile(server.configLocation, root);
    return this.getSnapshot(sessionId);
  }

  async recheckServer(sessionId: number, serverName?: string): Promise<CodexMcpSnapshot> {
    void serverName;
    return this.getSnapshot(sessionId);
  }

  async startAuth(): Promise<{ message: string }> {
    throw new BadRequestException(
      'Codex MCP authentication is handled by the Codex CLI or the server-specific environment variables.',
    );
  }

  private async findServer(
    sessionId: number,
    serverName: string,
  ): Promise<ScopedServerConfig> {
    const session = await this.sessionsService.findOne(sessionId);
    const candidates = [
      ...this.collectServers(
        'user',
        this.getUserConfigPath(),
        (await this.readTomlFile(this.getUserConfigPath())).data,
      ),
      ...this.collectServers(
        'project',
        this.getProjectConfigPath(session.worktreePath),
        (await this.readTomlFile(this.getProjectConfigPath(session.worktreePath))).data,
      ),
    ];
    const server = candidates.find((item) => item.name === serverName);
    if (!server) {
      throw new NotFoundException(`MCP server "${serverName}" not found.`);
    }
    return server;
  }

  private collectServers(
    scope: CodexMcpScope,
    configLocation: string,
    root: TomlRecord | null,
  ): ScopedServerConfig[] {
    const servers = asRecord(root?.mcp_servers);
    if (!servers) {
      return [];
    }

    return Object.entries(servers)
      .filter((entry): entry is [string, CodexMcpServerConfig] =>
        Boolean(entry[1]) && typeof entry[1] === 'object',
      )
      .map(([name, config]) => ({
        scope,
        name,
        configLocation,
        config,
      }));
  }

  private toServerEntry(server: ScopedServerConfig): CodexMcpServerEntry {
    const hasUrl = typeof server.config.url === 'string' && server.config.url.trim();
    const hasCommand =
      typeof server.config.command === 'string' && server.config.command.trim();
    const configStatus = hasUrl || hasCommand ? 'valid' : 'error';
    const transport = hasUrl ? 'http' : hasCommand ? 'stdio' : 'unknown';
    const disabled = Boolean(server.config.disabled);

    return {
      entryId: `codex:${server.scope}:${server.name}`,
      name: server.name,
      scope: server.scope,
      transport,
      configLocation: server.configLocation,
      enabled: !disabled,
      connectionStatus: disabled
        ? 'disabled'
        : configStatus === 'error'
          ? 'failed'
          : 'unknown',
      configStatus,
      error: configStatus === 'error' ? 'Codex MCP server needs a command or url.' : undefined,
      counts: { tools: 0, resources: 0, prompts: 0, loadedContextTools: 0 },
      actions: {
        canToggle: true,
        canRecheck: true,
        canAuth: false,
        canReauth: false,
        canViewTools: false,
      },
    };
  }

  private fileDiagnostic(scope: CodexMcpScope, configLocation: string, error: string | null) {
    return {
      scope,
      configLocation,
      errors: error ? [{ path: configLocation, message: error }] : [],
      warnings: [],
    };
  }

  private async readTomlFile(
    path: string,
  ): Promise<{ data: TomlRecord | null; error: string | null }> {
    try {
      const content = await fs.readFile(path, 'utf-8');
      return { data: parse(content) as TomlRecord, error: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { data: null, error: null };
      }
      return {
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async writeTomlFile(path: string, data: TomlRecord): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, stringify(data), 'utf-8');
  }

  private getUserConfigPath(): string {
    return join(homedir(), '.codex', 'config.toml');
  }

  private getProjectConfigPath(worktreePath: string): string {
    return join(worktreePath, '.codex', 'config.toml');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function ensureRecord(root: TomlRecord, key: string): Record<string, unknown> {
  const current = asRecord(root[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
}
