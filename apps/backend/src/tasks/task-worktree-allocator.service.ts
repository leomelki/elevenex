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
import { TaskGitService } from './task-git.service.js';
import { TaskSetup } from './task.types.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionsService } from '../actions/actions.service.js';

type Task = typeof schema.workspaces.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;

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
  ): Promise<{ path: string; poolId: number; managed: boolean }> {
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
          message: 'This branch is checked out in an external environment.',
          path: realPath,
          canSnapshot: true,
        });
      }
      if (matching.isLocked || matching.isBare)
        throw new ConflictException('This checkout is locked or unavailable.');
      const status = await this.git.status(realPath);
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
      return { path: realPath, poolId, managed: pool?.managed ?? false };
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
      )
      .sort((a, b) => a.pool!.id - b.pool!.id);
    for (const candidate of candidates) {
      if (!candidate.pool!.managed && !setup.confirmExternal) continue;
      if (await this.isBusy(candidate.realPath)) continue;
      const status = await this.git.status(candidate.realPath);
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
      };
    }
    if (setup.environment === 'existing')
      throw new ConflictException(
        'The selected environment is in use or has local changes. Choose another environment.',
      );
    await this.pool.assertWithinWorktreeLimit(repo, setup.confirmOverLimit);
    const stem = path.join(
      path.dirname(realRoot),
      '.worktrees',
      path.basename(realRoot),
      `task-${task.id}`,
    );
    let worktreePath = stem;
    // Reopening preserves identity, while the old directory may now belong to another task.
    for (
      let suffix = 2;
      listed.some((entry) => path.resolve(entry.path) === worktreePath) ||
      (await fs.lstat(worktreePath).then(
        () => true,
        () => false,
      ));
      suffix++
    )
      worktreePath = `${stem}-${suffix}`;
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await this.reserve(task.id, key, branch, worktreePath);
    const git = worktreeSimpleGit(repo.path);
    try {
      await git.raw([
        'worktree',
        'add',
        '--detach',
        worktreePath,
        setup.resolvedCommit!,
      ]);
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
          name: `Environment ${task.id}`,
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
    return { path: worktreePath, poolId: pool.id, managed: true };
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
          'This branch or environment was just reserved by another task. Choose another environment or start at its revision.',
        canSnapshot: true,
      });
    }
  }
}
