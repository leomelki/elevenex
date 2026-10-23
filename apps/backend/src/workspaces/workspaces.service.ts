import { isSqliteUniqueConstraintError } from '../database/sqlite-errors.js';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  WorktreeInfo,
  WorktreesService,
} from '../worktrees/worktrees.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { isMissingWorktreePath } from '../worktrees/worktree-path.js';
import { compareWorkspaceOrder } from './workspace-order.js';
import { mapWorktrees } from '../worktrees/worktree-observation.js';
import {
  PendingStashStatus,
  WorktreeLinkStatus,
  WorktreePoolService,
} from '../worktrees/worktree-pool.service.js';

export interface WorkspaceSnapshot {
  archivedAt?: string | null;
  taskState?: string;
  taskBranch?: string | null;
  sourceRef?: string | null;
  checkoutMode?: string;
  startingCommit?: string | null;
  finalCommit?: string | null;
  taskError?: string | null;
  id: number;
  repoId: number;
  name: string;
  path: string;
  isDefault: boolean;
  sortOrder?: number | null;
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
  statusError?: string | null;
  linkStatus: WorktreeLinkStatus;
  desiredBranch: string | null;
  unlinkedAt: string | null;
  unlinkedByProjectId: number | null;
  pendingStashCommit: string | null;
  pendingStashMessage: string | null;
  pendingStashCreatedAt: string | null;
  pendingStashStatus: PendingStashStatus | null;
  branchCheckedOutElsewhere: boolean;
  checkedOutElsewherePath: string | null;
}

type WorkspaceObservation = Pick<
  WorkspaceSnapshot,
  | 'currentBranch'
  | 'head'
  | 'isDetached'
  | 'isBare'
  | 'isLocked'
  | 'lockReason'
  | 'isMissing'
  | 'isDirty'
  | 'hasConflicts'
  | 'statusError'
  | 'branchCheckedOutElsewhere'
  | 'checkedOutElsewherePath'
>;

@Injectable()
export class WorkspacesService {
  private readonly listings = new Map<
    number,
    Promise<
      Map<
        number,
        {
          version: string;
          state: WorkspaceObservation;
        }
      >
    >
  >();
  private readonly sessionReconciliations = new Map<number, Promise<void>>();
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly worktreesService: WorktreesService,
    private readonly sessionsService: SessionsService,
    private readonly projectsService: ProjectsService,
    private readonly worktreePoolService: WorktreePoolService,
  ) {}

  async ensureDefaultWorkspace(repo: typeof schema.repos.$inferSelect) {
    // A short, synchronous SQLite transaction makes read/create atomic even
    // across service instances. Git and filesystem work stay outside it.
    const workspace = this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.repoId, repo.id),
              eq(schema.workspaces.isDefault, true),
            ),
          )
          .get();
        if (existing) return existing;
        const created = tx
          .insert(schema.workspaces)
          .values({
            repoId: repo.id,
            name: 'Main checkout',
            path: repo.path,
            isDefault: true,
            createdFromRef: 'HEAD',
          })
          .returning()
          .get()!;
        tx.update(schema.sessions)
          .set({ workspaceId: created.id })
          .where(
            and(
              eq(schema.sessions.repoId, repo.id),
              eq(schema.sessions.worktreePath, repo.path),
              isNull(schema.sessions.workspaceId),
            ),
          )
          .run();
        return created;
      },
      { behavior: 'immediate' },
    );
    return workspace;
  }

  async listForRepo(
    repo: typeof schema.repos.$inferSelect,
  ): Promise<WorkspaceSnapshot[]> {
    let pending = this.listings.get(repo.id);
    if (!pending) {
      pending = this.observeRepo(repo).finally(() => {
        if (this.listings.get(repo.id) === pending)
          this.listings.delete(repo.id);
      });
      this.listings.set(repo.id, pending);
    }
    const observations = await pending;
    // Share expensive observations, never task ownership. Tasks can finish,
    // reopen, or acquire a different checkout while a status scan is running.
    const rows = await this.activeRows(repo.id);
    return rows
      .map((workspace) => {
        const observed = observations.get(workspace.id);
        const snapshot = this.toCachedSnapshot(workspace);
        if (
          workspace.linkStatus !== 'linked' ||
          workspace.taskState !== 'ready'
        )
          return snapshot;
        return observed?.version === this.checkoutVersion(workspace)
          ? { ...snapshot, ...observed.state }
          : {
              ...snapshot,
              isDirty: true,
              hasConflicts: true,
              statusError:
                'The checkout assignment changed during observation. Refresh to inspect its current state.',
            };
      })
      .sort(compareWorkspaceOrder);
  }

  private activeRows(repoId: number) {
    return this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.repoId, repoId),
          isNull(schema.workspaces.archivedAt),
        ),
      );
  }

  private checkoutVersion(workspace: typeof schema.workspaces.$inferSelect) {
    return JSON.stringify([
      workspace.path,
      workspace.poolWorktreeId,
      workspace.linkStatus,
      workspace.taskState,
      workspace.taskRequestId,
      workspace.taskConfig,
      workspace.archivedAt,
      workspace.unlinkedAt,
    ]);
  }

  private async observeRepo(repo: typeof schema.repos.$inferSelect) {
    await this.ensureDefaultWorkspace(repo);
    await this.reconcileSessionWorktrees(repo);
    // Reconciliation and display use the same successful Git worktree list.
    return this.worktreePoolService.withRepoObservation(
      repo,
      async (observation) => {
        const byRealPath = await this.indexWorktreesByRealPath(
          observation.worktrees,
        );
        const branches = new Map<
          string,
          Array<{ key: string; path: string }>
        >();
        for (const [key, info] of byRealPath) {
          if (!info.branch) continue;
          const entries = branches.get(info.branch) ?? [];
          entries.push({ key, path: info.path });
          branches.set(info.branch, entries);
        }
        const rows = (await this.activeRows(repo.id)).filter(
          (workspace) =>
            workspace.linkStatus === 'linked' &&
            workspace.taskState === 'ready',
        );
        const statuses = new Map<
          string,
          Promise<{
            isMissing: boolean;
            currentBranch: string | null;
            isDirty: boolean;
            hasConflicts: boolean;
            error: string | null;
          }>
        >();
        const observations = await mapWorktrees(rows, async (workspace) => {
          const key = await this.realPathOrRaw(workspace.path);
          const gitInfo = byRealPath.get(key);
          let pending = statuses.get(key);
          if (!pending) {
            pending = (async () => {
              const isMissing = !gitInfo && !(await this.pathExists(key));
              const status = isMissing
                ? {
                    currentBranch: null,
                    isDirty: false,
                    hasConflicts: false,
                    error: null,
                  }
                : await observation.status(key);
              return { ...status, isMissing };
            })();
            statuses.set(key, pending);
          }
          const status = await pending;
          const currentBranch = status.error
            ? (gitInfo?.branch ?? null)
            : status.currentBranch;
          const elsewhere = currentBranch
            ? (branches.get(currentBranch)?.find((entry) => entry.key !== key)
                ?.path ?? null)
            : null;
          return [
            workspace.id,
            {
              version: this.checkoutVersion(workspace),
              state: {
                currentBranch,
                head: gitInfo?.head ?? null,
                isDetached: gitInfo?.isDetached ?? currentBranch === null,
                isBare: gitInfo?.isBare ?? false,
                isLocked: gitInfo?.isLocked ?? false,
                lockReason: gitInfo?.lockReason ?? null,
                isMissing: status.isMissing,
                isDirty: status.isDirty,
                hasConflicts: status.hasConflicts,
                statusError: status.error,
                branchCheckedOutElsewhere: elsewhere !== null,
                checkedOutElsewherePath: elsewhere,
              },
            },
          ] as const;
        });
        return new Map(observations);
      },
    );
  }

  async listCachedForRepo(
    repo: typeof schema.repos.$inferSelect,
  ): Promise<WorkspaceSnapshot[]> {
    await this.ensureDefaultWorkspace(repo);
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.repoId, repo.id),
          isNull(schema.workspaces.archivedAt),
        ),
      );

    return rows
      .map((workspace) => this.toCachedSnapshot(workspace))
      .sort(compareWorkspaceOrder);
  }

  async findOne(id: number) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, id));

    if (rows.length === 0) {
      throw new NotFoundException(`Workspace with id ${id} not found`);
    }

    return rows[0];
  }

  async createWorkspace(
    repo: typeof schema.repos.$inferSelect,
    input: {
      name: string;
      path?: string;
      startPoint?: string;
      createBranch?: boolean;
      branchName?: string;
    },
  ) {
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const name = this.normalizeName(input.name);
    const startPoint = input.startPoint?.trim() || 'HEAD';
    const workspacePath =
      input.path?.trim() ||
      path.join(
        path.dirname(repo.path),
        '.worktrees',
        repo.name,
        this.slugify(name),
      );
    const git = worktreeSimpleGit(repo.path);

    if (await this.pathExists(workspacePath)) {
      throw new ConflictException(
        'A folder already exists at this workspace path.',
      );
    }

    const branchName = input.branchName?.trim();
    const args = ['worktree', 'add', workspacePath];
    if (input.createBranch && branchName) {
      this.assertValidBranchName(branchName);
      args.push('-b', branchName, startPoint);
    } else {
      args.push(startPoint);
    }

    try {
      await git.raw(args);
    } catch (error) {
      throw this.gitError('Could not create workspace', error);
    }

    const rows = await this.insertWorkspace({
      repoId: repo.id,
      name,
      path: workspacePath,
      isDefault: false,
      createdFromRef:
        input.createBranch && branchName ? branchName : startPoint,
    });

    return rows[0];
  }

  async attachExistingWorkspace(
    repo: typeof schema.repos.$inferSelect,
    input: {
      path: string;
      name?: string;
    },
  ) {
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const requestedPath = input.path.trim();
    if (!requestedPath) {
      throw new BadRequestException('Workspace path is required');
    }

    const matchedWorktree = await this.findGitWorktree(
      repo.path,
      requestedPath,
    );
    if (!matchedWorktree) {
      throw new BadRequestException(
        'Path is not a git worktree for this repository.',
      );
    }

    if (await this.samePath(matchedWorktree.path, repo.path)) {
      return this.ensureDefaultWorkspace(repo);
    }

    const existing = await this.findWorkspaceByRepoAndRealPath(
      repo.id,
      matchedWorktree.path,
    );
    if (existing) {
      return existing;
    }

    const name = await this.uniqueWorkspaceName(
      repo.id,
      input.name?.trim() || this.nameFromWorktree(repo, matchedWorktree),
    );

    const rows = await this.insertWorkspace({
      repoId: repo.id,
      name,
      path: matchedWorktree.path,
      isDefault: false,
      createdFromRef: matchedWorktree.branch ?? matchedWorktree.head,
    });

    await this.backfillSessionsForWorkspace(
      repo.id,
      rows[0].id,
      matchedWorktree.path,
    );
    return rows[0];
  }

  async renameWorkspace(id: number, name: string, repoId?: number) {
    const workspace = await this.findOneForRepo(id, repoId);
    if (workspace.isDefault)
      throw new BadRequestException('The main checkout has a fixed name.');
    const repo = await this.findRepo(workspace.repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const rows = await this.db
      .update(schema.workspaces)
      .set({
        name: this.normalizeName(name),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspace.id))
      .returning();
    return rows[0];
  }

  async switchBranch(
    id: number,
    branchName: string,
    force = false,
    repoId?: number,
  ) {
    const workspace = await this.findOneForRepo(id, repoId);
    const repo = await this.findRepo(workspace.repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);
    this.assertLinked(workspace);
    if (workspace.taskRequestId)
      throw new BadRequestException(
        'Start another task to work on a different branch.',
      );

    const branch = branchName.trim();
    if (!branch) {
      throw new BadRequestException('Branch name is required');
    }

    const dirty = await this.isDirty(workspace.path);
    if (dirty && !force) {
      throw new BadRequestException(
        'Workspace has uncommitted changes. Confirm before switching branches.',
      );
    }

    const checkedOutPath = await this.findBranchWorktreePath(
      repo.path,
      branch,
      workspace.path,
    );
    if (checkedOutPath) {
      throw new ConflictException(
        `Branch "${branch}" is already checked out at ${checkedOutPath}`,
      );
    }

    try {
      await worktreeSimpleGit(workspace.path).raw(['checkout', branch]);
    } catch (error) {
      throw this.gitError('Could not switch branch', error);
    }

    await this.updateSessionsBranch(workspace.id, branch);
    return this.findOne(id);
  }

  async createBranch(
    workspaceId: number,
    input: {
      branchName: string;
      startPoint?: string;
      destination: 'current-workspace' | 'new-workspace' | 'branch-only';
      workspaceName?: string;
      workspacePath?: string;
    },
    repoId?: number,
  ) {
    const workspace = await this.findOneForRepo(workspaceId, repoId);
    const repo = await this.findRepo(workspace.repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);
    this.assertLinked(workspace);

    const branchName = input.branchName.trim();
    this.assertValidBranchName(branchName);
    const startPoint = input.startPoint?.trim() || 'HEAD';

    if (input.destination === 'branch-only') {
      try {
        await worktreeSimpleGit(repo.path).branch([branchName, startPoint]);
      } catch (error) {
        throw this.gitError('Could not create branch', error);
      }
      return { branchName, workspace: null };
    }

    if (input.destination === 'new-workspace') {
      const nextWorkspace = await this.createWorkspace(repo, {
        name: input.workspaceName?.trim() || branchName,
        path: input.workspacePath,
        startPoint,
        createBranch: true,
        branchName,
      });
      return { branchName, workspace: nextWorkspace };
    }

    if (workspace.taskRequestId)
      throw new BadRequestException(
        'Start another task to work on a different branch.',
      );
    const dirty = await this.isDirty(workspace.path);
    if (dirty) {
      throw new BadRequestException(
        'Workspace has uncommitted changes. Create a new workspace or clean it before checking out a new branch.',
      );
    }

    try {
      await worktreeSimpleGit(workspace.path).checkoutBranch(
        branchName,
        startPoint,
      );
    } catch (error) {
      throw this.gitError('Could not create branch', error);
    }

    await this.updateSessionsBranch(workspace.id, branchName);
    return { branchName, workspace: await this.findOne(workspace.id) };
  }

  async deleteWorkspace(id: number, removeFromDisk: boolean, repoId?: number) {
    const workspace = await this.findOneForRepo(id, repoId);
    if (workspace.taskRequestId || workspace.archivedAt)
      throw new BadRequestException('Finish the task to preserve its history.');
    const history = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.path, workspace.path),
          eq(schema.workspaces.linkStatus, 'unlinked'),
        ),
      );
    if (history.length)
      throw new BadRequestException(
        'This worktree has task history. Finish its current task instead.',
      );
    const repo = await this.findRepo(workspace.repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);

    if (workspace.isDefault && removeFromDisk) {
      throw new BadRequestException(
        'The default workspace cannot be deleted from disk.',
      );
    }
    if (workspace.isDefault) {
      throw new BadRequestException(
        'The default workspace cannot be removed from the project.',
      );
    }
    if (removeFromDisk) {
      await this.worktreesService.removeWorktree(repo.path, workspace.path);
    }

    await this.sessionsService.deleteByRepoAndWorktreePath(
      workspace.repoId,
      workspace.path,
    );

    await this.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspace.id));

    return { success: true };
  }

  async backfillSessionsForWorkspace(
    repoId: number,
    workspaceId: number,
    worktreePath: string,
  ) {
    await this.db
      .update(schema.sessions)
      .set({ workspaceId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.sessions.repoId, repoId),
          eq(schema.sessions.worktreePath, worktreePath),
          isNull(schema.sessions.workspaceId),
        ),
      );
  }

  private async reconcileSessionWorktrees(
    repo: typeof schema.repos.$inferSelect,
  ) {
    const existing = this.sessionReconciliations.get(repo.id);
    if (existing) return existing;
    const pending = this.reconcileSessions(repo).finally(() => {
      if (this.sessionReconciliations.get(repo.id) === pending)
        this.sessionReconciliations.delete(repo.id);
    });
    this.sessionReconciliations.set(repo.id, pending);
    return pending;
  }

  private async reconcileSessions(repo: typeof schema.repos.$inferSelect) {
    const sessions = await this.sessionsService.findByRepo(repo.id);
    const paths = new Map<
      string,
      { raw: Set<string>; branch: string | null }
    >();
    for (const session of sessions) {
      if (session.workspaceId) continue;
      const key = await this.realPathOrRaw(session.worktreePath);
      const entry = paths.get(key) ?? {
        raw: new Set<string>(),
        branch: session.branchName,
      };
      entry.raw.add(session.worktreePath);
      paths.set(key, entry);
    }
    if (!paths.size) return;
    const existing = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repo.id));
    const canonical = new Map(
      await mapWorktrees(
        existing,
        async (workspace) =>
          [
            workspace.id,
            {
              path: workspace.path,
              key: await this.realPathOrRaw(workspace.path),
            },
          ] as const,
      ),
    );
    const present = new Set<string>();
    await mapWorktrees([...paths.keys()], async (key) => {
      if (!(await isMissingWorktreePath(key))) present.add(key);
    });
    // Recheck rows and session membership inside the transaction, after all
    // async reads. Path uniqueness cannot be global: finished tasks keep paths.
    this.db.transaction(
      (tx) => {
        const rows = tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.repoId, repo.id))
          .all();
        const unassigned = tx
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.repoId, repo.id),
              isNull(schema.sessions.workspaceId),
            ),
          )
          .all();
        const unassignedPaths = new Set(
          unassigned.map((session) => session.worktreePath),
        );
        const names = new Set(rows.map((row) => row.name.toLowerCase()));
        const workspacePaths = new Set(
          rows.map((row) =>
            canonical.get(row.id)?.path === row.path
              ? canonical.get(row.id)!.key
              : path.resolve(row.path),
          ),
        );
        for (const [key, entry] of paths) {
          if (
            !present.has(key) ||
            workspacePaths.has(key) ||
            ![...entry.raw].some((raw) => unassignedPaths.has(raw))
          )
            continue;
          const base = path.basename(key) || entry.branch || 'workspace';
          let name = base;
          let suffix = 2;
          while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`;
          const workspace = tx
            .insert(schema.workspaces)
            .values({
              repoId: repo.id,
              name,
              path: key,
              isDefault: false,
              createdFromRef: entry.branch,
            })
            .returning()
            .get()!;
          names.add(name.toLowerCase());
          workspacePaths.add(key);
          for (const raw of entry.raw) {
            tx.update(schema.sessions)
              .set({ workspaceId: workspace.id })
              .where(
                and(
                  eq(schema.sessions.repoId, repo.id),
                  eq(schema.sessions.worktreePath, raw),
                  isNull(schema.sessions.workspaceId),
                ),
              )
              .run();
          }
        }
      },
      { behavior: 'immediate' },
    );
  }

  private async insertWorkspace(values: typeof schema.workspaces.$inferInsert) {
    try {
      return await this.db.insert(schema.workspaces).values(values).returning();
    } catch (error) {
      if (isSqliteUniqueConstraintError(error)) {
        throw new ConflictException(
          'A workspace with this name or path already exists.',
        );
      }
      throw error;
    }
  }

  private async findRepo(repoId: number) {
    const rows = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, repoId));
    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${repoId} not found`);
    }
    return rows[0];
  }

  private async findOneForRepo(id: number, repoId?: number) {
    const workspace = await this.findOne(id);
    if (repoId !== undefined && workspace.repoId !== repoId) {
      throw new NotFoundException(`Workspace with id ${id} not found`);
    }
    return workspace;
  }

  private async findWorkspaceByRepoAndRealPath(
    repoId: number,
    worktreePath: string,
  ) {
    const rows = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repoId));
    const target = await this.realPathOrRaw(worktreePath);
    for (const workspace of rows) {
      if (workspace.archivedAt || workspace.linkStatus === 'unlinked') continue;
      if ((await this.realPathOrRaw(workspace.path)) === target) {
        return workspace;
      }
    }
    return null;
  }

  private async findGitWorktree(
    repoPath: string,
    worktreePath: string,
  ): Promise<WorktreeInfo | null> {
    const target = await this.realPathOrRaw(worktreePath);
    for (const worktree of await this.safeListWorktrees(repoPath)) {
      if ((await this.realPathOrRaw(worktree.path)) === target) {
        return worktree;
      }
    }
    return null;
  }

  private async safeListWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    try {
      return await this.worktreesService.listWorktrees(repoPath);
    } catch {
      return [];
    }
  }

  private async indexWorktreesByRealPath(worktrees: WorktreeInfo[]) {
    return new Map(
      await mapWorktrees(
        worktrees,
        async (worktree) =>
          [await this.realPathOrRaw(worktree.path), worktree] as const,
      ),
    );
  }

  private async isDirty(workspacePath: string): Promise<boolean> {
    return (await this.worktreePoolService.requireWorktreeStatus(workspacePath))
      .isDirty;
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

  private async updateSessionsBranch(workspaceId: number, branchName: string) {
    await this.db
      .update(schema.sessions)
      .set({ branchName, updatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.workspaceId, workspaceId));
  }

  private normalizeName(name: string): string {
    const normalized = name.trim();
    if (!normalized) {
      throw new BadRequestException('Workspace name is required');
    }
    return normalized;
  }

  private assertLinked(workspace: typeof schema.workspaces.$inferSelect) {
    if (workspace.archivedAt)
      throw new BadRequestException(
        'Reopen this task before using its worktree.',
      );
    if (workspace.taskState && workspace.taskState !== 'ready')
      throw new BadRequestException('This task worktree is not ready.');
    if (workspace.linkStatus === 'unlinked') {
      throw new BadRequestException(
        'Workspace is unlinked from its worktree. Link it back before using it.',
      );
    }
  }

  private slugify(value: string): string {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'workspace'
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

  private nameFromWorktree(
    repo: typeof schema.repos.$inferSelect,
    worktree: WorktreeInfo,
  ): string {
    if (worktree.path === repo.path) return 'Default';
    return path.basename(worktree.path) || worktree.branch || 'workspace';
  }

  private toCachedSnapshot(
    workspace: typeof schema.workspaces.$inferSelect,
  ): WorkspaceSnapshot {
    const branchLikeRef =
      workspace.createdFromRef && workspace.createdFromRef !== 'HEAD'
        ? workspace.createdFromRef
        : null;

    return {
      ...this.taskMetadata(workspace),
      id: workspace.id,
      repoId: workspace.repoId,
      name: workspace.name,
      path: workspace.path,
      isDefault: workspace.isDefault,
      createdFromRef: workspace.createdFromRef,
      currentBranch:
        workspace.taskBranch ?? workspace.desiredBranch ?? branchLikeRef,
      head: workspace.finalCommit ?? workspace.startingCommit,
      isDetached: workspace.checkoutMode === 'snapshot',
      isBare: false,
      isLocked: false,
      lockReason: null,
      isMissing: false,
      isDirty: false,
      hasConflicts: false,
      linkStatus: workspace.linkStatus as WorktreeLinkStatus,
      desiredBranch: workspace.desiredBranch,
      unlinkedAt: workspace.unlinkedAt,
      unlinkedByProjectId: workspace.unlinkedByProjectId,
      pendingStashCommit: workspace.pendingStashCommit,
      pendingStashMessage: workspace.pendingStashMessage,
      pendingStashCreatedAt: workspace.pendingStashCreatedAt,
      pendingStashStatus:
        workspace.pendingStashStatus as PendingStashStatus | null,
      branchCheckedOutElsewhere: false,
      checkedOutElsewherePath: null,
    };
  }

  private taskMetadata(workspace: typeof schema.workspaces.$inferSelect) {
    return {
      sortOrder: workspace.sortOrder,
      archivedAt: workspace.archivedAt,
      taskState: workspace.taskState,
      taskBranch: workspace.taskBranch,
      sourceRef: workspace.sourceRef,
      checkoutMode: workspace.checkoutMode,
      startingCommit: workspace.startingCommit,
      finalCommit: workspace.finalCommit,
      taskError: workspace.taskError,
    };
  }

  private async uniqueWorkspaceName(
    repoId: number,
    baseName: string,
  ): Promise<string> {
    const existing = await this.db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.repoId, repoId));
    const names = new Set(
      existing.map((workspace) => workspace.name.toLowerCase()),
    );
    let candidate = baseName || 'Workspace';
    let index = 2;
    while (names.has(candidate.toLowerCase())) {
      candidate = `${baseName} ${index}`;
      index += 1;
    }
    return candidate;
  }

  private async samePath(a: string, b: string): Promise<boolean> {
    return (await this.realPathOrRaw(a)) === (await this.realPathOrRaw(b));
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
