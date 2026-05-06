import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { SessionsService } from '../sessions/sessions.service.js';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import {
  ClaudeContextUsage,
  ClaudeMcpAuthStartResult,
  ClaudeMcpConfigStatus,
  ClaudeMcpConnectionStatus,
  ClaudeMcpDiagnosticGroup,
  ClaudeMcpDiagnosticMessage,
  ClaudeMcpScope,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
  ClaudeMcpTransport,
  ClaudeRuntimeSessionMetadata,
} from './claude-runtime.types.js';
import { ClaudeRuntimeService } from './claude-runtime.service.js';

const execFile = promisify(execFileCallback);
const CLAUDE_BIN = findBinary('claude') ?? 'claude';
const PROBE_TTL_MS = 30_000;
const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

type JsonRecord = Record<string, unknown>;

type McpServerConfigLike = {
  type?: string;
  command?: string;
  args?: unknown;
  url?: string;
  oauth?: {
    authServerMetadataUrl?: string;
    authorizationUrl?: string;
    authorizationEndpoint?: string;
    authUrl?: string;
  };
};

type ScopedServerConfig = {
  scope: ClaudeMcpScope;
  name: string;
  configLocation: string;
  enabled: boolean;
  configStatus: ClaudeMcpConfigStatus;
  warnings: ClaudeMcpDiagnosticMessage[];
  errors: ClaudeMcpDiagnosticMessage[];
  transport: ClaudeMcpTransport;
  config: McpServerConfigLike;
};

type ProbeResult = {
  status: ClaudeMcpConnectionStatus;
  error?: string;
  checkedAt: number;
};

type ProjectConfig = {
  mcpServers?: Record<string, McpServerConfigLike>;
  disabledMcpServers?: string[];
  enabledMcpServers?: string[];
};

type GlobalConfig = {
  mcpServers?: Record<string, McpServerConfigLike>;
  projects?: Record<string, ProjectConfig>;
};

@Injectable()
export class ClaudeMcpService {
  private readonly probeCache = new Map<string, ProbeResult>();

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly runtimeService: ClaudeRuntimeService,
  ) {}

  async getSnapshot(sessionId: number, forceRefresh = false): Promise<ClaudeMcpSnapshot> {
    const session = await this.sessionsService.findOne(sessionId);
    const [globalConfigResult, projectFileResult, enterpriseResult] =
      await Promise.all([
        this.readJsonFile<GlobalConfig>(this.getGlobalConfigPath()),
        this.readJsonFile<{ mcpServers?: Record<string, McpServerConfigLike> }>(
          join(session.worktreePath, '.mcp.json'),
        ),
        this.readJsonFile<{ mcpServers?: Record<string, McpServerConfigLike> }>(
          this.getEnterpriseMcpPath(),
        ),
      ]);

    const globalConfig = globalConfigResult.data ?? {};
    const projectConfig = globalConfig.projects?.[session.worktreePath] ?? {};
    const diagnostics: ClaudeMcpDiagnosticGroup[] = [];

    diagnostics.push(
      this.buildFileDiagnostics('user', this.getGlobalConfigPath(), globalConfigResult.error),
      this.buildFileDiagnostics('project', join(session.worktreePath, '.mcp.json'), projectFileResult.error),
      this.buildFileDiagnostics('enterprise', this.getEnterpriseMcpPath(), enterpriseResult.error),
    );

    const scopedConfigs = [
      ...this.collectScopedServers(
        'user',
        this.getGlobalConfigPath(),
        globalConfig.mcpServers,
        this.isProjectServerEnabled.bind(this, projectConfig),
      ),
      ...this.collectScopedServers(
        'local',
        this.getGlobalConfigPath(),
        projectConfig.mcpServers,
        this.isProjectServerEnabled.bind(this, projectConfig),
      ),
      ...this.collectScopedServers(
        'project',
        join(session.worktreePath, '.mcp.json'),
        projectFileResult.data?.mcpServers,
        this.isProjectServerEnabled.bind(this, projectConfig),
      ),
      ...this.collectScopedServers(
        'enterprise',
        this.getEnterpriseMcpPath(),
        enterpriseResult.data?.mcpServers,
        this.isProjectServerEnabled.bind(this, projectConfig),
      ),
    ];

    for (const server of scopedConfigs) {
      diagnostics.push({
        scope: server.scope,
        configLocation: server.configLocation,
        errors: server.errors,
        warnings: server.warnings,
      });
    }

    const runtimeState = await this.runtimeService.getRuntimeState(sessionId);
    const servers = await Promise.all(
      scopedConfigs.map((config) =>
        this.toServerEntry(session.worktreePath, config, runtimeState.sessionMetadata, runtimeState.contextUsage, forceRefresh),
      ),
    );

    const runtimeNames = new Set(servers.map((server) => server.name));
    const runtimeOnlyServers =
      runtimeState.sessionMetadata?.mcpServers
        .filter((server) => !runtimeNames.has(server.name))
        .map((server) =>
          this.buildRuntimeOnlyEntry(
            server.name,
            server.status,
            runtimeState.sessionMetadata,
            runtimeState.contextUsage,
          ),
        ) ?? [];

    const allServers = [...servers, ...runtimeOnlyServers].sort((left, right) => {
      if (left.scope !== right.scope) {
        return scopeOrder(left.scope) - scopeOrder(right.scope);
      }
      return left.name.localeCompare(right.name);
    });

    const malformed =
      allServers.filter((server) => server.configStatus === 'error').length
      + diagnostics.filter((group) => group.errors.length > 0 && group.scope !== 'user').length;

    return {
      servers: allServers,
      diagnostics: diagnostics.filter((group) => group.errors.length > 0 || group.warnings.length > 0),
      summary: {
        connected: allServers.filter((server) => server.connectionStatus === 'connected').length,
        needsAuth: allServers.filter((server) => server.connectionStatus === 'needs-auth').length,
        failed: allServers.filter((server) => server.connectionStatus === 'failed').length,
        disabled: allServers.filter((server) => server.connectionStatus === 'disabled').length,
        malformed,
        total: allServers.length,
      },
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async toggleServer(sessionId: number, serverName: string): Promise<ClaudeMcpSnapshot> {
    const session = await this.sessionsService.findOne(sessionId);
    const configPath = this.getGlobalConfigPath();
    const current = (await this.readJsonFile<GlobalConfig>(configPath)).data ?? {};
    const projectConfig = current.projects?.[session.worktreePath] ?? {};
    const isDisabled = this.isProjectServerEnabled(projectConfig, serverName) === false;
    const nextProjectConfig: ProjectConfig = {
      ...projectConfig,
      disabledMcpServers: toggleMembership(
        projectConfig.disabledMcpServers ?? [],
        serverName,
        isDisabled,
      ),
      enabledMcpServers: projectConfig.enabledMcpServers ?? [],
    };

    await this.writeJsonFile(configPath, {
      ...current,
      projects: {
        ...(current.projects ?? {}),
        [session.worktreePath]: nextProjectConfig,
      },
    });
    this.probeCache.delete(this.getProbeCacheKey(session.worktreePath, serverName));
    return this.getSnapshot(sessionId, true);
  }

  async recheckServer(sessionId: number, serverName: string): Promise<ClaudeMcpSnapshot> {
    const session = await this.sessionsService.findOne(sessionId);
    this.probeCache.delete(this.getProbeCacheKey(session.worktreePath, serverName));
    return this.getSnapshot(sessionId, true);
  }

  async startAuth(sessionId: number, serverName: string): Promise<ClaudeMcpAuthStartResult> {
    const [snapshot, config] = await Promise.all([
      this.getSnapshot(sessionId),
      this.findConfigByServerName(sessionId, serverName),
    ]);
    const server = snapshot.servers.find((entry) => entry.name === serverName);
    if (!server) {
      throw new NotFoundException(`MCP server "${serverName}" not found.`);
    }

    if (!server.actions.canAuth && !server.actions.canReauth) {
      throw new BadRequestException(`MCP server "${serverName}" does not expose browser auth.`);
    }

    const authUrl = await this.resolveAuthUrl(sessionId, server, config);
    if (!authUrl) {
      throw new BadRequestException(`MCP server "${serverName}" does not provide an auth URL.`);
    }

    return {
      serverName,
      url: authUrl,
      mode: 'external',
      message:
        server.transport === 'claudeai-proxy'
          ? 'Open the Claude connectors page, complete authentication, then recheck the server.'
          : 'Open the authorization page, complete authentication in the browser, then recheck the server.',
    };
  }

  private async toServerEntry(
    worktreePath: string,
    server: ScopedServerConfig,
    metadata: ClaudeRuntimeSessionMetadata | null,
    contextUsage: ClaudeContextUsage | null,
    forceRefresh: boolean,
  ): Promise<ClaudeMcpServerEntry> {
    const runtimeStatus = metadata?.mcpServers.find((candidate) => candidate.name === server.name)?.status;
    const probe: ProbeResult | null = server.enabled
      ? await this.getProbeStatus(worktreePath, server.name, forceRefresh)
      : null;
    const connectionStatus = runtimeStatus
      ? normalizeConnectionStatus(runtimeStatus)
      : probe?.status ?? 'disabled';
    const counts = this.buildCounts(server.name, metadata, contextUsage);
    const tools = this.buildTools(server.name, metadata) ?? [];

    return {
      entryId: `${server.scope}:${server.name}`,
      name: server.name,
      scope: server.scope,
      transport: server.transport,
      configLocation: server.configLocation,
      enabled: server.enabled,
      connectionStatus,
      configStatus: server.configStatus,
      error: server.errors[0]?.message ?? probe?.error,
      counts,
      tools,
      actions: {
        canToggle: server.scope !== 'runtime',
        canRecheck: server.enabled,
        canAuth:
          server.enabled
          && connectionStatus === 'needs-auth'
          && supportsBrowserAuth(server.transport, server.config),
        canReauth:
          server.enabled
          && connectionStatus !== 'needs-auth'
          && connectionStatus !== 'disabled'
          && supportsBrowserAuth(server.transport, server.config),
        canViewTools: tools.length > 0,
      },
    };
  }

  private async resolveAuthUrl(
    sessionId: number,
    server: ClaudeMcpServerEntry,
    config: McpServerConfigLike | null,
  ): Promise<string | null> {
    if (server.transport === 'claudeai-proxy') {
      return CLAUDE_AI_CONNECTORS_URL;
    }

    if (!config || !['http', 'sse'].includes(server.transport)) {
      return null;
    }

    return this.runtimeService.startMcpAuthFlow(sessionId, server.name);
  }

  private buildRuntimeOnlyEntry(
    name: string,
    status: string,
    metadata: ClaudeRuntimeSessionMetadata | null,
    contextUsage: ClaudeContextUsage | null,
  ): ClaudeMcpServerEntry {
    const tools = this.buildTools(name, metadata) ?? [];
    return {
      entryId: `runtime:${name}`,
      name,
      scope: 'runtime',
      transport: 'unknown',
      configLocation: 'Runtime session',
      enabled: true,
      connectionStatus: normalizeConnectionStatus(status),
      configStatus: 'valid',
      counts: this.buildCounts(name, metadata, contextUsage),
      tools,
      actions: {
        canToggle: false,
        canRecheck: false,
        canAuth: false,
        canReauth: false,
        canViewTools: tools.length > 0,
      },
    };
  }

  private buildCounts(
    serverName: string,
    metadata: ClaudeRuntimeSessionMetadata | null,
    contextUsage: ClaudeContextUsage | null,
  ): ClaudeMcpServerEntry['counts'] {
    const normalizedName = normalizeNameForMcp(serverName);
    const toolPrefix = `mcp__${normalizedName}__`;
    const tools = metadata?.tools.filter((name) => name.startsWith(toolPrefix)).length ?? 0;
    const prompts = metadata?.slashCommands.filter((name) => name.startsWith(toolPrefix)).length ?? 0;
    const loadedContextTools =
      contextUsage?.mcpTools.filter((tool) => tool.serverName === serverName).length ?? 0;

    return {
      tools,
      resources: 0,
      prompts,
      loadedContextTools,
    };
  }

  private buildTools(
    serverName: string,
    metadata: ClaudeRuntimeSessionMetadata | null,
  ): ClaudeMcpServerEntry['tools'] {
    const normalizedName = normalizeNameForMcp(serverName);
    const prefix = `mcp__${normalizedName}__`;
    return (
      metadata?.tools
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({
          name,
          displayName: name.slice(prefix.length).replace(/_/g, ' '),
        })) ?? []
    );
  }

  private async getProbeStatus(
    worktreePath: string,
    serverName: string,
    forceRefresh: boolean,
  ): Promise<ProbeResult> {
    const cacheKey = this.getProbeCacheKey(worktreePath, serverName);
    const cached = this.probeCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) {
      return cached;
    }

    try {
      const { stdout, stderr } = await execFile(
        CLAUDE_BIN,
        ['mcp', 'get', serverName],
        {
          cwd: worktreePath,
          env: buildAugmentedEnv(process.env, worktreePath),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const output = `${stdout}\n${stderr}`;
      const status = parseProbeOutput(output);
      const result: ProbeResult = {
        status,
        checkedAt: Date.now(),
        error:
          status === 'failed'
            ? extractProbeError(output)
            : undefined,
      };
      this.probeCache.set(cacheKey, result);
      return result;
    } catch (error) {
      const output =
        error instanceof Error ? error.message : 'Could not run Claude MCP probe.';
      const result: ProbeResult = {
        status: output.includes('Needs authentication') ? 'needs-auth' : 'failed',
        error: output,
        checkedAt: Date.now(),
      };
      this.probeCache.set(cacheKey, result);
      return result;
    }
  }

  private collectScopedServers(
    scope: ClaudeMcpScope,
    configLocation: string,
    servers: Record<string, McpServerConfigLike> | undefined,
    enabledResolver: ((name: string) => boolean) | boolean,
  ): ScopedServerConfig[] {
    if (!servers || typeof servers !== 'object') {
      return [];
    }

    return Object.entries(servers).map(([name, config]) => {
      const { transport, errors, warnings } = validateServerConfig(name, config);
      return {
        scope,
        name,
        configLocation,
        enabled:
          typeof enabledResolver === 'boolean'
            ? enabledResolver
            : enabledResolver(name),
        configStatus: errors.length ? 'error' : warnings.length ? 'warning' : 'valid',
        warnings,
        errors,
        transport,
        config,
      };
    });
  }

  private isProjectServerEnabled(projectConfig: ProjectConfig, name: string): boolean {
    if (!name) {
      return true;
    }
    const disabledServers = projectConfig.disabledMcpServers ?? [];
    const enabledServers = projectConfig.enabledMcpServers ?? [];
    if (enabledServers.includes(name)) {
      return true;
    }
    return !disabledServers.includes(name);
  }

  private buildFileDiagnostics(
    scope: ClaudeMcpScope,
    configLocation: string,
    parseError?: string,
  ): ClaudeMcpDiagnosticGroup {
    return {
      scope,
      configLocation,
      errors: parseError ? [{ message: parseError }] : [],
      warnings: [],
    };
  }

  private async findConfigByServerName(
    sessionId: number,
    serverName: string,
  ): Promise<McpServerConfigLike | null> {
    const session = await this.sessionsService.findOne(sessionId);
    const [globalConfigResult, projectFileResult, enterpriseResult] =
      await Promise.all([
        this.readJsonFile<GlobalConfig>(this.getGlobalConfigPath()),
        this.readJsonFile<{ mcpServers?: Record<string, McpServerConfigLike> }>(
          join(session.worktreePath, '.mcp.json'),
        ),
        this.readJsonFile<{ mcpServers?: Record<string, McpServerConfigLike> }>(
          this.getEnterpriseMcpPath(),
        ),
      ]);

    const globalConfig = globalConfigResult.data ?? {};
    const projectConfig = globalConfig.projects?.[session.worktreePath] ?? {};

    return (
      projectConfig.mcpServers?.[serverName]
      || projectFileResult.data?.mcpServers?.[serverName]
      || globalConfig.mcpServers?.[serverName]
      || enterpriseResult.data?.mcpServers?.[serverName]
      || null
    );
  }

  private async readJsonFile<T>(path: string): Promise<{ data?: T; error?: string }> {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      return { data: JSON.parse(raw) as T };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {};
      }
      return {
        error: error instanceof Error ? error.message : `Could not parse ${path}`,
      };
    }
  }

  private async writeJsonFile(path: string, value: unknown): Promise<void> {
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  }

  private getGlobalConfigPath(): string {
    return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
  }

  private getEnterpriseMcpPath(): string {
    if (process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH) {
      return join(process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH, 'managed-mcp.json');
    }

    if (process.platform === 'darwin') {
      return '/Library/Application Support/ClaudeCode/managed-mcp.json';
    }
    if (process.platform === 'win32') {
      return 'C:\\Program Files\\ClaudeCode\\managed-mcp.json';
    }
    return '/etc/claude-code/managed-mcp.json';
  }

  private getProbeCacheKey(worktreePath: string, serverName: string): string {
    return `${worktreePath}:${serverName}`;
  }
}

function validateServerConfig(
  serverName: string,
  config: McpServerConfigLike,
): {
  transport: ClaudeMcpTransport;
  errors: ClaudeMcpDiagnosticMessage[];
  warnings: ClaudeMcpDiagnosticMessage[];
} {
  const errors: ClaudeMcpDiagnosticMessage[] = [];
  const warnings: ClaudeMcpDiagnosticMessage[] = [];
  const transport = inferTransport(config);

  if (transport === 'stdio' && typeof config.command !== 'string') {
    errors.push({
      serverName,
      path: 'command',
      message: 'stdio MCP servers require a string command.',
    });
  }

  if (
    (transport === 'http'
      || transport === 'sse'
      || transport === 'ws'
      || transport === 'claudeai-proxy')
    && typeof config.url !== 'string'
  ) {
    errors.push({
      serverName,
      path: 'url',
      message: `${transport} MCP servers require a string url.`,
    });
  }

  if (config.args !== undefined && !Array.isArray(config.args)) {
    warnings.push({
      serverName,
      path: 'args',
      message: 'Expected args to be an array of strings.',
    });
  }

  if (transport === 'unknown') {
    warnings.push({
      serverName,
      path: 'type',
      message: 'Unknown MCP transport type. Some controls may be unavailable.',
    });
  }

  return { transport, errors, warnings };
}

function inferTransport(config: McpServerConfigLike): ClaudeMcpTransport {
  if (!config.type || config.type === 'stdio') return 'stdio';
  if (config.type === 'sse') return 'sse';
  if (config.type === 'http') return 'http';
  if (config.type === 'ws' || config.type === 'ws-ide') return 'ws';
  if (config.type === 'sdk') return 'sdk';
  if (config.type === 'claudeai-proxy') return 'claudeai-proxy';
  return 'unknown';
}

function supportsBrowserAuth(
  transport: ClaudeMcpTransport,
  config: McpServerConfigLike,
): boolean {
  if (transport === 'claudeai-proxy') {
    return true;
  }

  // Claude Code handles OAuth auth flows for HTTP/SSE network transports.
  if (
    ['http', 'sse'].includes(transport)
    && typeof config.url === 'string'
    && config.url.trim()
  ) {
    return true;
  }

  const oauth = config.oauth;
  if (!oauth) {
    return false;
  }

  return [
    oauth.authorizationUrl,
    oauth.authorizationEndpoint,
    oauth.authUrl,
    oauth.authServerMetadataUrl,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

function parseProbeOutput(output: string): ClaudeMcpConnectionStatus {
  if (/Needs authentication/i.test(output)) return 'needs-auth';
  if (/connected/i.test(output)) return 'connected';
  if (/disabled/i.test(output)) return 'disabled';
  if (/failed|connection error|not found/i.test(output)) return 'failed';
  return 'unknown';
}

function extractProbeError(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1);
}

function normalizeConnectionStatus(status: string): ClaudeMcpConnectionStatus {
  if (status === 'connected') return 'connected';
  if (status === 'needs-auth') return 'needs-auth';
  if (status === 'failed') return 'failed';
  if (status === 'disabled') return 'disabled';
  return 'unknown';
}

function normalizeNameForMcp(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (name.startsWith('claude.ai ')) {
    normalized = normalized.replace(/_+/g, '_').replace(/^_|_$/g, '');
  }
  return normalized;
}

function toggleMembership(list: string[], name: string, shouldContain: boolean): string[] {
  const contains = list.includes(name);
  if (contains === shouldContain) {
    return list;
  }
  return shouldContain ? [...list, name] : list.filter((entry) => entry !== name);
}

function scopeOrder(scope: ClaudeMcpScope): number {
  switch (scope) {
    case 'project':
      return 0;
    case 'local':
      return 1;
    case 'user':
      return 2;
    case 'enterprise':
      return 3;
    default:
      return 4;
  }
}
