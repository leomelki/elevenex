import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  ClaudeMcpDiagnosticGroup,
  ClaudeMcpScope,
  ClaudeMcpServerEntry,
  ClaudeMcpSnapshot,
  ClaudeMcpTransport,
} from '../claude-runtime/claude-runtime.types.js';

interface AntigravityConfigScope {
  scope: ClaudeMcpScope;
  path: string;
}

interface AntigravityMcpConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

interface LoadedScope extends AntigravityConfigScope {
  config: AntigravityMcpConfig;
  parseError: string | null;
}

/**
 * Reads and edits `agy`'s MCP configuration.
 *
 * Config location (per antigravity.google/docs/cli/mcp/, cross-checked on two
 * independent fetches — not verified against a live install):
 *
 *   ~/.gemini/config/mcp_config.json   user scope (path inherited from the
 *                                      gemini-cli era; confirmed current for
 *                                      Antigravity by the same doc page)
 *   <worktree>/.agents/mcp_config.json project scope (wins on name collision)
 *
 * Format is `{"mcpServers": {"name": {...}}}`, each entry gated by its own
 * `disabled` boolean — unlike Gemini's `mcp.allowed`/`mcp.excluded` name
 * lists. Elevenex edits the file directly (there is no documented `agy mcp`
 * subcommand for enable/disable, only the interactive `/mcp` overlay).
 */
@Injectable()
export class AntigravityMcpService {
  private readonly logger = new Logger('AntigravityMcpService');

  private scopesFor(worktreePath: string | null): AntigravityConfigScope[] {
    const scopes: AntigravityConfigScope[] = [
      {
        scope: 'user',
        path: join(homedir(), '.gemini', 'config', 'mcp_config.json'),
      },
    ];
    if (worktreePath) {
      scopes.push({
        scope: 'project',
        path: join(worktreePath, '.agents', 'mcp_config.json'),
      });
    }
    return scopes;
  }

  async getSnapshot(worktreePath: string | null): Promise<ClaudeMcpSnapshot> {
    const loaded = await Promise.all(
      this.scopesFor(worktreePath).map((scope) => this.loadScope(scope)),
    );

    const servers: ClaudeMcpServerEntry[] = [];
    const diagnostics: ClaudeMcpDiagnosticGroup[] = [];

    for (const scope of loaded) {
      if (scope.parseError) {
        diagnostics.push({
          scope: scope.scope,
          configLocation: scope.path,
          errors: [{ path: scope.path, message: scope.parseError }],
          warnings: [],
        });
      }
      const entries = scope.config.mcpServers ?? {};
      for (const [name, raw] of Object.entries(entries)) {
        servers.push(this.toServerEntry(name, raw, scope));
      }
    }

    // A project-scope definition wins over a user-scope one of the same name.
    const deduped = new Map<string, ClaudeMcpServerEntry>();
    for (const server of servers) deduped.set(server.name, server);
    const finalServers = [...deduped.values()];

    return {
      servers: finalServers,
      diagnostics,
      summary: {
        connected: 0,
        needsAuth: 0,
        failed: 0,
        disabled: finalServers.filter((server) => !server.enabled).length,
        malformed: diagnostics.reduce(
          (total, group) => total + group.errors.length,
          0,
        ),
        total: finalServers.length,
      },
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  /** Flips a server's `disabled` flag in the scope that defines it. */
  async toggleServer(
    worktreePath: string | null,
    serverName: string,
  ): Promise<ClaudeMcpSnapshot> {
    const loaded = await Promise.all(
      this.scopesFor(worktreePath).map((scope) => this.loadScope(scope)),
    );
    const owning = [...loaded]
      .reverse()
      .find((scope) => Boolean(scope.config.mcpServers?.[serverName]));
    if (!owning) {
      throw new NotFoundException(
        `MCP server "${serverName}" is not configured for Antigravity.`,
      );
    }

    const server = owning.config.mcpServers![serverName];
    const next: AntigravityMcpConfig = {
      ...owning.config,
      mcpServers: {
        ...owning.config.mcpServers,
        [serverName]: { ...server, disabled: !server['disabled'] },
      },
    };
    await this.writeConfig(owning.path, next);

    return this.getSnapshot(worktreePath);
  }

  /** `agy` owns its MCP connections; a re-check is a plain config re-read. */
  recheckServer(worktreePath: string | null): Promise<ClaudeMcpSnapshot> {
    return this.getSnapshot(worktreePath);
  }

  private async loadScope(scope: AntigravityConfigScope): Promise<LoadedScope> {
    try {
      const raw = await fs.readFile(scope.path, 'utf8');
      try {
        const parsed: unknown = JSON.parse(raw);
        const config =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as AntigravityMcpConfig)
            : {};
        return { ...scope, config, parseError: null };
      } catch (error) {
        return {
          ...scope,
          config: {},
          parseError: `Could not parse ${scope.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    } catch {
      return { ...scope, config: {}, parseError: null };
    }
  }

  private async writeConfig(
    path: string,
    config: AntigravityMcpConfig,
  ): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    this.logger.log(`Updated Antigravity MCP config at ${path}`);
  }

  private toServerEntry(
    name: string,
    raw: Record<string, unknown>,
    scope: LoadedScope,
  ): ClaudeMcpServerEntry {
    const enabled = raw['disabled'] !== true;
    const transport = this.resolveTransport(raw);
    const configStatus = this.hasUsableTarget(raw) ? 'valid' : 'error';

    return {
      entryId: `${scope.scope}:${name}`,
      name,
      scope: scope.scope,
      transport,
      configLocation: scope.path,
      enabled,
      // `agy` owns the connections and does not expose their health over the
      // headless protocol, so Elevenex cannot honestly claim "connected".
      connectionStatus: enabled ? 'unknown' : 'disabled',
      configStatus,
      ...(configStatus === 'error'
        ? {
            error:
              'Server has neither a `command` (stdio) nor a `serverUrl` (remote).',
          }
        : {}),
      actions: {
        canToggle: true,
        canRecheck: true,
        canAuth: false,
        canReauth: false,
        canViewTools: false,
      },
    };
  }

  private resolveTransport(raw: Record<string, unknown>): ClaudeMcpTransport {
    if (typeof raw['serverUrl'] === 'string') return 'http';
    if (typeof raw['command'] === 'string') return 'stdio';
    return 'unknown';
  }

  private hasUsableTarget(raw: Record<string, unknown>): boolean {
    return (
      typeof raw['command'] === 'string' ||
      typeof raw['serverUrl'] === 'string'
    );
  }
}
