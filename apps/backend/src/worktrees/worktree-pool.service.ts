import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreeInfo, WorktreesService } from './worktrees.service.js';

export type WorktreeLinkStatus = 'linked' | 'unlinked';
export type PendingStashStatus = 'pending' | 'applied' | 'apply_conflicted';

export interface WorktreePoolOwner {
  projectId: number;
  projectName: string;
  repoId: number;
  workspaceId: number;
  workspaceName: string;
  linkStatus: WorktreeLinkStatus;
}

export interface WorktreePoolItem {
  id: number;
  repoRootPath: string;
  path: string;
  name: string;
  createdFromRef: string | null;
  currentBranch: string | null;
  head: string | null;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason: string | null;
  isMissing: boolean;
  isDirty: boolean;
  hasConflicts: boolean;
  statusLoading: boolean;
  runningAgentCount: number;
  /**
   * Sessions still attached to this worktree, whether or not their agent is
   * currently running. A worktree with active sessions is *in use* — reusing it
   * would move the files out from under a session that may still be needed.
   */
  activeSessionCount: number;
  lastUsedAt: string | null;
  /**
   * Most recent session activity on this worktree (state change / completion /
   * row update). Unlike `lastUsedAt` — which is only touched when worktree
   * context is injected into a session's first prompt — this is refreshed by
   * ordinary session activity, so it is the reliable idleness signal.
   */
  lastSessionActivityAt: string | null;
  owner: WorktreePoolOwner | null;
  projectWorkspace: {
    id: number;
    name: string;
    linkStatus: WorktreeLinkStatus;
    desiredBranch: string | null;
    pendingStashCommit: string | null;
    pendingStashMessage: string | null;
    pendingStashCreatedAt: string | null;
    pendingStashStatus: PendingStashStatus | null;
  } | null;
}

interface SessionActivity {
  activeSessionCount: number;
  runningAgentCount: number;
  lastSessionActivityAt: string | null;
}

const NO_SESSION_ACTIVITY: SessionActivity = {
  activeSessionCount: 0,
  runningAgentCount: 0,
  lastSessionActivityAt: null,
};

@Injectable()
export class WorktreePoolService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly worktreesService: WorktreesService,
    private readonly sessionsService: SessionsService,
    private readonly projectsService: ProjectsService,
    private readonly claudeHooksService: ClaudeHooksService,
  ) {}

  async listForRepo(repo: typeof schema.repos.$inferSelect) {
    const items: WorktreePoolItem[] = [];
    await this.streamForRepo(repo, (item) => {
      items.push(item);
    });
    return items.sort((left, right) => left.name.localeCompare(right.name));
  }

  async streamForRepo(
    repo: typeof schema.repos.$inferSelect,
    onItem: (item: WorktreePoolItem) => Promise<void> | void,
  ): Promise<number> {
    const { poolRows, gitByRealPath } = await this.preparePoolListing(repo);

    await Promise.all(
      poolRows.map(async (pool) => {
        const item = await this.buildPoolItem(repo.id, pool, gitByRealPath);
        await onItem(item);
      }),
    );

    return poolRows.length;
  }

  async streamProgressivelyForRepo(
    repo: typeof schema.repos.$inferSelect,
    onItem: (item: WorktreePoolItem) => Promise<void> | void,
  ): Promise<number> {
    const { poolRows, gitByRealPath } = await this.preparePoolListing(repo);

    await Promise.all(
      poolRows.map(async (pool) => {
        const metadata = await this.buildPoolItemMetadata(
          repo.id,
          pool,
          gitByRealPath,
        );
        await onItem(metadata.item);

        if (!metadata.exists) return;
        const status = await this.getWorktreeStatusSnapshot(pool.path);
        const currentBranch =
          status.currentBranch ?? metadata.item.currentBranch;
        await onItem({
          ...metadata.item,
          currentBranch,
          isDetached: metadata.gitInfo?.isDetached ?? currentBranch === null,
          isDirty: status.isDirty,
          hasConflicts: status.hasConflicts,
          statusLoading: false,
        });
      }),
    );

    return poolRows.length;
  }

  private async preparePoolListing(
    repo: typeof schema.repos.$inferSelect,
  ) {
    await this.reconcileRepo(repo);
    const root = await this.realPathOrRaw(repo.path);
    const poolRows = await this.db
      .select()
      .from(schema.repoWorktrees)
      .where(eq(schema.repoWorktrees.repoRootPath, root));

    const gitWorktrees = await this.safeListWorktrees(repo.path);
    const gitByRealPath = new Map<string, WorktreeInfo>();
    for (const worktree of gitWorktrees) {
      gitByRealPath.set(await this.realPathOrRaw(worktree.path), worktree);
    }
    return { poolRows, gitByRealPath };
  }

  private async buildPoolItem(
    repoId: number,
    pool: typeof schema.repoWorktrees.$inferSelect,
    gitByRealPath: Map<string, WorktreeInfo>,
  ): Promise<WorktreePoolItem> {
    const metadata = await this.buildPoolItemMetadata(
      repoId,
      pool,
      gitByRealPath,
    );
    if (!metadata.exists) return metadata.item;

    const status = await this.getWorktreeStatusSnapshot(pool.path);
    const currentBranch = status.currentBranch ?? metadata.item.currentBranch;
    return {
      ...metadata.item,
      currentBranch,
      isDetached: metadata.gitInfo?.isDetached ?? currentBranch === null,
      isDirty: status.isDirty,
      hasConflicts: status.hasConflicts,
      statusLoading: false,
    };
  }

  private async buildPoolItemMetadata(
    repoId: number,
    pool: typeof schema.repoWorktrees.$inferSelect,
    gitByRealPath: Map<string, WorktreeInfo>,
  ) {
    const [realPath, owner, projectWorkspace, exists] = await Promise.all([
      this.realPathOrRaw(pool.path),
      this.findLinkedOwner(pool.id),
      this.findProjectWorkspace(repoId, pool.id),
      this.pathExists(pool.path),
    ]);
    const gitInfo = gitByRealPath.get(realPath) ?? null;
    // Unlinking a worktree archives and stops its sessions, so only an owned
    // worktree can still have sessions attached to it.
    const sessionActivity = owner
      ? await this.summarizeWorkspaceSessions(owner.workspaceId)
      : NO_SESSION_ACTIVITY;
    const currentBranch = gitInfo?.branch ?? null;

    const contextRows = await this.db
      .select({ lastUsedAt: schema.worktreeContexts.lastUsedAt })
      .from(schema.worktreeContexts)
      .where(
        and(
          eq(schema.worktreeContexts.repoId, repoId),
          eq(schema.worktreeContexts.worktreePath, pool.path),
        ),
      )
      .limit(1);
    const lastUsedAt = contextRows[0]?.lastUsedAt ?? null;

    return {
      exists,
      gitInfo,
      item: {
        id: pool.id,
        repoRootPath: pool.repoRootPath,
        path: pool.path,
        name: pool.name,
        createdFromRef: pool.createdFromRef,
        currentBranch,
        head: gitInfo?.head ?? null,
        isDetached: gitInfo?.isDetached ?? currentBranch === null,
        isBare: gitInfo?.isBare ?? false,
        isLocked: gitInfo?.isLocked ?? false,
        lockReason: gitInfo?.lockReason ?? null,
        isMissing: !gitInfo && !exists,
        isDirty: false,
        hasConflicts: false,
        statusLoading: exists,
        runningAgentCount: sessionActivity.runningAgentCount,
        activeSessionCount: sessionActivity.activeSessionCount,
        lastUsedAt,
        lastSessionActivityAt: sessionActivity.lastSessionActivityAt,
        owner,
        projectWorkspace,
      } satisfies WorktreePoolItem,
    };
  }

  async createForRepo(
    repo: typeof schema.repos.$inferSelect,
    input: {
      name: string;
      path?: string;
      startPoint: string;
      branchName?: string;
    },
  ) {
    await this.projectsService.assertProjectIsActive(repo.projectId);
    const name = this.normalizeName(input.name);
    const startPoint = input.startPoint.trim() || 'HEAD';
    const worktreePath =
      input.path?.trim() ||
      path.join(path.dirname(repo.path), '.worktrees', repo.name, this.slugify(name));
    const git = worktreeSimpleGit(repo.path);
    const args = ['worktree', 'add', worktreePath];
    const branchName = input.branchName?.trim();
    if (branchName) {
      this.assertValidBranchName(branchName);
      args.push('-b', branchName, startPoint);
    } else {
      args.push(startPoint);
    }

    try {
      await git.raw(args);
    } catch (error) {
      throw this.gitError('Could not create worktree', error);
    }

    const root = await this.realPathOrRaw(repo.path);
    const realWorktreePath = await this.realPathOrRaw(worktreePath);
    const rows = await this.upsertPoolWorktree({
      repoRootPath: root,
      path: realWorktreePath,
      name,
      createdFromRef: branchName || startPoint,
    });
    const item = (await this.listForRepo(repo)).find(
      (candidate) => candidate.id === rows[0].id,
    );
    if (!item) {
      throw new BadRequestException(
        'Worktree was created but could not be loaded from the pool.',
      );
    }
    return item;
  }

  async linkToProject(
    repo: typeof schema.repos.$inferSelect,
    worktreeId: number,
    input: {
      workspaceName?: string;
      branchName: string;
      confirmTakeover?: boolean;
      confirmStash?: boolean;
      applyPendingStash?: boolean;
    },
  ) {
    await this.projectsService.assertProjectIsActive(repo.projectId);
    const pool = await this.findPoolForRepo(repo, worktreeId);
    const branchName = input.branchName.trim();
    if (!branchName) {
      throw new BadRequestException('Branch name is required');
    }

    const owner = await this.findLinkedWorkspace(pool.id);
    const projectWorkspace = await this.findProjectWorkspace(repo.id, pool.id);
    const ownerIsCurrentProject = owner?.repo.projectId === repo.projectId;
    const now = new Date().toISOString();

    if (owner && !ownerIsCurrentProject) {
      if (!input.confirmTakeover) {
        throw new ConflictException(
          'This worktree is linked to another project. Confirm before taking it over.',
        );
      }
      await this.unlinkOwnerWorkspace(owner, repo.projectId, input.confirmStash);
    }

    if (owner && ownerIsCurrentProject && owner.workspace.id !== projectWorkspace?.id) {
      await this.unlinkOwnerWorkspace(owner, repo.projectId, input.confirmStash);
    }

    const activeWorkspace = projectWorkspace ?? owner?.workspace ?? null;
    if (activeWorkspace && activeWorkspace.linkStatus !== 'unlinked') {
      const status = await this.getWorktreeStatusSnapshot(pool.path);
      if (status.currentBranch !== branchName && status.isDirty) {
        if (!input.confirmStash) {
          throw new ConflictException(
            'This worktree has uncommitted changes. Confirm before stashing and switching branches.',
          );
        }
        const stash = await this.stashChanges(pool.path, activeWorkspace.name);
        if (stash) {
          await this.recordWorkspaceStash(activeWorkspace.id, stash);
        }
      }
    }

    await this.checkoutBranch(repo.path, pool.path, branchName);

    const workspace =
      projectWorkspace ??
      (await this.createLinkedWorkspace(repo, pool, {
        name: input.workspaceName?.trim() || pool.name,
        branchName,
      }));

    await this.db
      .update(schema.workspaces)
      .set({
        path: pool.path,
        name: input.workspaceName?.trim() || workspace.name,
        linkStatus: 'linked',
        desiredBranch: null,
        unlinkedAt: null,
        unlinkedByProjectId: null,
        updatedAt: now,
      })
      .where(eq(schema.workspaces.id, workspace.id));

    const relinked = await this.findWorkspace(workspace.id);
    if (input.applyPendingStash && relinked.pendingStashCommit) {
      await this.applyRecordedStash(pool.path, relinked);
    }

    await this.updateSessionsForWorkspace(workspace.id, branchName, pool.path);
    return this.findWorkspace(workspace.id);
  }

  /**
   * Physically move a pool worktree to a new `.worktrees/<repo>/<slug(name)>`
   * path and rename its pool record, so it stops carrying whatever
   * branch/task it was originally created for. Also repoints everything else
   * keyed by the old path — workspaces, sessions, user terminals, actions and
   * the generated worktree-context row — so nothing is left pointing at a
   * directory that no longer exists.
   */
  async rename(
    repo: typeof schema.repos.$inferSelect,
    worktreeId: number,
    newName: string,
  ) {
    await this.projectsService.assertProjectIsActive(repo.projectId);
    const pool = await this.findPoolForRepo(repo, worktreeId);
    const name = this.normalizeName(newName);
    const newPath = path.join(
      path.dirname(repo.path),
      '.worktrees',
      repo.name,
      this.slugify(name),
    );

    if (await this.samePath(pool.path, newPath)) {
      await this.db
        .update(schema.repoWorktrees)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(schema.repoWorktrees.id, pool.id));
    } else {
      // The main working tree is in the pool too, and git will not move it.
      // Say so before touching anything, so the caller stops instead of
      // retrying with another name.
      if (await this.samePath(pool.path, repo.path)) {
        throw new BadRequestException(
          "This is the repository's main working tree — it cannot be renamed or moved. Rename a pool worktree instead.",
        );
      }

      if (await this.pathExists(newPath)) {
        throw new BadRequestException(
          `A worktree already exists at "${newPath}" — pick a different name.`,
        );
      }

      try {
        await this.worktreesService.moveWorktree(repo.path, pool.path, newPath);
      } catch (error) {
        throw this.gitError('Could not rename worktree', error);
      }

      const realNewPath = await this.realPathOrRaw(newPath);
      const now = new Date().toISOString();

      await this.db
        .update(schema.repoWorktrees)
        .set({ path: realNewPath, name, updatedAt: now })
        .where(eq(schema.repoWorktrees.id, pool.id));

      await this.db
        .update(schema.workspaces)
        .set({ path: realNewPath, updatedAt: now })
        .where(eq(schema.workspaces.poolWorktreeId, pool.id));

      // Sessions, terminals and actions are keyed by the worktree path alone,
      // so they are repointed by path rather than through the workspace: an
      // absolute worktree path is unique, and rows left on the old path would
      // fail with "worktree path does not exist" the next time they are used.
      await this.db
        .update(schema.sessions)
        .set({ worktreePath: realNewPath, updatedAt: now })
        .where(eq(schema.sessions.worktreePath, pool.path));

      await this.db
        .update(schema.userTerminals)
        .set({ worktreePath: realNewPath })
        .where(eq(schema.userTerminals.worktreePath, pool.path));

      await this.db
        .update(schema.actions)
        .set({ worktreePath: realNewPath, updatedAt: now })
        .where(eq(schema.actions.worktreePath, pool.path));

      for (const rootRepo of await this.findReposForRoot(pool.repoRootPath)) {
        await this.db
          .update(schema.worktreeContexts)
          .set({ worktreePath: realNewPath, updatedAt: now })
          .where(
            and(
              eq(schema.worktreeContexts.repoId, rootRepo.id),
              eq(schema.worktreeContexts.worktreePath, pool.path),
            ),
          );
      }
    }

    // The label the user actually reads in the sidebar and tab bar is the
    // linked workspace's name, not the pool name — rename it too, or the
    // rename looks like it did nothing everywhere outside the worktree sheet.
    const linked = await this.findLinkedWorkspace(pool.id);
    if (linked && linked.workspace.name !== name) {
      await this.db
        .update(schema.workspaces)
        .set({
          name: await this.uniqueWorkspaceName(
            linked.workspace.repoId,
            name,
            linked.workspace.id,
          ),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workspaces.id, linked.workspace.id));
    }

    const item = (await this.listForRepo(repo)).find(
      (candidate) => candidate.id === pool.id,
    );
    if (!item) {
      throw new BadRequestException(
        'Worktree was renamed but could not be reloaded from the pool.',
      );
    }
    return item;
  }

  async reconcileRepo(repo: typeof schema.repos.$inferSelect) {
    const root = await this.realPathOrRaw(repo.path);
    const worktrees = await this.safeListWorktrees(repo.path);
    for (const worktree of worktrees) {
      await this.upsertPoolWorktree(
        {
          repoRootPath: root,
          path: await this.realPathOrRaw(worktree.path),
          name: worktree.branch ?? path.basename(worktree.path),
          createdFromRef: worktree.branch ?? worktree.head,
        },
        { keepExistingName: true },
      );
    }

    const reposForRoot = await this.findReposForRoot(root);
    for (const rootRepo of reposForRoot) {
      await this.backfillRepoWorkspaces(rootRepo, root);
    }
  }

  private async unlinkOwnerWorkspace(
    owner: {
      workspace: typeof schema.workspaces.$inferSelect;
      repo: typeof schema.repos.$inferSelect;
    },
    unlinkedByProjectId: number,
    confirmStash?: boolean,
  ) {
    const status = await this.getWorktreeStatusSnapshot(owner.workspace.path);
    if (status.isDirty && !confirmStash) {
      throw new ConflictException(
        'This worktree has uncommitted changes. Confirm before stashing and taking it over.',
      );
    }

    const stash = status.isDirty
      ? await this.stashChanges(owner.workspace.path, owner.workspace.name)
      : null;
    const currentBranch = status.currentBranch;
    await this.sessionsService.archiveAndStopByRepoAndWorktreePath(
      owner.repo.id,
      owner.workspace.path,
    );

    await this.db
      .update(schema.workspaces)
      .set({
        linkStatus: 'unlinked',
        desiredBranch: currentBranch ?? owner.workspace.desiredBranch,
        unlinkedAt: new Date().toISOString(),
        unlinkedByProjectId,
        ...(stash
          ? {
              pendingStashCommit: stash.commit,
              pendingStashMessage: stash.message,
              pendingStashCreatedAt: stash.createdAt,
              pendingStashStatus: 'pending',
            }
          : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, owner.workspace.id));
  }

  private async applyRecordedStash(
    worktreePath: string,
    workspace: typeof schema.workspaces.$inferSelect,
  ) {
    if (!workspace.pendingStashCommit) return;

    try {
      await worktreeSimpleGit(worktreePath).raw([
        'stash',
        'apply',
        workspace.pendingStashCommit,
      ]);
      await this.db
        .update(schema.workspaces)
        .set({
          pendingStashStatus: 'applied',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workspaces.id, workspace.id));
    } catch (error) {
      const status = await this.getWorktreeStatusSnapshot(worktreePath);
      await this.db
        .update(schema.workspaces)
        .set({
          pendingStashStatus: status.hasConflicts ? 'apply_conflicted' : 'pending',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workspaces.id, workspace.id));
      throw this.gitError('Could not apply recorded stash', error);
    }
  }

  private async checkoutBranch(
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ) {
    const checkedOutPath = await this.findBranchWorktreePath(
      repoPath,
      branchName,
      worktreePath,
    );
    if (checkedOutPath) {
      throw new ConflictException(
        `Branch "${branchName}" is already checked out at ${checkedOutPath}. Choose that worktree instead.`,
      );
    }

    try {
      await worktreeSimpleGit(worktreePath).raw(['checkout', branchName]);
    } catch (error) {
      throw this.gitError('Could not switch worktree branch', error);
    }
  }

  private async stashChanges(worktreePath: string, workspaceName: string) {
    const message = `elevenex:${workspaceName}:${new Date().toISOString()}`;
    try {
      await worktreeSimpleGit(worktreePath).raw([
        'stash',
        'push',
        '--include-untracked',
        '-m',
        message,
      ]);
      const commit = (
        await worktreeSimpleGit(worktreePath).raw(['rev-parse', 'stash@{0}'])
      ).trim();
      return {
        commit,
        message,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.gitError('Could not stash worktree changes', error);
    }
  }

  private async recordWorkspaceStash(
    workspaceId: number,
    stash: { commit: string; message: string; createdAt: string },
  ) {
    await this.db
      .update(schema.workspaces)
      .set({
        pendingStashCommit: stash.commit,
        pendingStashMessage: stash.message,
        pendingStashCreatedAt: stash.createdAt,
        pendingStashStatus: 'pending',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  private async backfillRepoWorkspaces(
    repo: typeof schema.repos.$inferSelect,
    root: string,
  ) {
    const workspaces = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repo.id));

    for (const workspace of workspaces) {
      if (workspace.poolWorktreeId) continue;
      const pool = await this.findPoolByPath(root, workspace.path);
      if (!pool) continue;
      await this.db
        .update(schema.workspaces)
        .set({
          poolWorktreeId: pool.id,
          linkStatus: workspace.linkStatus || 'linked',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.workspaces.id, workspace.id));
    }
  }

  private async createLinkedWorkspace(
    repo: typeof schema.repos.$inferSelect,
    pool: typeof schema.repoWorktrees.$inferSelect,
    input: { name: string; branchName: string },
  ) {
    const name = await this.uniqueWorkspaceName(repo.id, input.name);
    const rows = await this.db
      .insert(schema.workspaces)
      .values({
        repoId: repo.id,
        name,
        path: pool.path,
        poolWorktreeId: pool.id,
        isDefault: await this.samePath(repo.path, pool.path),
        createdFromRef: input.branchName,
        linkStatus: 'linked',
      })
      .returning();
    return rows[0];
  }

  private async updateSessionsForWorkspace(
    workspaceId: number,
    branchName: string,
    worktreePath: string,
  ) {
    await this.db
      .update(schema.sessions)
      .set({ branchName, worktreePath, updatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.workspaceId, workspaceId));
  }

  private async findPoolForRepo(
    repo: typeof schema.repos.$inferSelect,
    worktreeId: number,
  ) {
    await this.reconcileRepo(repo);
    const root = await this.realPathOrRaw(repo.path);
    const rows = await this.db
      .select()
      .from(schema.repoWorktrees)
      .where(
        and(
          eq(schema.repoWorktrees.id, worktreeId),
          eq(schema.repoWorktrees.repoRootPath, root),
        ),
      );
    if (rows.length === 0) {
      throw new NotFoundException(`Worktree ${worktreeId} not found`);
    }
    return rows[0];
  }

  private async findPoolByPath(repoRootPath: string, worktreePath: string) {
    const target = await this.realPathOrRaw(worktreePath);
    const rows = await this.db
      .select()
      .from(schema.repoWorktrees)
      .where(eq(schema.repoWorktrees.repoRootPath, repoRootPath));
    for (const row of rows) {
      if ((await this.realPathOrRaw(row.path)) === target) {
        return row;
      }
    }
    return null;
  }

  private async findWorkspace(id: number) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));
    if (rows.length === 0) {
      throw new NotFoundException(`Workspace ${id} not found`);
    }
    return rows[0];
  }

  private async findProjectWorkspace(repoId: number, poolWorktreeId: number) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.repoId, repoId),
          eq(schema.workspaces.poolWorktreeId, poolWorktreeId),
        ),
      );
    const workspace = rows[0] ?? null;
    return workspace
      ? {
          id: workspace.id,
          name: workspace.name,
          linkStatus: workspace.linkStatus as WorktreeLinkStatus,
          desiredBranch: workspace.desiredBranch,
          pendingStashCommit: workspace.pendingStashCommit,
          pendingStashMessage: workspace.pendingStashMessage,
          pendingStashCreatedAt: workspace.pendingStashCreatedAt,
          pendingStashStatus: workspace.pendingStashStatus as PendingStashStatus | null,
        }
      : null;
  }

  private async findLinkedWorkspace(poolWorktreeId: number) {
    const rows = await this.db
      .select({
        workspace: schema.workspaces,
        repo: schema.repos,
      })
      .from(schema.workspaces)
      .innerJoin(schema.repos, eq(schema.workspaces.repoId, schema.repos.id))
      .where(
        and(
          eq(schema.workspaces.poolWorktreeId, poolWorktreeId),
          eq(schema.workspaces.linkStatus, 'linked'),
        ),
      );
    return rows[0] ?? null;
  }

  private async findLinkedOwner(
    poolWorktreeId: number,
  ): Promise<WorktreePoolOwner | null> {
    const rows = await this.db
      .select({
        workspace: schema.workspaces,
        repo: schema.repos,
        project: schema.projects,
      })
      .from(schema.workspaces)
      .innerJoin(schema.repos, eq(schema.workspaces.repoId, schema.repos.id))
      .innerJoin(schema.projects, eq(schema.repos.projectId, schema.projects.id))
      .where(
        and(
          eq(schema.workspaces.poolWorktreeId, poolWorktreeId),
          eq(schema.workspaces.linkStatus, 'linked'),
        ),
      );
    const row = rows[0];
    if (!row) return null;
    return {
      projectId: row.project.id,
      projectName: row.project.name,
      repoId: row.repo.id,
      workspaceId: row.workspace.id,
      workspaceName: row.workspace.name,
      linkStatus: row.workspace.linkStatus as WorktreeLinkStatus,
    };
  }

  /**
   * One query, three signals about the sessions bound to a workspace: how many
   * are attached at all (`activeSessionCount` — the worktree is in use), how
   * many have a non-idle agent right now (`runningAgentCount`), and when any of
   * them last did something (`lastSessionActivityAt` — the idleness signal).
   */
  private async summarizeWorkspaceSessions(
    workspaceId: number,
  ): Promise<SessionActivity> {
    const rows = await this.db
      .select({
        id: schema.sessions.id,
        lastStateChangeAt: schema.sessions.lastStateChangeAt,
        lastCompletionAt: schema.sessions.lastCompletionAt,
        updatedAt: schema.sessions.updatedAt,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, workspaceId),
          eq(schema.sessions.surface, 'session'),
          eq(schema.sessions.status, 'active'),
        ),
      );

    let lastSessionActivityAt: string | null = null;
    for (const row of rows) {
      for (const stamp of [
        row.lastStateChangeAt,
        row.lastCompletionAt,
        row.updatedAt,
      ]) {
        if (
          stamp &&
          (!lastSessionActivityAt || stamp > lastSessionActivityAt)
        ) {
          lastSessionActivityAt = stamp;
        }
      }
    }

    return {
      activeSessionCount: rows.length,
      runningAgentCount: rows.filter(
        (row) => this.claudeHooksService.getStatus(row.id) !== 'idle',
      ).length,
      lastSessionActivityAt,
    };
  }

  private async findReposForRoot(root: string) {
    const repos = await this.db.select().from(schema.repos);
    const result: Array<typeof schema.repos.$inferSelect> = [];
    for (const repo of repos) {
      if ((await this.realPathOrRaw(repo.path)) === root) {
        result.push(repo);
      }
    }
    return result;
  }

  /**
   * `keepExistingName` is for discovery paths (reconcile): the derived name is
   * only a seed for rows we have never seen, and must not overwrite the name a
   * worktree already carries. A pool name is the worktree's own identity,
   * decorrelated from the branch it currently holds — clobbering it here would
   * silently undo every rename on the next listing.
   */
  private async upsertPoolWorktree(
    values: typeof schema.repoWorktrees.$inferInsert,
    options: { keepExistingName?: boolean } = {},
  ) {
    const now = new Date().toISOString();
    return this.db
      .insert(schema.repoWorktrees)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.repoWorktrees.repoRootPath, schema.repoWorktrees.path],
        set: {
          ...(options.keepExistingName ? {} : { name: values.name }),
          createdFromRef: values.createdFromRef,
          updatedAt: now,
        },
      })
      .returning();
  }

  private async safeListWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    try {
      return await this.worktreesService.listWorktrees(repoPath);
    } catch {
      return [];
    }
  }

  private async findBranchWorktreePath(
    repoPath: string,
    branchName: string,
    currentPath: string,
  ): Promise<string | null> {
    for (const worktree of await this.safeListWorktrees(repoPath)) {
      if (worktree.branch !== branchName) continue;
      if (await this.samePath(worktree.path, currentPath)) continue;
      return worktree.path;
    }
    return null;
  }

  private async getWorktreeStatusSnapshot(worktreePath: string): Promise<{
    currentBranch: string | null;
    isDirty: boolean;
    hasConflicts: boolean;
  }> {
    const git = worktreeSimpleGit(worktreePath);
    try {
      // Git's built-in fsmonitor daemon is only supported on Windows and
      // macOS. Some large, shared repositories still set `core.fsmonitor=true`
      // on Linux; Git then falls back to a very expensive full worktree scan.
      // Override that invalid setting for this read only, while preserving
      // hook-based fsmonitor configurations (whose value is a path).
      if (await this.hasUnsupportedBuiltinFsMonitor(git)) {
        const output = await git.raw([
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=normal',
        ]);
        return this.parseStatusPorcelainV2(output);
      }

      const status = await git.status();
      const currentBranch =
        status.current && status.current !== 'HEAD' ? status.current : null;
      return {
        currentBranch,
        isDirty: !status.isClean(),
        hasConflicts: status.conflicted.length > 0,
      };
    } catch {
      return {
        currentBranch: null,
        isDirty: false,
        hasConflicts: false,
      };
    }
  }

  private async hasUnsupportedBuiltinFsMonitor(
    git: ReturnType<typeof worktreeSimpleGit>,
  ): Promise<boolean> {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      return false;
    }
    try {
      const value = await git.raw([
        'config',
        '--type=bool',
        '--get',
        'core.fsmonitor',
      ]);
      return value.trim() === 'true';
    } catch {
      return false;
    }
  }

  private parseStatusPorcelainV2(output: string): {
    currentBranch: string | null;
    isDirty: boolean;
    hasConflicts: boolean;
  } {
    let currentBranch: string | null = null;
    let isDirty = false;
    let hasConflicts = false;

    for (const record of output.split('\0')) {
      if (record.startsWith('# branch.head ')) {
        const branch = record.slice('# branch.head '.length);
        currentBranch = branch === '(detached)' ? null : branch;
      } else if (/^[12u?] /.test(record)) {
        isDirty = true;
        if (record.startsWith('u ')) hasConflicts = true;
      }
    }

    return { currentBranch, isDirty, hasConflicts };
  }

  private async uniqueWorkspaceName(
    repoId: number,
    baseName: string,
    /** Workspace being renamed — its own current name is not a collision. */
    excludeWorkspaceId?: number,
  ) {
    const existing = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repoId));
    const names = new Set(
      existing
        .filter((workspace) => workspace.id !== excludeWorkspaceId)
        .map((workspace) => workspace.name.toLowerCase()),
    );
    let candidate = baseName || 'Workspace';
    let index = 2;
    while (names.has(candidate.toLowerCase())) {
      candidate = `${baseName} ${index}`;
      index += 1;
    }
    return candidate;
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new BadRequestException('Worktree name is required');
    }
    return normalized;
  }

  private slugify(value: string): string {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'worktree'
    );
  }

  private assertValidBranchName(name: string) {
    if (
      !name ||
      /^[.-]/.test(name) ||
      /[\s~^:?*[\\]/.test(name) ||
      name.includes('..') ||
      name.endsWith('/') ||
      name.endsWith('.lock')
    ) {
      throw new BadRequestException(`Invalid branch name: "${name}"`);
    }
  }

  private async samePath(left: string, right: string): Promise<boolean> {
    return (await this.realPathOrRaw(left)) === (await this.realPathOrRaw(right));
  }

  private async realPathOrRaw(value: string): Promise<string> {
    try {
      return await fs.promises.realpath(value);
    } catch {
      return path.resolve(value);
    }
  }

  private async pathExists(value: string): Promise<boolean> {
    try {
      await fs.promises.access(value);
      return true;
    } catch {
      return false;
    }
  }

  private gitError(prefix: string, error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new BadRequestException(`${prefix}: ${message}`);
  }
}
