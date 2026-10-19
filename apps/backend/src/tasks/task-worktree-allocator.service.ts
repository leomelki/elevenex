import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
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
    const listed = await this.worktrees.listWorktrees(repo.path);
    const available = await Promise.all(
      listed.map(async (entry) => {
        try {
          return { entry, realPath: await fs.realpath(entry.path) };
        } catch {
          return null;
        }
      }),
    );
    const checked = available.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    const registered = checked.map((item) => item.entry);
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
    const lease = (
      await this.db
        .select()
        .from(schema.taskReservations)
        .where(eq(schema.taskReservations.taskId, task.id))
    )[0];
    if (lease && registered.some((entry) => entry.path === lease.path)) {
      const pool = pools.find((entry) => entry.path === lease.path);
      if (pool)
        return { path: lease.path, poolId: pool.id, managed: pool.managed };
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
        if (
          error instanceof ConflictException &&
          setup.environment !== 'existing'
        )
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
    const existingPaths = new Set(
      [...listed, ...poolRows].map((entry) =>
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
        !(await fs.lstat(worktreePath).then(
          () => true,
          () => false,
        ))
      )
        break;
    }
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.reserve(task.id, key, branch, worktreePath);
    const git = worktreeSimpleGit(repo.path);
    let status: WorktreeStatus | undefined;
    try {
      await git.raw([
        'worktree',
        'add',
        '--quiet',
        '--detach',
        worktreePath,
        setup.resolvedCommit!,
      ]);
      // A checkout created just now is clean at its start point. Scanning it
      // would cost as much as the checkout itself in a large repository.
      status = {
        dirty: false,
        conflicts: false,
        branch: null,
        head: setup.resolvedCommit!,
      };
    } catch (error) {
      // Recovery may find the already-created registration after an interrupted response.
      if (
        !(await this.worktrees.listWorktrees(repo.path)).some(
          (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
        )
      )
        throw error;
    }
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

  private async isBusy(worktreePath: string): Promise<boolean> {
    const sessions = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.worktreePath, worktreePath));
    if (
      sessions.some(
        (session) =>
          session.status !== 'archived' &&
          this.hooks.getStatus(session.id) !== 'idle',
      )
    )
      return true;
    const terminals = await this.db
      .select()
      .from(schema.userTerminals)
      .where(eq(schema.userTerminals.worktreePath, worktreePath));
    const runningTerminals = await Promise.all(
      terminals.map(
        async (terminal) =>
          this.terminals.isAlive(terminal.id) ||
          (await this.terminals.hasTmuxSessionForTerminal(terminal.id)),
      ),
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
    } catch {
      throw new ConflictException({
        code: 'environment_reserved',
        message:
          'This branch or worktree was just reserved by another task. Choose another worktree or start at its revision.',
        canSnapshot: true,
      });
    }
  }
}
