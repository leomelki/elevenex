import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { WorktreesService } from '../worktrees/worktrees.service.js';
import { WorktreePoolService } from '../worktrees/worktree-pool.service.js';
import { TaskGitService, WorktreeStatus } from './task-git.service.js';
import { TaskSetup } from './task.types.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionsService } from '../actions/actions.service.js';
import { isSqliteUniqueConstraintError } from '../database/sqlite-errors.js';
import { mapWorktrees } from '../worktrees/worktree-observation.js';
import { isMissingWorktreePath } from '../worktrees/worktree-path.js';

type Task = typeof schema.workspaces.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;
type Allocation = {
  path: string;
  poolId: number;
  managed: boolean;
  /** Observed while allocating, so preparation need not rescan the checkout. */
  status?: WorktreeStatus;
};

@Injectable()
export class TaskWorktreeAllocator {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly git: TaskGitService,
    private readonly worktrees: WorktreesService,
    private readonly pool: WorktreePoolService,
    private readonly hooks: ClaudeHooksService,
    private readonly terminals: UserPtyManager,
    private readonly actions: ActionsService,
  ) {}

  async allocate(
    repo: Repo,
    task: Task,
    setup: TaskSetup,
    key: string,
  ): Promise<Allocation> {
    const branch =
      setup.checkoutMode === 'snapshot' ? null : setup.localBranch!;
    const listed = await this.recoverMissingRegistration(
      repo.path,
      task,
      branch,
    );
    const available = await mapWorktrees(listed, async (entry) => {
      try {
        return { entry, realPath: await fs.realpath(entry.path) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (entry.branch === branch && code !== 'ENOENT' && code !== 'ENOTDIR')
          throw new ConflictException({
            code: 'checkout_unavailable',
            message:
              'This branch’s worktree cannot be accessed. Restore access or work at its committed revision.',
            canSnapshot: true,
          });
        // Keep its raw registration in listed so its path cannot be reused.
        return null;
      }
    });
    const checked = available.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    const registered = checked.map((item) => item.entry);
    if (
      branch &&
      listed.some((entry) => entry.branch === branch) &&
      !registered.some((entry) => entry.branch === branch)
    )
      throw new ConflictException({
        code: 'checkout_unavailable',
        message:
          'This branch is still registered in a missing worktree. Restore that worktree or work at its committed revision.',
        canSnapshot: true,
      });
    const realRoot = await fs.realpath(repo.path);
    const paths = checked.map((item) => item.realPath);
    const owners = paths.length
      ? await this.db
          .select()
          .from(schema.workspaces)
          .where(
            and(
              inArray(schema.workspaces.path, paths),
              eq(schema.workspaces.linkStatus, 'linked'),
            ),
          )
      : [];
    const pools = paths.length
      ? await this.db
          .select()
          .from(schema.repoWorktrees)
          .where(inArray(schema.repoWorktrees.path, paths))
      : [];
    // A missing directory is not a free assignment. Leases also cover setup
    // interrupted before a Git registration or pool row could be recorded.
    const reservations = await this.db
      .select()
      .from(schema.taskReservations)
      .where(eq(schema.taskReservations.repositoryKey, key));
    const branchOwner =
      branch &&
      reservations.find(
        (lease) =>
          lease.repositoryKey === key &&
          lease.branchName === branch &&
          lease.taskId !== task.id,
      );
    if (branchOwner) throw this.branchConflict(branchOwner.taskId);
    const ownedByOther = (candidate: string) =>
      owners.find(
        (owner) =>
          owner.path === candidate && owner.id !== task.id && !owner.isDefault,
      );
    // No task or process uses these, so status may save its index caches.
    const unassignedManaged = (
      candidate: string,
      pool: (typeof pools)[number] | undefined,
    ) =>
      !!pool?.managed &&
      candidate !== realRoot &&
      !owners.some((owner) => owner.path === candidate);
    const matching = branch
      ? registered.find((entry) => entry.branch === branch)
      : undefined;
    if (matching) {
      const realPath = await fs.realpath(matching.path);
      const owner = ownedByOther(realPath);
      if (owner)
        throw new ConflictException({
          code: 'branch_in_use',
          message: `This branch is used by “${owner.name}”.`,
          existingTaskId: owner.id,
          canSnapshot: true,
        });
      if (await this.isBusy(realPath))
        throw new ConflictException({
          code: 'environment_busy',
          message:
            'This checkout has running work. Stop it first or start at the committed revision.',
          canSnapshot: true,
        });
      const pool = pools.find((entry) => entry.path === realPath);
      if ((!pool?.managed || realPath === realRoot) && !setup.confirmExternal) {
        throw new ConflictException({
          code: 'external_checkout',
          message: 'This branch is checked out in an external worktree.',
          path: realPath,
          canSnapshot: true,
        });
      }
      if (matching.isLocked || matching.isBare)
        throw new ConflictException('This checkout is locked or unavailable.');
      const status = await this.git.status(realPath, {
        persistIndex: unassignedManaged(realPath, pool),
      });
      if (
        status.dirty &&
        !setup.confirmExternal &&
        !(task.path === realPath && task.linkStatus === 'linked')
      )
        throw new ConflictException({
          code: 'external_checkout',
          message:
            'This checkout contains local edits. Use it explicitly or review the committed revision.',
          path: realPath,
          canSnapshot: true,
        });
      const poolId =
        pool?.id ??
        (
          await this.db
            .insert(schema.repoWorktrees)
            .values({
              repoRootPath: realRoot,
              path: realPath,
              name: path.basename(realPath),
              managed: false,
            })
            .returning()
        )[0].id;
      await this.reserve(task.id, key, branch, realPath);
      return {
        path: realPath,
        poolId,
        managed: pool?.managed ?? false,
        status,
      };
    }

    // Reconcile a task's own interrupted assignment before selecting another slot.
    const lease = reservations.find((entry) => entry.taskId === task.id);
    const interrupted =
      lease && checked.find((item) => item.realPath === lease.path);
    if (interrupted) {
      let pool = pools.find((entry) => entry.path === interrupted.realPath);
      if (
        setup.environment !== 'new' &&
        (setup.environment !== 'existing' || pool?.id === setup.worktreeId) &&
        interrupted.realPath !== realRoot &&
        (pool?.managed || !pool || setup.confirmExternal)
      ) {
        const owner = ownedByOther(interrupted.realPath);
        if (owner) throw this.branchConflict(owner.id);
        if (interrupted.entry.isBare || interrupted.entry.isLocked)
          throw new ConflictException(
            'The worktree from interrupted setup is locked or unavailable.',
          );
        if (await this.isBusy(interrupted.realPath))
          throw new ConflictException({
            code: 'environment_busy',
            message:
              'The worktree from interrupted setup has running work. Stop it before retrying.',
            canSnapshot: true,
          });
        const status = await this.git.status(interrupted.realPath, {
          persistIndex: unassignedManaged(interrupted.realPath, pool),
        });
        if (!status.dirty && !status.conflicts) {
          // Reservation + registration can precede the pool insert on crash.
          pool ??= (
            await this.db
              .insert(schema.repoWorktrees)
              .values({
                repoRootPath: realRoot,
                path: interrupted.realPath,
                name: path.basename(interrupted.realPath),
                managed: true,
                createdFromRef: setup.resolvedCommit,
              })
              .returning()
          )[0];
          await this.reserve(task.id, key, branch, interrupted.realPath);
          return {
            path: interrupted.realPath,
            poolId: pool.id,
            managed: pool.managed,
            status,
          };
        }
        throw new ConflictException({
          code: 'worktree_not_clean',
          message:
            'The worktree from interrupted setup contains local changes. Keep those changes before retrying, or choose a new worktree in Change setup.',
        });
      }
    }

    const candidates = registered
      .map((entry, index) => ({
        entry,
        realPath: paths[index],
        pool: pools.find((pool) => pool.path === paths[index]),
      }))
      .filter(
        ({ entry, realPath, pool }) =>
          !entry.isBare &&
          !entry.isLocked &&
          realPath !== realRoot &&
          pool &&
          !ownedByOther(realPath) &&
          !reservations.some(
            (lease) => lease.path === realPath && lease.taskId !== task.id,
          ) &&
          (setup.environment === 'existing'
            ? pool.id === setup.worktreeId
            : setup.environment !== 'new' && pool.managed),
      );
    // Checkout cost scales with the files it rewrites. In a fast-moving
    // repository, a checkout a week behind can differ by tens of thousands
    // of files, so prefer the one closest to the target revision. Measure
    // each usable revision once; unreachable ones (Infinity) tie on pool id.
    const heads = [
      ...new Set(
        candidates
          .filter(({ pool }) => pool!.managed || setup.confirmExternal)
          .map(({ entry }) => entry.head),
      ),
    ];
    const distances = new Map(
      heads.length > 1 && setup.resolvedCommit
        ? await Promise.all(
            heads.map(
              async (head) =>
                [
                  head,
                  await this.git.changedPathCount(
                    repo.path,
                    head,
                    setup.resolvedCommit!,
                  ),
                ] as const,
            ),
          )
        : [],
    );
    candidates.sort(
      (a, b) =>
        (distances.get(a.entry.head) ?? 0) -
          (distances.get(b.entry.head) ?? 0) || a.pool!.id - b.pool!.id,
    );
    for (const candidate of candidates) {
      if (!candidate.pool!.managed && !setup.confirmExternal) continue;
      if (await this.isBusy(candidate.realPath)) continue;
      const status = await this.git.status(candidate.realPath, {
        persistIndex: unassignedManaged(candidate.realPath, candidate.pool),
      });
      if (status.dirty || status.conflicts) continue;
      try {
        await this.reserve(task.id, key, branch, candidate.realPath);
      } catch (error) {
        if (this.isPathConflict(error) && setup.environment !== 'existing')
          continue;
        throw error;
      }
      // Ownership/status can change while the frontend is open. Never force checkout.
      return {
        path: candidate.realPath,
        poolId: candidate.pool!.id,
        managed: candidate.pool!.managed,
        status,
      };
    }
    if (setup.environment === 'existing')
      throw new ConflictException(
        'The selected worktree is in use or has local changes. Choose another worktree.',
      );
    await this.pool.assertWithinWorktreeLimit(repo, setup.confirmOverLimit);
    const poolRows = await this.db
      .select({
        name: schema.repoWorktrees.name,
        path: schema.repoWorktrees.path,
      })
      .from(schema.repoWorktrees)
      .where(eq(schema.repoWorktrees.repoRootPath, realRoot));
    const existingNames = new Set(
      poolRows.map((entry) => entry.name.trim().toLowerCase()),
    );
    const assignments = await this.db
      .select({ path: schema.workspaces.path })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.repoId, repo.id),
          eq(schema.workspaces.linkStatus, 'linked'),
          ne(schema.workspaces.id, task.id),
        ),
      );
    const existingPaths = new Set(
      [...listed, ...poolRows, ...reservations, ...assignments].map((entry) =>
        path.resolve(entry.path).toLowerCase(),
      ),
    );
    const baseName = repo.name.trim() || 'worktree';
    let worktreeName: string;
    let worktreePath: string;
    // Match the pool creation defaults; a worktree's identity survives task reuse.
    for (let index = 1; ; index++) {
      worktreeName = `${baseName} ${index}`;
      const slug = worktreeName
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      worktreePath = path.join(
        path.dirname(realRoot),
        '.worktrees',
        repo.name,
        slug,
      );
      if (
        !existingNames.has(worktreeName.toLowerCase()) &&
        !existingPaths.has(worktreePath.toLowerCase()) &&
        !(await this.pathExists(worktreePath))
      ) {
        try {
          await this.reserve(task.id, key, branch, worktreePath);
          break;
        } catch (error) {
          // Another backend can reserve the same name after our read. Retry
          // only path contention; branch and storage failures need attention.
          if (!this.isPathConflict(error)) throw error;
          existingPaths.add(worktreePath.toLowerCase());
        }
      }
    }
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const git = worktreeSimpleGit(repo.path);
    // A failed add may leave a registration and partial files. Keep its lease
    // and report the failure; an explicit retry revalidates that checkout.
    await git.raw([
      'worktree',
      'add',
      '--quiet',
      '--detach',
      worktreePath,
      setup.resolvedCommit!,
    ]);
    // A successful new checkout is clean; avoid a redundant repository scan.
    const status: WorktreeStatus = {
      dirty: false,
      conflicts: false,
      branch: null,
      head: setup.resolvedCommit!,
    };
    const pool = (
      await this.db
        .insert(schema.repoWorktrees)
        .values({
          repoRootPath: realRoot,
          path: worktreePath,
          name: worktreeName,
          managed: true,
          createdFromRef: setup.resolvedCommit,
        })
        .onConflictDoUpdate({
          target: [
            schema.repoWorktrees.repoRootPath,
            schema.repoWorktrees.path,
          ],
          set: { managed: true },
        })
        .returning()
    )[0];
    return { path: worktreePath, poolId: pool.id, managed: true, status };
  }

  /** Git retains the last attached branch/HEAD after a folder is deleted. */
  async previousCheckout(repo: Repo, task: Task) {
    if (!task.path) return undefined;
    const listed = await this.worktrees.listWorktrees(repo.path, { includeMissing: true });
    return listed.find(entry => path.resolve(entry.path) === path.resolve(task.path));
  }

  private async recoverMissingRegistration(
    repoPath: string,
    task: Task,
    branch: string | null,
  ) {
    let listed = await this.worktrees.listWorktrees(repoPath, {
      includeMissing: true,
    });
    const previous =
      task.path && listed.find((entry) => entry.path === task.path);
    if (branch && previous && (await isMissingWorktreePath(previous.path))) {
      if (previous.isLocked || previous.isBare)
        throw new ConflictException({
          code: 'checkout_unavailable',
          message:
            'The missing worktree is locked. Restore or unlock it, or work at its committed revision.',
          canSnapshot: true,
        });
      await this.assertRecoveryIdle(task.id);
      const [owner] = await this.db
        .select()
        .from(schema.taskReservations)
        .where(
          and(
            eq(schema.taskReservations.path, previous.path),
            ne(schema.taskReservations.taskId, task.id),
          ),
        );
      if (owner) throw this.branchConflict(owner.taskId);
      const [workspaceOwner] = await this.db
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.path, previous.path),
            eq(schema.workspaces.linkStatus, 'linked'),
            eq(schema.workspaces.isDefault, false),
            ne(schema.workspaces.id, task.id),
          ),
        )
        .limit(1);
      if (workspaceOwner) throw this.branchConflict(workspaceOwner.id);
      // Only remove this task's missing registration, never prune unrelated
      // worktrees. Without --force Git protects restored edits and locks.
      await this.worktrees.removeWorktree(repoPath, previous.path);
      listed = listed.filter((entry) => entry !== previous);
    }
    return listed;
  }

  private sessionIsIdle(sessionId: number): boolean {
    const activity = this.hooks.getActivity(sessionId);
    return activity.activityStatus === 'idle' && !activity.backgroundActive;
  }

  async assertRecoveryIdle(taskId: number): Promise<void> {
    const [lease] = await this.db
      .select()
      .from(schema.taskReservations)
      .where(eq(schema.taskReservations.taskId, taskId));
    const sessions = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, taskId));
    const terminals = await this.db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.workspaceId, taskId));
    const actions = await this.db
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.workspaceId, taskId),
          eq(schema.actions.status, 'running'),
        ),
      )
      .limit(1);
    const liveTerminals = await mapWorktrees(
      terminals,
      async (terminal) =>
        this.terminals.isAlive(terminal.id) ||
        (await this.terminals.hasTmuxSessionForTerminal(terminal.id)),
    );
    if (
      sessions.some(
        (session) =>
          session.status !== 'archived' && !this.sessionIsIdle(session.id),
      ) ||
      liveTerminals.some(Boolean) ||
      actions.length ||
      (lease && (await this.isBusy(lease.path)))
    )
      throw new ConflictException({
        code: 'environment_busy',
        message:
          'This task still has running work in its previous worktree. Stop it before preparing another worktree.',
      });
  }

  private async isBusy(worktreePath: string): Promise<boolean> {
    const sessions = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.worktreePath, worktreePath));
    if (
      sessions.some(
        (session) =>
          session.status !== 'archived' && !this.sessionIsIdle(session.id),
      )
    )
      return true;
    const terminals = await this.db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.worktreePath, worktreePath));
    const runningTerminals = await mapWorktrees(
      terminals,
      async (terminal) =>
        this.terminals.isAlive(terminal.id) ||
        (await this.terminals.hasTmuxSessionForTerminal(terminal.id)),
    );
    return (
      runningTerminals.some(Boolean) ||
      (await this.actions.getRunningCount(worktreePath)).count > 0
    );
  }

  private async reserve(
    taskId: number,
    repositoryKey: string,
    branchName: string | null,
    worktreePath: string,
  ) {
    try {
      await this.db
        .insert(schema.taskReservations)
        .values({ taskId, repositoryKey, branchName, path: worktreePath })
        .onConflictDoUpdate({
          target: schema.taskReservations.taskId,
          set: { repositoryKey, branchName, path: worktreePath },
        });
    } catch (error) {
      if (!isSqliteUniqueConstraintError(error)) throw error;
      const conflicts = await this.db
        .select()
        .from(schema.taskReservations)
        .where(
          and(
            ne(schema.taskReservations.taskId, taskId),
            or(
              eq(schema.taskReservations.path, worktreePath),
              branchName === null
                ? undefined
                : and(
                    eq(schema.taskReservations.repositoryKey, repositoryKey),
                    eq(schema.taskReservations.branchName, branchName),
                  ),
            ),
          ),
        );
      const branchOwner =
        branchName &&
        conflicts.find(
          (lease) =>
            lease.repositoryKey === repositoryKey &&
            lease.branchName === branchName,
        );
      if (branchOwner) throw this.branchConflict(branchOwner.taskId);
      const pathOwner = conflicts.find((lease) => lease.path === worktreePath);
      // Do not turn unrelated constraints into a misleading reservation error.
      if (!pathOwner) throw error;
      throw new ConflictException({
        code: 'environment_reserved',
        resource: 'path',
        existingTaskId: pathOwner.taskId,
        message:
          'This worktree is reserved by another task. Choose another worktree.',
        canSnapshot: true,
      });
    }
  }

  private branchConflict(taskId: number) {
    return new ConflictException({
      code: 'branch_in_use',
      existingTaskId: taskId,
      message:
        'This branch is reserved by another task. Open that task or work at its committed revision.',
      canSnapshot: true,
    });
  }

  private isPathConflict(error: unknown): boolean {
    if (!(error instanceof ConflictException)) return false;
    const detail = error.getResponse();
    return (
      typeof detail === 'object' &&
      'resource' in detail &&
      detail.resource === 'path'
    );
  }

  private async pathExists(value: string): Promise<boolean> {
    try {
      await fs.lstat(value);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  }
}
