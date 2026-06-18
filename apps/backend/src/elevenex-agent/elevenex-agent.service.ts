import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getElevenexProxyPort } from '../config/ports.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ReposService } from '../repos/repos.service.js';

const execFileAsync = promisify(execFile);

/** Name of the hidden project that owns the meta-agent workspace repo. */
export const AGENT_PROJECT_NAME = 'Elevenex Agent';

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

  /** Cached ids of the hidden agent project + workspace repo, once resolved. */
  private agentRepo: {
    projectId: number;
    repoId: number;
    worktreePath: string;
  } | null = null;
  /** Coalesces concurrent ensureAgentRepo() calls into a single bootstrap. */
  private ensureAgentRepoInFlight: Promise<{
    projectId: number;
    repoId: number;
    worktreePath: string;
  }> | null = null;

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly reposService: ReposService,
  ) {}

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

    try {
      await this.ensureAgentRepo();
    } catch (err) {
      // Same rule: provisioning the hidden project/repo is best-effort at boot.
      // It is retried lazily on the first mission via ensureAgentRepo().
      this.logger.warn(
        `Could not bootstrap agent repo: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Ensure the hidden "Elevenex Agent" project + workspace repo exist, returning
   * the ids that agent (mission) sessions bind to. Idempotent and concurrency-safe:
   * `git init`s `~/.elevenex/agent` with a seed commit if needed, then find-or-creates
   * the project and repo. Cached after the first success.
   */
  async ensureAgentRepo(): Promise<{
    projectId: number;
    repoId: number;
    worktreePath: string;
  }> {
    if (this.agentRepo) {
      return this.agentRepo;
    }
    if (this.ensureAgentRepoInFlight) {
      return this.ensureAgentRepoInFlight;
    }

    this.ensureAgentRepoInFlight = (async () => {
      const worktreePath = this.workspaceDir;
      await this.ensureGitRepo(worktreePath);
      const projectId = await this.ensureAgentProject();
      const repoId = await this.ensureAgentRepoRow(projectId, worktreePath);
      this.agentRepo = { projectId, repoId, worktreePath };
      this.logger.log(
        `Agent repo ready project=${projectId} repo=${repoId} path=${worktreePath}`,
      );
      return this.agentRepo;
    })().finally(() => {
      this.ensureAgentRepoInFlight = null;
    });

    return this.ensureAgentRepoInFlight;
  }

  /** `git init` + seed commit so ReposService.addRepo accepts the directory. */
  private async ensureGitRepo(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    try {
      await access(join(dir, '.git'));
      return; // already a git repo
    } catch {
      // Not a repo yet — initialize below.
    }

    await execFileAsync('git', ['init'], { cwd: dir });
    // Local identity so the seed commit succeeds even on machines with no global
    // git user configured.
    await execFileAsync('git', ['config', 'user.name', 'Elevenex Agent'], {
      cwd: dir,
    });
    await execFileAsync(
      'git',
      ['config', 'user.email', 'agent@elevenex.local'],
      { cwd: dir },
    );
    await writeFile(join(dir, '.gitkeep'), '', 'utf-8');
    await execFileAsync('git', ['add', '.gitkeep'], { cwd: dir });
    await execFileAsync(
      'git',
      ['commit', '--no-gpg-sign', '-m', 'chore: init elevenex agent workspace'],
      { cwd: dir },
    );
  }

  /** Find-or-create the hidden "Elevenex Agent" project. */
  private async ensureAgentProject(): Promise<number> {
    const existing = await this.projectsService.findByName(AGENT_PROJECT_NAME);
    if (existing) {
      if (!existing.hidden) {
        await this.projectsService.setHidden(existing.id, true);
      }
      return existing.id;
    }
    try {
      const created = await this.projectsService.create(AGENT_PROJECT_NAME, true);
      return created.id;
    } catch {
      // Lost a create race — re-read and reuse.
      const reused = await this.projectsService.findByName(AGENT_PROJECT_NAME);
      if (!reused) {
        throw new Error('Failed to find-or-create the Elevenex Agent project');
      }
      return reused.id;
    }
  }

  /** Find-or-create the workspace repo row under the agent project. */
  private async ensureAgentRepoRow(
    projectId: number,
    worktreePath: string,
  ): Promise<number> {
    const repos = await this.reposService.findByProject(projectId);
    const existing = repos.find((r) => r.path === worktreePath);
    if (existing) {
      return existing.id;
    }
    try {
      const created = await this.reposService.addRepo(projectId, worktreePath);
      return created.id;
    } catch {
      // Unique-conflict (added concurrently) — re-read and reuse.
      const after = await this.reposService.findByProject(projectId);
      const reused = after.find((r) => r.path === worktreePath);
      if (!reused) {
        throw new Error('Failed to find-or-create the agent workspace repo');
      }
      return reused.id;
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
