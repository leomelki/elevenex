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

/**
 * The two settings files Gemini merges, in increasing precedence. Enterprise
 * and system scopes exist too but are read-only for our purposes.
 */
interface GeminiSettingsScope {
  scope: ClaudeMcpScope;
  path: string;
}

interface GeminiSettings {
  mcpServers?: Record<string, Record<string, unknown>>;
  mcp?: {
    allowed?: string[];
    excluded?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface LoadedScope extends GeminiSettingsScope {
  settings: GeminiSettings;
  parseError: string | null;
  exists: boolean;
}

/**
 * Reads and edits Gemini's MCP configuration.
 *
 * Gemini keeps MCP servers in `settings.json` under a top-level `mcpServers`
 * map, and gates them with `mcp.allowed` / `mcp.excluded` name lists — the same
 * mechanism `gemini mcp enable|disable` drives. Elevenex edits those files
 * directly rather than shelling out to `gemini mcp`, because those subcommands
 * refuse to operate in a folder Gemini considers untrusted, which is the normal
 * state for a freshly created worktree.
 *
 * Gemini loads this config itself at `session/new`, so Elevenex passes an empty
 * `mcpServers` list over ACP rather than re-declaring the same servers and
 * getting them registered twice.
 */
@Injectable()
export class GeminiMcpService {
  private readonly logger = new Logger('GeminiMcpService');

  private scopesFor(worktreePath: string | null): GeminiSettingsScope[] {
    const scopes: GeminiSettingsScope[] = [
      { scope: 'user', path: join(homedir(), '.gemini', 'settings.json') },
    ];
    if (worktreePath) {
      scopes.push({
        scope: 'project',
        path: join(worktreePath, '.gemini', 'settings.json'),
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
      const errors = scope.parseError
        ? [{ path: scope.path, message: scope.parseError }]
        : [];
      if (errors.length) {
        diagnostics.push({
          scope: scope.scope,
          configLocation: scope.path,
          errors,
          warnings: [],
        });
      }

      const entries = scope.settings.mcpServers ?? {};
      for (const [name, raw] of Object.entries(entries)) {
        servers.push(this.toServerEntry(name, raw, scope));
      }
    }

    // A project-scope definition wins over a user-scope one of the same name,
    // matching how Gemini merges its settings files.
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

  /**
   * Flips a server between enabled and disabled by editing `mcp.excluded` in
   * the scope that defines it. Returns the refreshed snapshot.
   */
  async toggleServer(
    worktreePath: string | null,
    serverName: string,
  ): Promise<ClaudeMcpSnapshot> {
    const loaded = await Promise.all(
      this.scopesFor(worktreePath).map((scope) => this.loadScope(scope)),
    );
    // Prefer the most specific scope that declares the server.
    const owning = [...loaded]
      .reverse()
      .find((scope) => Boolean(scope.settings.mcpServers?.[serverName]));
    if (!owning) {
      throw new NotFoundException(
        `MCP server "${serverName}" is not configured for Gemini.`,
      );
    }

    const excluded = new Set(owning.settings.mcp?.excluded ?? []);
    if (excluded.has(serverName)) {
      excluded.delete(serverName);
    } else {
      excluded.add(serverName);
    }

    const next: GeminiSettings = {
      ...owning.settings,
      mcp: { ...(owning.settings.mcp ?? {}), excluded: [...excluded] },
    };
    await this.writeSettings(owning.path, next);

    return this.getSnapshot(worktreePath);
  }

  /**
   * Gemini connects to MCP servers itself and does not expose a re-check RPC,
   * so this is a plain re-read of the configuration.
   */
  recheckServer(worktreePath: string | null): Promise<ClaudeMcpSnapshot> {
    return this.getSnapshot(worktreePath);
  }

  private async loadScope(scope: GeminiSettingsScope): Promise<LoadedScope> {
    try {
      const raw = await fs.readFile(scope.path, 'utf8');
      try {
        const parsed: unknown = JSON.parse(raw);
        const settings =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as GeminiSettings)
            : {};
        return { ...scope, settings, parseError: null, exists: true };
      } catch (error) {
        return {
          ...scope,
          settings: {},
          parseError: `Could not parse ${scope.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          exists: true,
        };
      }
    } catch {
      return { ...scope, settings: {}, parseError: null, exists: false };
    }
  }

  private async writeSettings(
    path: string,
    settings: GeminiSettings,
  ): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    this.logger.log(`Updated Gemini MCP settings at ${path}`);
  }

  private toServerEntry(
    name: string,
    raw: Record<string, unknown>,
    scope: LoadedScope,
  ): ClaudeMcpServerEntry {
    const allowed = scope.settings.mcp?.allowed;
    const excluded = scope.settings.mcp?.excluded ?? [];
    const enabled =
      !excluded.includes(name) &&
      (!Array.isArray(allowed) ||
        allowed.length === 0 ||
        allowed.includes(name));

    const transport = this.resolveTransport(raw);
    const configStatus = this.hasUsableTarget(raw) ? 'valid' : 'error';

    return {
      entryId: `${scope.scope}:${name}`,
      name,
      scope: scope.scope,
      transport,
      configLocation: scope.path,
      enabled,
      // Gemini owns the connections and reports their health only inside its
      // own UI, so Elevenex cannot honestly claim "connected" here.
      connectionStatus: enabled ? 'unknown' : 'disabled',
      configStatus,
      ...(configStatus === 'error'
        ? {
            error:
              'Server has neither a `command` (stdio) nor a `url`/`httpUrl` (sse/http).',
          }
        : {}),
      actions: {
        canToggle: true,
        canRecheck: true,
        // Gemini handles MCP OAuth through its own CLI flow rather than an
        // elicitation Elevenex can drive.
        canAuth: false,
        canReauth: false,
        canViewTools: false,
      },
    };
  }

  private resolveTransport(raw: Record<string, unknown>): ClaudeMcpTransport {
    if (typeof raw['httpUrl'] === 'string') return 'http';
    if (typeof raw['url'] === 'string') return 'sse';
    if (typeof raw['command'] === 'string') return 'stdio';
    return 'unknown';
  }

  private hasUsableTarget(raw: Record<string, unknown>): boolean {
    return (
      typeof raw['command'] === 'string' ||
      typeof raw['url'] === 'string' ||
      typeof raw['httpUrl'] === 'string'
    );
  }
}
