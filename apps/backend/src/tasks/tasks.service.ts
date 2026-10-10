import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  isNotNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionsService } from '../actions/actions.service.js';
import { TaskGitService, taskBranchSlug } from './task-git.service.js';
import { TaskWorktreeAllocator } from './task-worktree-allocator.service.js';
import { TaskSetup } from './task.types.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { refreshWorkspaceCheckout } from '../workspaces/workspace-ownership.js';
import { compareWorkspaceOrder } from '../workspaces/workspace-order.js';
import { isMissingWorktreePath } from '../worktrees/worktree-path.js';

type Task = typeof schema.workspaces.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;

@Injectable()
export class TasksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TasksService.name);
  private readonly operations = new Map<number, Promise<void>>();
  private readonly conversations = new Map<
    number,
    Promise<Awaited<ReturnType<SessionsService['create']>>>
  >();
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly git: TaskGitService,
    private readonly allocator: TaskWorktreeAllocator,
    private readonly projects: ProjectsService,
    private readonly sessions: SessionsService,
    private readonly branches: BranchesService,
    private readonly hooks: ClaudeHooksService,
    private readonly terminals: UserPtyManager,
    private readonly actions: ActionsService,
    @Optional() private readonly navigationEvents?: NavigationEventsService,
  ) {}

  onApplicationBootstrap(): void {
    // Resume accepted work without delaying backend startup or duplicating filesystem work.
    void this.recover().catch((error) =>
      this.logger.error('Task recovery failed', error),
    );
  }

  private async recover() {
    const tasks = await this.db
      .select()
      .from(schema.workspaces)
      .where(isNull(schema.workspaces.archivedAt));
    for (const task of tasks) {
      if (task.taskState === 'preparing' && task.taskConfig)
        this.schedule(task.id);
      else if (task.taskState === 'finishing')
        void this.finish(task.id, true).catch((error) =>
          this.logger.error(`Could not finish task ${task.id}`, error),
        );
      else if (
        task.taskState === 'ready' &&
        task.taskConfig &&
        task.taskRequestId
      ) {
        const session = await this.db
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, task.id),
              eq(schema.sessions.surface, 'session'),
            ),
          )
          .limit(1);
        if (!session.length) {
          await this.update(task.id, { taskState: 'preparing' });
          this.schedule(task.id);
        }
      }
    }
  }

  async repo(id: number): Promise<Repo> {
    const repo = (
      await this.db.select().from(schema.repos).where(eq(schema.repos.id, id))
    )[0];
    if (!repo) throw new NotFoundException('Repository not found.');
    return repo;
  }

  async record(id: number): Promise<Task> {
    const task = (
      await this.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id))
    )[0];
    if (!task || task.isDefault) throw new NotFoundException('Task not found.');
    return task;
  }

  async get(id: number) {
    let task = await this.record(id);
    let observationError: Record<string, unknown> | null = null;
    // Migrated tasks retain their identity. Observe their branch once, on demand,
    // rather than scanning every checkout during backend startup.
    if (
      !task.taskConfig &&
      !task.taskBranch &&
      !task.startingCommit &&
      task.linkStatus === 'linked' &&
      !task.archivedAt &&
      task.taskState === 'ready'
    ) {
      try {
        const [branch, head] = await Promise.all([
          worktreeSimpleGit(task.path)
            .revparse(['--abbrev-ref', 'HEAD'])
            .then((value) => (value.trim() === 'HEAD' ? '' : value.trim())),
          this.git.resolve(task.path, 'HEAD'),
        ]);
        // Detached HEAD can be temporary (rebase/bisect). Defer legacy branch
        // identity until it is attached, rather than permanently labelling it a snapshot.
        if (branch.trim()) {
          await worktreeSimpleGit(task.path).raw([
            'update-ref',
            `refs/elevenex/tasks/${id}/start`,
            head,
          ]);
          await this.db
            .update(schema.workspaces)
            .set({
              taskBranch: branch.trim() || null,
              sourceRef: branch.trim() || head,
              startingCommit: task.startingCommit ?? head,
              checkoutMode: branch.trim() ? 'branch' : 'snapshot',
            })
            .where(
              and(
                eq(schema.workspaces.id, id),
                eq(schema.workspaces.path, task.path),
                eq(schema.workspaces.taskState, 'ready'),
                eq(schema.workspaces.linkStatus, 'linked'),
                isNull(schema.workspaces.archivedAt),
                isNull(schema.workspaces.taskBranch),
                isNull(schema.workspaces.startingCommit),
                isNull(schema.workspaces.taskConfig),
              ),
            );
        }
      } catch {
        if (await isMissingWorktreePath(task.path)) {
          await this.db
            .update(schema.workspaces)
            .set({
              taskState: 'failed',
              taskError: JSON.stringify({
                code: 'environment_missing',
                message:
                  'This task’s checkout is unavailable. Choose a branch and retry setup.',
              }),
            })
            .where(
              and(
                eq(schema.workspaces.id, id),
                eq(schema.workspaces.path, task.path),
                eq(schema.workspaces.taskState, 'ready'),
                isNull(schema.workspaces.archivedAt),
              ),
            );
        } else {
          observationError = {
            code: 'checkout_unavailable',
            message: 'Could not verify the task worktree. Try again.',
          };
        }
      }
      task = await this.record(id);
    }
    const checked = await refreshWorkspaceCheckout(this.db, task);
    if (
      checked.workspace &&
      (checked.workspace.taskState !== task.taskState ||
        checked.workspace.taskError !== task.taskError)
    )
      this.navigationEvents?.invalidate();
    task = checked.workspace ?? (await this.record(id));
    const sessions = await this.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, id),
          eq(schema.sessions.surface, 'session'),
        ),
      )
      .orderBy(schema.sessions.id);
    let error: Record<string, unknown> | null =
      checked.error ?? observationError;
    if (task.taskError && !error) {
      try {
        error = JSON.parse(task.taskError);
      } catch {
        error = { message: task.taskError };
      }
    }
    const needsEnvironment =
      !task.archivedAt &&
      task.linkStatus === 'unlinked' &&
      task.taskState === 'ready';
    return {
      ...task,
      taskState: needsEnvironment ? 'failed' : task.taskState,
      error:
        error ??
        (needsEnvironment
          ? {
              code: 'environment_missing',
              message:
                'This task needs a worktree. Choose a branch and retry setup.',
            }
          : null),
      preparationStage: task.taskConfig
        ? (JSON.parse(task.taskConfig).preparationStage ?? null)
        : null,
      sessions,
    };
  }

  async list(
    repoId: number,
    state: 'active' | 'finished' = 'active',
    limit = 50,
    cursor?: number,
  ) {
    const position = sql<number>`coalesce(${schema.workspaces.sortOrder}, ${schema.workspaces.id})`;
    const cursorRow =
      cursor && state === 'active'
        ? (
            await this.db
              .select({ position })
              .from(schema.workspaces)
              .where(
                and(
                  eq(schema.workspaces.id, cursor),
                  eq(schema.workspaces.repoId, repoId),
                  eq(schema.workspaces.isDefault, false),
                  isNull(schema.workspaces.archivedAt),
                ),
              )
          )[0]
        : undefined;
    if (cursor && state === 'active' && !cursorRow) return [];
    return this.db
      .select()
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.repoId, repoId),
          eq(schema.workspaces.isDefault, false),
          state === 'finished'
            ? isNotNull(schema.workspaces.archivedAt)
            : isNull(schema.workspaces.archivedAt),
          cursor
            ? state === 'finished'
              ? lt(schema.workspaces.id, cursor)
              : or(
                  gt(position, cursorRow!.position),
                  and(
                    eq(position, cursorRow!.position),
                    gt(schema.workspaces.id, cursor),
                  ),
                )
            : undefined,
        ),
      )
      .orderBy(
        ...(state === 'finished'
          ? [desc(schema.workspaces.id)]
          : [asc(position), asc(schema.workspaces.id)]),
      )
      .limit(Math.min(100, Math.max(1, limit || 50)));
  }

  async defaults(repoId: number, name = '') {
    const repo = await this.repo(repoId);
    const baseRef = await this.git.defaultBase(repo.path);
    let branchName = taskBranchSlug(name);
    if (name.trim()) {
      const stem = branchName;
      const existing = new Set(
        (
          await worktreeSimpleGit(repo.path).raw([
            'for-each-ref',
            '--format=%(refname:short)',
            `refs/heads/${stem}*`,
          ])
        )
          .trim()
          .split('\n'),
      );
      for (let index = 2; existing.has(branchName); index++)
        branchName = `${stem}-${index}`;
    }
    return { baseRef, branchName };
  }

  async create(repoId: number, input: TaskSetup) {
    const repo = await this.repo(repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    const existing = (
      await this.db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.taskRequestId, input.requestId))
    )[0];
    if (existing) {
      if (existing.repoId !== repoId)
        throw new ConflictException(
          'This request belongs to another repository.',
        );
      return this.get(existing.id);
    }
    if (!input.branchName.trim())
      throw new BadRequestException('Choose a branch or enter a task name.');
    const setup: TaskSetup = {
      ...input,
      branchName: input.branchName.trim(),
      checkoutMode: input.checkoutMode ?? 'branch',
      environment: input.environment ?? 'automatic',
    };
    const rows = await this.db
      .insert(schema.workspaces)
      .values({
        repoId,
        name:
          input.name?.trim() ||
          setup.branchName.replace(/^refs\/(heads|remotes)\//, ''),
        path: '',
        linkStatus: 'unlinked',
        taskState: 'preparing',
        taskRequestId: input.requestId,
        taskConfig: JSON.stringify(setup),
        sourceRef: setup.branchName,
        checkoutMode: setup.checkoutMode,
      })
      .onConflictDoNothing({ target: schema.workspaces.taskRequestId })
      .returning();
    const task =
      rows[0] ??
      (
        await this.db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.taskRequestId, input.requestId))
      )[0];
    if (!task || task.repoId !== repoId)
      throw new ConflictException('Could not reserve the task request.');
    this.schedule(task.id);
    this.navigationEvents?.invalidate();
    return this.get(task.id);
  }

  async retry(id: number, patch: Partial<TaskSetup> = {}) {
    // Validation creates own undefined DTO fields; @IsOptional also accepts
    // null. Neither represents a setup change, so preserve the saved values.
    patch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value != null),
    );
    const task = await this.record(id);
    if (task.archivedAt)
      throw new ConflictException(
        'Reopen this task before preparing its worktree.',
      );
    if (
      task.taskState !== 'failed' &&
      !(task.taskState === 'ready' && task.linkStatus === 'unlinked')
    )
      return this.get(id);
    if (task.taskError && JSON.parse(task.taskError).code === 'finish_failed')
      throw new ConflictException(
        'Finish this task again to complete process cleanup.',
      );
    // Old branch-mismatch failures recover without checking out or changing files.
    const checked = await refreshWorkspaceCheckout(this.db, task);
    if (
      checked.workspace?.taskState === 'ready' &&
      checked.workspace.linkStatus === 'linked'
    )
      return this.get(id);
    const saved: TaskSetup = task.taskConfig
      ? JSON.parse(task.taskConfig)
      : {
          requestId: randomUUID(),
          mode: 'existing',
          branchName:
            task.taskBranch || task.desiredBranch || task.createdFromRef || '',
        };
    const setup = { ...saved, ...patch };
    if (
      (patch.branchName && patch.branchName !== saved.branchName) ||
      (patch.checkoutMode && patch.checkoutMode !== saved.checkoutMode) ||
      (patch.mode && patch.mode !== saved.mode) ||
      (patch.baseRef && patch.baseRef !== saved.baseRef)
    ) {
      setup.resolvedCommit = undefined;
      setup.branchPrepared = undefined;
      setup.localBranch = undefined;
      await this.db
        .delete(schema.taskReservations)
        .where(eq(schema.taskReservations.taskId, id));
    }
    if (patch.environment === 'new' || patch.worktreeId)
      await this.db
        .delete(schema.taskReservations)
        .where(eq(schema.taskReservations.taskId, id));
    await this.update(id, {
      name: patch.name?.trim() || task.name,
      taskState: 'preparing',
      taskError: null,
      taskConfig: JSON.stringify(setup),
      checkoutMode: setup.checkoutMode,
    });
    this.schedule(id);
    return this.get(id);
  }

  async rename(id: number, name: string) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    await this.update(id, {
      name: name.trim() || task.sourceRef || task.taskBranch || task.name,
    });
    return this.get(id);
  }

  async move(repoId: number, taskId: number, beforeTaskId?: number | null) {
    const repo = await this.repo(repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    // A single SQLite transaction resolves the latest order, including tasks
    // created since the client loaded. No filesystem or network work is held.
    const taskIds = this.db.transaction((tx) => {
      const tasks = tx
        .select({
          id: schema.workspaces.id,
          isDefault: schema.workspaces.isDefault,
          sortOrder: schema.workspaces.sortOrder,
        })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.repoId, repoId),
            eq(schema.workspaces.isDefault, false),
            isNull(schema.workspaces.archivedAt),
          ),
        )
        .all()
        .sort(compareWorkspaceOrder);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task)
        throw new BadRequestException(
          'Only active tasks in this repository can be reordered.',
        );
      if (beforeTaskId === taskId) return tasks.map((item) => item.id);
      const ordered = tasks.filter((item) => item.id !== taskId);
      const index =
        beforeTaskId == null
          ? ordered.length
          : ordered.findIndex((item) => item.id === beforeTaskId);
      if (index < 0)
        throw new ConflictException(
          'The destination task is no longer available. Refresh and try again.',
        );
      ordered.splice(index, 0, task);
      for (const [position, item] of ordered.entries()) {
        if (item.sortOrder === position + 1) continue;
        tx.update(schema.workspaces)
          .set({ sortOrder: position + 1 })
          .where(eq(schema.workspaces.id, item.id))
          .run();
      }
      return ordered.map((item) => item.id);
    });
    this.navigationEvents?.invalidate();
    return { taskIds };
  }

  async saveDraft(id: number, text: string) {
    const task = await this.record(id);
    if (task.archivedAt)
      throw new ConflictException('Finished tasks are read-only.');
    await this.update(id, { taskDraft: text });
    const session = (
      await this.db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, id),
            eq(schema.sessions.surface, 'session'),
          ),
        )
        .limit(1)
    )[0];
    if (session)
      await this.db
        .insert(schema.composerDrafts)
        .values({ sessionId: session.id, text })
        .onConflictDoUpdate({
          target: schema.composerDrafts.sessionId,
          set: { text, updatedAt: new Date().toISOString() },
        });
    return { saved: true };
  }

  async openConversation(id: number) {
    const pending = this.conversations.get(id);
    if (pending) return pending;
    const operation = (async () => {
      const task = await this.record(id);
      if (
        task.archivedAt ||
        task.taskState !== 'ready' ||
        task.linkStatus !== 'linked'
      )
        throw new ConflictException(
          'Wait for this task’s worktree before opening a conversation.',
        );
      const session = (
        await this.db
          .select()
          .from(schema.sessions)
          .where(
            and(
              eq(schema.sessions.workspaceId, id),
              eq(schema.sessions.surface, 'session'),
              sql`${schema.sessions.status} != 'archived'`,
            ),
          )
          .orderBy(desc(schema.sessions.id))
          .limit(1)
      )[0];
      return (
        session ??
        this.sessions.create({ repoId: task.repoId, workspaceId: id })
      );
    })().finally(() => this.conversations.delete(id));
    this.conversations.set(id, operation);
    return operation;
  }

  private schedule(id: number) {
    if (this.operations.has(id)) return;
    const pending = this.prepare(id)
      .catch(async (error: unknown) => {
        const current = await this.record(id);
        if (current.archivedAt || current.taskState !== 'preparing') return;
        const detail =
          error instanceof HttpException
            ? error.getResponse()
            : {
                message:
                  error instanceof Error
                    ? error.message
                    : 'Could not prepare the task.',
              };
        await this.update(id, {
          taskState: 'failed',
          taskError: JSON.stringify(
            typeof detail === 'string' ? { message: detail } : detail,
          ),
        });
      })
      .finally(() => this.operations.delete(id));
    this.operations.set(id, pending);
  }

  private async prepare(id: number) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    const key = await this.git.repositoryKey(repo.path);
    const initialSetup: TaskSetup = JSON.parse(task.taskConfig!);
    if (!initialSetup.resolvedCommit) {
      const base =
        initialSetup.mode === 'new'
          ? initialSetup.baseRef || (await this.git.defaultBase(repo.path))
          : initialSetup.branchName;
      if (!base)
        throw new BadRequestException(
          'Choose a base branch for this repository.',
        );
      if (initialSetup.mode === 'new') initialSetup.baseRef = base;
      initialSetup.preparationStage = 'refreshing_ref';
      await this.update(
        id,
        { taskConfig: JSON.stringify(initialSetup) },
        'preparing',
      );
      // Network work is coalesced independently and never holds checkout leases.
      await this.git.refresh(repo.path, base, initialSetup.useSavedRef);
    }
    await this.git.exclusive(key, async () => {
      const current = await this.record(id);
      if (current.archivedAt || current.taskState !== 'preparing') return;
      await this.projects.assertProjectIsActive(repo.projectId);
      const setup: TaskSetup = JSON.parse(current.taskConfig!);
      const git = worktreeSimpleGit(repo.path);
      if (!setup.resolvedCommit) {
        const base =
          setup.mode === 'new'
            ? setup.baseRef || (await this.git.defaultBase(repo.path))
            : setup.branchName;
        if (!base)
          throw new BadRequestException(
            'Choose a base branch for this repository.',
          );
        if (
          setup.mode === 'existing' &&
          current.finalCommit &&
          !(await this.git.remoteRef(repo.path, base)) &&
          !(await this.git.hasLocalBranch(
            repo.path,
            base.replace(/^refs\/heads\//, ''),
          ))
        )
          throw new ConflictException({
            code: 'branch_missing',
            message:
              'This task’s branch was deleted. Restore it from the saved commit or choose another branch.',
          });
        setup.resolvedCommit = await this.git.resolve(repo.path, base);
        const remote =
          setup.mode === 'existing'
            ? await this.git.remoteRef(repo.path, setup.branchName)
            : null;
        setup.localBranch = remote
          ? remote.branch
          : setup.branchName.replace(/^refs\/heads\//, '');
        await this.git.validateBranch(repo.path, setup.localBranch);
        if (setup.mode === 'new') setup.baseRef = base;
        if (
          remote &&
          setup.checkoutMode !== 'snapshot' &&
          (await this.git.hasLocalBranch(repo.path, setup.localBranch))
        ) {
          const localCommit = await this.git.resolve(
            repo.path,
            `refs/heads/${setup.localBranch}`,
          );
          if (localCommit !== setup.resolvedCommit)
            throw new ConflictException({
              code: 'remote_differs',
              message: `${setup.localBranch} differs from ${setup.branchName}.`,
              localBranch: setup.localBranch,
              remoteRef: setup.branchName,
              canSnapshot: true,
            });
        }
        if (setup.mode === 'existing' && !remote) {
          if (
            current.finalCommit &&
            !(await this.git.hasLocalBranch(repo.path, setup.localBranch))
          )
            throw new ConflictException({
              code: 'branch_missing',
              message:
                'This task’s branch was deleted. Restore it from the saved commit or choose another branch.',
            });
          setup.resolvedCommit = await this.git.resolve(
            repo.path,
            `refs/heads/${setup.localBranch}`,
          );
        }
        await this.update(id, {
          taskConfig: JSON.stringify(setup),
          taskBranch: setup.localBranch,
          sourceRef: setup.branchName,
          startingCommit: current.startingCommit ?? setup.resolvedCommit,
          createdFromRef: setup.baseRef ?? setup.branchName,
          checkoutMode: setup.checkoutMode,
        });
      }
      if (
        setup.mode === 'new' &&
        !setup.branchPrepared &&
        (await this.git.hasLocalBranch(repo.path, setup.localBranch!))
      ) {
        const ownedLease = (
          await this.db
            .select()
            .from(schema.taskReservations)
            .where(eq(schema.taskReservations.taskId, id))
        )[0];
        if (
          !ownedLease ||
          (await this.git.resolve(
            repo.path,
            `refs/heads/${setup.localBranch}`,
          )) !== setup.resolvedCommit
        ) {
          throw new ConflictException({
            code: 'branch_exists',
            message: `“${setup.localBranch}” already exists. Use it or choose another name.`,
            branchName: setup.localBranch,
          });
        }
      }
      setup.preparationStage = 'preparing_checkout';
      await this.update(id, { taskConfig: JSON.stringify(setup) });
      const environment = await this.allocator.allocate(
        repo,
        await this.record(id),
        setup,
        key,
      );
      await this.update(id, {
        path: environment.path,
        poolWorktreeId: environment.poolId,
      });
      if (setup.checkoutMode !== 'snapshot' && !setup.branchPrepared) {
        if (!(await this.git.hasLocalBranch(repo.path, setup.localBranch!))) {
          const remote = await this.git.remoteRef(repo.path, setup.branchName);
          await git.raw([
            'branch',
            '--no-track',
            setup.localBranch!,
            setup.resolvedCommit!,
          ]);
          if (setup.mode === 'existing' && remote)
            await git.raw([
              'branch',
              '--set-upstream-to',
              `${remote.remote}/${remote.branch}`,
              setup.localBranch!,
            ]);
        }
        setup.branchPrepared = true;
        await this.update(id, { taskConfig: JSON.stringify(setup) });
      }
      const status = await this.git.status(environment.path);
      const alreadyCorrect =
        setup.checkoutMode === 'snapshot'
          ? !status.branch && status.head === setup.resolvedCommit
          : status.branch === setup.localBranch;
      if (!alreadyCorrect) {
        if (status.dirty)
          throw new ConflictException(
            'The selected worktree now has local edits. Choose another worktree.',
          );
        await worktreeSimpleGit(environment.path).raw(
          setup.checkoutMode === 'snapshot'
            ? ['checkout', '--detach', setup.resolvedCommit!]
            : ['checkout', setup.localBranch!],
        );
      }
      await git.raw([
        'update-ref',
        `refs/elevenex/tasks/${id}/start`,
        current.startingCommit ?? setup.resolvedCommit!,
      ]);
      await this.db
        .delete(schema.worktreeContexts)
        .where(
          and(
            eq(schema.worktreeContexts.repoId, repo.id),
            eq(schema.worktreeContexts.worktreePath, environment.path),
          ),
        );
      setup.preparationStage = 'restoring_sessions';
      await this.update(id, { taskConfig: JSON.stringify(setup) });
      await this.restoreSessions(id, environment.path, setup.localBranch!);
      setup.preparationStage = undefined;
      await this.update(id, {
        taskState: 'ready',
        linkStatus: 'linked',
        taskError: null,
        desiredBranch: null,
        taskConfig: JSON.stringify(setup),
      });
      const sessions = await this.db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, id),
            eq(schema.sessions.surface, 'session'),
          ),
        );
      if (!sessions.length) {
        const session = await this.openConversation(id);
        const latest = await this.record(id);
        if (latest.taskDraft)
          await this.db
            .insert(schema.composerDrafts)
            .values({ sessionId: session.id, text: latest.taskDraft })
            .onConflictDoNothing();
      }
      this.branches.invalidateCache(repo.path);
    });
  }

  async finishPreview(id: number) {
    const task = await this.record(id);
    const sessions = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, id));
    const terminals =
      task.path && task.linkStatus === 'linked'
        ? await this.db
            .select()
            .from(schema.userTerminals)
            .where(eq(schema.userTerminals.worktreePath, task.path))
        : [];
    const actions =
      task.path && task.linkStatus === 'linked'
        ? await this.actions.listByWorktree(task.path)
        : [];
    const runningTerminals = await Promise.all(
      terminals.map(
        async (terminal) =>
          this.terminals.isAlive(terminal.id) ||
          (await this.terminals.hasTmuxSessionForTerminal(terminal.id)),
      ),
    );
    return {
      agents: sessions.filter(
        (session) =>
          session.status !== 'archived' &&
          this.hooks.getStatus(session.id) !== 'idle',
      ).length,
      terminals: runningTerminals.filter(Boolean).length,
      actions: actions.filter((action) => action.status === 'running').length,
    };
  }

  async finish(id: number, confirmStop = false) {
    const task = await this.record(id);
    if (task.archivedAt) return this.get(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    const key = await this.git.repositoryKey(repo.path);
    return this.git.exclusive(key, async () => {
      const current = await this.record(id);
      if (current.archivedAt) return this.get(id);
      const running = await this.finishPreview(id);
      if (
        !confirmStop &&
        (running.agents || running.terminals || running.actions)
      )
        throw new ConflictException({
          code: 'running_work',
          message: 'Stop running work before finishing this task.',
          ...running,
        });
      await this.update(id, { taskState: 'finishing' });
      try {
        const sessions = await this.db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.workspaceId, id));
        for (const session of sessions) {
          if (session.status !== 'archived') {
            await this.db
              .update(schema.sessions)
              .set({ archivedByTask: true })
              .where(eq(schema.sessions.id, session.id));
          }
          await this.sessions.archiveAndStop(session.id, true);
        }
        if (current.linkStatus === 'linked' && current.path) {
          for (const terminal of await this.db
            .select()
            .from(schema.userTerminals)
            .where(eq(schema.userTerminals.worktreePath, current.path)))
            await this.terminals.destroy(terminal.id, true);
          for (const action of await this.actions.listByWorktree(current.path))
            await this.actions.stop(action.id, true);
        }
        let released = current.linkStatus !== 'linked';
        let finalCommit = current.finalCommit;
        let taskBranch = current.taskBranch;
        let checkoutMode = current.checkoutMode;
        if (!released && current.path) {
          const pool = current.poolWorktreeId
            ? (
                await this.db
                  .select()
                  .from(schema.repoWorktrees)
                  .where(eq(schema.repoWorktrees.id, current.poolWorktreeId))
              )[0]
            : null;
          try {
            const status = await this.git.status(current.path);
            // Tasks own a worktree, not a fixed branch. Save the state the
            // user/agent left behind so reopening resumes that work.
            finalCommit = status.head;
            taskBranch = status.branch;
            checkoutMode = status.branch ? 'branch' : 'snapshot';
            if (finalCommit)
              await worktreeSimpleGit(repo.path).raw([
                'update-ref',
                `refs/elevenex/tasks/${id}/finish`,
                finalCommit,
              ]);
            if (
              pool?.managed &&
              !status.dirty &&
              !status.conflicts &&
              !(await this.git.hasOperationInProgress(current.path))
            ) {
              await worktreeSimpleGit(current.path).raw([
                'checkout',
                '--detach',
                status.head,
              ]);
              released = true;
            }
          } catch (error) {
            this.logger.warn(
              `Task ${id} finished with its worktree retained: ${String(error)}`,
            );
          }
        }
        if (released)
          await this.db
            .delete(schema.taskReservations)
            .where(eq(schema.taskReservations.taskId, id));
        await this.update(id, {
          archivedAt: new Date().toISOString(),
          taskState: 'ready',
          finalCommit,
          taskBranch,
          checkoutMode,
          sourceRef: current.sourceRef ?? taskBranch,
          ...(released
            ? {
                linkStatus: 'unlinked',
                poolWorktreeId: null,
                desiredBranch: taskBranch ?? current.desiredBranch,
              }
            : {}),
        });
        this.branches.invalidateCache(repo.path);
        return this.get(id);
      } catch (error) {
        await this.update(id, {
          taskState: 'failed',
          taskError: JSON.stringify({
            code: 'finish_failed',
            message:
              'Could not stop all task processes. The worktree remains reserved. Finish this task again to retry cleanup.',
          }),
        });
        throw error;
      }
    });
  }

  async reopen(id: number) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    if (!task.archivedAt) return this.get(id);
    const setup: TaskSetup = task.taskConfig
      ? JSON.parse(task.taskConfig)
      : {
          requestId: randomUUID(),
          mode: 'existing',
          branchName:
            task.taskBranch || task.desiredBranch || task.createdFromRef || '',
        };
    setup.mode = 'existing';
    setup.branchPrepared = true;
    setup.environment = 'automatic';
    setup.worktreeId = undefined;
    setup.checkoutMode =
      task.checkoutMode === 'snapshot' ? 'snapshot' : 'branch';
    setup.branchName = task.taskBranch
      ? `refs/heads/${task.taskBranch}`
      : setup.branchName;
    setup.localBranch =
      task.taskBranch || setup.localBranch || setup.branchName;
    setup.resolvedCommit =
      setup.checkoutMode === 'snapshot'
        ? task.finalCommit || task.startingCommit || undefined
        : undefined;
    await this.update(id, {
      archivedAt: null,
      taskState: 'preparing',
      taskError: null,
      taskConfig: JSON.stringify(setup),
    });
    this.schedule(id);
    return this.get(id);
  }

  private async restoreSessions(
    id: number,
    worktreePath: string,
    branch: string,
  ) {
    const restored = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.workspaceId, id),
          eq(schema.sessions.archivedByTask, true),
        ),
      );
    for (const session of restored)
      await this.sessions.reactivateRuntime(session.id);
    await this.db
      .update(schema.sessions)
      .set({
        transcriptWorktreePath: sql`coalesce(${schema.sessions.transcriptWorktreePath}, ${schema.sessions.worktreePath})`,
        worktreePath,
        branchName: branch,
        hasInjectedWorktreeContext: false,
      })
      .where(eq(schema.sessions.workspaceId, id));
    await this.db
      .update(schema.sessions)
      .set({ status: 'stopped', archivedByTask: false })
      .where(
        and(
          eq(schema.sessions.workspaceId, id),
          eq(schema.sessions.archivedByTask, true),
        ),
      );
    await this.db
      .update(schema.userTerminals)
      .set({ worktreePath })
      .where(eq(schema.userTerminals.workspaceId, id));
    await this.db
      .update(schema.actions)
      .set({ worktreePath })
      .where(eq(schema.actions.workspaceId, id));
  }

  private async update(
    id: number,
    values: Partial<typeof schema.workspaces.$inferInsert>,
    expectedState?: string,
  ) {
    await this.db
      .update(schema.workspaces)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.workspaces.id, id),
          expectedState
            ? and(
                eq(schema.workspaces.taskState, expectedState),
                isNull(schema.workspaces.archivedAt),
              )
            : undefined,
        ),
      );
    if (values.taskState || 'archivedAt' in values || 'name' in values)
      this.navigationEvents?.invalidate();
  }
}
