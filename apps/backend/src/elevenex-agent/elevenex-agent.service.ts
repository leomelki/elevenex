import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { getElevenexAgentRoot } from '../config/runtime-paths.js';
import { worktreeSimpleGit } from '../config/system-paths.js';

// Identity used for the agent workspace's bootstrap commit so the workspace is a
// valid git repository without depending on the user's global git config.
const AGENT_GIT_AUTHOR_NAME = 'Elevenex Agent';
const AGENT_GIT_AUTHOR_EMAIL = 'agent@elevenex.local';

// Name of the hidden system project that owns the agent's sessions. It is marked
// `isSystem` so it never shows up in the normal project list or navigation tree.
const AGENT_PROJECT_NAME = 'Elevenex Agent';
const AGENT_REPO_NAME = 'agent';

export interface AgentWorkspace {
  projectId: number;
  repoId: number;
  path: string;
  branch: string;
}

export interface AgentOverview {
  workspace: AgentWorkspace;
  sessions: Awaited<ReturnType<SessionsService['findByRepo']>>;
}

/**
 * Runs Elevenex agent coding sessions inside a fixed, machine-local workspace
 * (`~/.elevenex/agent`, or `~/.elevenex-remote/agent` when the backend runs over
 * SSH). The workspace is a self-contained git repository registered as a hidden
 * system project/repo, so the existing session + agent-runtime machinery drives
 * it exactly like a worktree session — the only difference is the working
 * directory and that it is hidden from the normal navigation surfaces.
 */
@Injectable()
export class ElevenexAgentService {
  private readonly logger = new Logger(ElevenexAgentService.name);
  private ensurePromise: Promise<AgentWorkspace> | null = null;
  private cachedWorkspace: AgentWorkspace | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
    private readonly sessionsService: SessionsService,
  ) {}

  /**
   * Idempotently makes sure the agent workspace exists on disk (git-initialized)
   * and is registered as a hidden system project + repo. Concurrent callers share
   * a single in-flight initialization.
   */
  async ensureWorkspace(): Promise<AgentWorkspace> {
    if (this.cachedWorkspace) {
      return this.cachedWorkspace;
    }
    if (!this.ensurePromise) {
      this.ensurePromise = this.buildWorkspace().finally(() => {
        this.ensurePromise = null;
      });
    }
    return this.ensurePromise;
  }

  async getOverview(): Promise<AgentOverview> {
    const workspace = await this.ensureWorkspace();
    const sessions = await this.sessionsService.findByRepo(workspace.repoId);
    return { workspace, sessions };
  }

  async createSession(name?: string) {
    const workspace = await this.ensureWorkspace();
    return this.sessionsService.create({
      repoId: workspace.repoId,
      branchName: workspace.branch,
      worktreePath: workspace.path,
      name: name?.trim() || undefined,
    });
  }

  private async buildWorkspace(): Promise<AgentWorkspace> {
    const path = getElevenexAgentRoot();
    await fs.mkdir(path, { recursive: true });
    const branch = await this.ensureGitRepository(path);
    const projectId = await this.ensureSystemProject();
    const repoId = await this.ensureSystemRepo(projectId, path);

    const workspace: AgentWorkspace = { projectId, repoId, path, branch };
    this.cachedWorkspace = workspace;
    this.logger.log(
      `Elevenex agent workspace ready at ${path} (project=${projectId}, repo=${repoId}, branch=${branch})`,
    );
    return workspace;
  }

  /** git-init the workspace if needed and guarantee a born branch with HEAD. */
  private async ensureGitRepository(path: string): Promise<string> {
    const git = worktreeSimpleGit(path);

    const hasGit = await fs
      .access(join(path, '.git'))
      .then(() => true)
      .catch(() => false);
    if (!hasGit) {
      await git.init();
    }

    const hasHead = await git
      .raw(['rev-parse', '--verify', 'HEAD'])
      .then(() => true)
      .catch(() => false);
    if (!hasHead) {
      await git.raw([
        '-c',
        `user.name=${AGENT_GIT_AUTHOR_NAME}`,
        '-c',
        `user.email=${AGENT_GIT_AUTHOR_EMAIL}`,
        'commit',
        '--allow-empty',
        '-m',
        'Initialize Elevenex agent workspace',
      ]);
    }

    const branch = (
      await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim();
    return branch || 'main';
  }

  private async ensureSystemProject(): Promise<number> {
    const existing = await this.projectsService.findSystemByName(
      AGENT_PROJECT_NAME,
    );
    if (existing) {
      return existing.id;
    }
    const created = await this.projectsService.create(AGENT_PROJECT_NAME, {
      isSystem: true,
    });
    return created.id;
  }

  private async ensureSystemRepo(
    projectId: number,
    path: string,
  ): Promise<number> {
    const existing = await this.db
      .select()
      .from(schema.repos)
      .where(
        and(
          eq(schema.repos.projectId, projectId),
          eq(schema.repos.path, path),
        ),
      );
    if (existing[0]) {
      return existing[0].id;
    }

    const rows = await this.db
      .insert(schema.repos)
      .values({ projectId, name: AGENT_REPO_NAME, path })
      .returning();
    return rows[0].id;
  }
}
