import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { getElevenexProxyPort } from '../config/ports.js';

/**
 * Bootstraps the hidden `~/.elevenex/agent` workspace that the meta-agent's
 * brain runs in. It writes a **shared** `.mcp.json` pointing Claude Code at the
 * in-process Elevenex MCP server, plus a `.claude/settings.local.json` that
 * auto-allows the safe read-only tools. Per-agent-session identity is injected
 * separately as `ELEVENEX_AGENT_TOKEN` (claude-runtime), and the `.mcp.json`
 * auth header expands `${ELEVENEX_AGENT_TOKEN}` so one shared file serves every
 * agent session.
 *
 * This is intentionally a leaf: it only touches the filesystem + port config,
 * so it never couples to the MCP module (no dependency cycle).
 */
@Injectable()
export class ElevenexAgentService implements OnModuleInit {
  private readonly logger = new Logger(ElevenexAgentService.name);

  /** Read-only / harmless tools auto-allowed in the agent workspace. Mutating
   * and destructive tools deliberately still prompt (per autonomy mode). */
  private static readonly SAFE_TOOLS = [
    'project_overview',
    'find_sessions',
    'session_status',
    'read_session',
    'text_search',
    'file_search',
    'read_file',
    'change_review',
    'get_worktree_context',
    'await_session_event',
    'get_pending_action',
    'get_worktree_job',
    'assess_worktree_pool',
  ];

  /** Absolute path of the shared agent workspace. */
  get workspaceDir(): string {
    return join(homedir(), '.elevenex', 'agent');
  }

  /** The URL the inner Claude process uses to reach the MCP server. */
  get mcpUrl(): string {
    return (
      process.env.ELEVENEX_MCP_URL?.trim() ||
      `http://127.0.0.1:${getElevenexProxyPort()}/api/mcp`
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.ensureWorkspace();
    } catch (err) {
      // The workspace is a convenience for running the agent brain; never let a
      // write failure crash backend startup.
      this.logger.warn(
        `Could not bootstrap agent workspace: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Idempotently (re)write the agent workspace config. */
  async ensureWorkspace(): Promise<void> {
    const dir = this.workspaceDir;
    const claudeDir = join(dir, '.claude');
    await mkdir(claudeDir, { recursive: true });

    await this.writeMergedJson(join(dir, '.mcp.json'), (existing) => ({
      ...existing,
      mcpServers: {
        ...(existing.mcpServers as Record<string, unknown> | undefined),
        elevenex: {
          type: 'http',
          url: this.mcpUrl,
          headers: { Authorization: 'Bearer ${ELEVENEX_AGENT_TOKEN}' },
        },
      },
    }));

    await this.writeMergedJson(
      join(claudeDir, 'settings.local.json'),
      (existing) => {
        const permissions =
          (existing.permissions as { allow?: string[] } | undefined) ?? {};
        const allow = new Set(permissions.allow ?? []);
        for (const tool of ElevenexAgentService.SAFE_TOOLS) {
          allow.add(`mcp__elevenex__${tool}`);
        }
        return {
          ...existing,
          enableAllProjectMcpServers: true,
          permissions: { ...permissions, allow: [...allow] },
        };
      },
    );

    this.logger.log(`Agent workspace ready at ${dir} (MCP: ${this.mcpUrl})`);
  }

  /** Read+merge+write JSON so we never clobber a user's hand edits. */
  private async writeMergedJson(
    path: string,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(path, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      // Missing or invalid file → start fresh.
    }
    const next = merge(existing);
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }
}
