import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleInit,
  OnModuleDestroy,
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
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { worktreeSimpleGit } from '../config/system-paths.js';
import { releaseGitWorktreeCaches } from '../git/git-worktree-cache-lifecycle.js';
import { ProjectsService } from '../projects/projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { BranchesService } from '../branches/branches.service.js';
import { ClaudeHooksService } from '../claude-hooks/claude-hooks.service.js';
import { UserPtyManager } from '../user-terminal/user-pty-manager.service.js';
import { ActionsService } from '../actions/actions.service.js';
import { TaskGitService, taskBranchSlug } from './task-git.service.js';
import { TaskWorktreeAllocator } from './task-worktree-allocator.service.js';
import { TaskSetup } from './task.types.js';
import { WorktreeContextService } from '../worktree-context/worktree-context.service.js';
import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import { refreshWorkspaceCheckout } from '../workspaces/workspace-ownership.js';
import { compareWorkspaceOrder } from '../workspaces/workspace-order.js';
import { isMissingWorktreePath } from '../worktrees/worktree-path.js';

type Task = typeof schema.workspaces.$inferSelect;
type Repo = typeof schema.repos.$inferSelect;
type FinishRequest = NonNullable<Task['taskFinishRequest']>;

function sameFinishRequest(
  a: Task['taskFinishRequest'],
  b: FinishRequest,
): boolean {
  return (
    a?.sessionId === b.sessionId &&
    a.requestId === b.requestId &&
    a.confirmStop === b.confirmStop
  );
}

const MAX_FAILURE_MESSAGE_LENGTH = 2000;

/**
 * Git failures carry progress output (`Updating files: 12% (…)`) ahead of the
 * real cause. Keep only meaningful lines, and keep the tail where git reports
 * the fatal error when the result is still too long.
 */
export function conciseFailureMessage(message: string): string {
  const lines = message
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !/^[\w ]+:\s+\d{1,3}% \(\d+\/\d+\)(, done\.)?$/.test(line),
    );
  const text = lines.join('\n');
  return text.length > MAX_FAILURE_MESSAGE_LENGTH
    ? `…${text.slice(-MAX_FAILURE_MESSAGE_LENGTH)}`
    : text || message.slice(-MAX_FAILURE_MESSAGE_LENGTH);
}

@Injectable()
export class TasksService
  implements OnApplicationBootstrap, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TasksService.name);
  private readonly releasePreviews = new Map<
    number,
    ReturnType<TasksService['checkReleasePreview']>
  >();
  private readonly operations = new Map<number, Promise<void>>();
  private readonly finishRequests = new Map<
    number,
    NonNullable<Task['taskFinishRequest']>
  >();
  private readonly deferredFinishes = new Map<number, Promise<void>>();
  private readonly idleFinishRequests = new Map<number, FinishRequest>();
  private readonly finishOnIdle = ({ sessionId }: { sessionId: number }) => {
    for (const [taskId, request] of this.finishRequests) {
      if (request.sessionId === sessionId && this.sessionIsIdle(sessionId)) {
        this.idleFinishRequests.set(taskId, request);
        this.scheduleDeferredFinish(taskId, request);
      }
    }
  };
  private readonly conversations = new Map<
    number,
    Promise<typeof schema.sessions.$inferSelect>
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
    private readonly worktreeContext: WorktreeContextService,
    @Optional() private readonly navigationEvents?: NavigationEventsService,
  ) {}

  onModuleInit(): void {
    this.hooks.on('status-changed', this.finishOnIdle);
  }

  onModuleDestroy(): void {
    this.hooks.off('status-changed', this.finishOnIdle);
    this.finishRequests.clear();
    this.idleFinishRequests.clear();
  }

  private sessionIsIdle(sessionId: number): boolean {
    const activity = this.hooks.getActivity(sessionId);
    return activity.activityStatus === 'idle' && !activity.backgroundActive;
  }

  private scheduleDeferredFinish(
    taskId: number,
    request: NonNullable<Task['taskFinishRequest']>,
  ) {
    if (this.deferredFinishes.has(taskId)) return;
    // Return the tool result and let the provider persist its final reply before
    // archiving the caller. Recheck activity inside the repository lock as well.
    const operation = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        if (this.finishRequests.get(taskId) !== request) return;
        await this.finish(taskId, request.confirmStop, request);
      })
      .catch(async (error: unknown) => {
        const current = await this.record(taskId).catch(() => null);
        // A cancelled/replaced request must not report a late failure or erase
        // a newer request after its old preview finishes.
        if (
          !current ||
          current.archivedAt ||
          (current.taskFinishRequest
            ? !sameFinishRequest(current.taskFinishRequest, request)
            : current.taskState !== 'failed')
        )
          return;
        this.forgetFinishRequest(taskId, request);
        this.logger.error(`Deferred finish failed for task ${taskId}`, error);
        await this.db
          .update(schema.workspaces)
          .set({
            taskFinishRequest: null,
            updatedAt: new Date().toISOString(),
            taskError: JSON.stringify({
              code: 'finish_failed',
              message:
                'Scheduled task finishing failed. The checkout remains reserved. Inspect running work and finish this task again to retry cleanup.',
            }),
          })
          .where(
            and(
              eq(schema.workspaces.id, taskId),
              eq(schema.workspaces.updatedAt, current.updatedAt),
              isNull(schema.workspaces.archivedAt),
            ),
          );
      })
      .finally(() => {
        this.deferredFinishes.delete(taskId);
        // An idle event may arrive while the previous activity recheck is still
        // completing. Do not lose it to in-flight request coalescing.
        const pending = this.finishRequests.get(taskId);
        if (
          pending &&
          sameFinishRequest(
            this.idleFinishRequests.get(taskId) ?? null,
            pending,
          ) &&
          this.sessionIsIdle(pending.sessionId)
        )
          this.scheduleDeferredFinish(taskId, pending);
      });
    this.deferredFinishes.set(taskId, operation);
    // An error while recording failure must not become an unhandled rejection.
    void operation.catch((error) =>
      this.logger.error('Could not record deferred finish failure', error),
    );
  }

  private forgetFinishRequest(taskId: number, request: FinishRequest): void {
    if (sameFinishRequest(this.finishRequests.get(taskId) ?? null, request)) {
      this.finishRequests.delete(taskId);
      this.idleFinishRequests.delete(taskId);
    }
  }

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
      if (task.taskFinishRequest && task.taskState === 'ready') {
        this.finishRequests.set(task.id, task.taskFinishRequest);
        if (this.sessionIsIdle(task.taskFinishRequest.sessionId)) {
          this.idleFinishRequests.set(task.id, task.taskFinishRequest);
          this.scheduleDeferredFinish(task.id, task.taskFinishRequest);
        }
      }
      if (task.taskState === 'preparing' && task.taskConfig)
        this.schedule(task.id);
      else if (task.taskState === 'finishing')
        void this.finish(task.id, true).catch((error) =>
          this.logger.error(`Could not finish task ${task.id}`, error),
        );
      else if (task.taskState === 'releasing')
        void this.releaseWorktree(task.id, true)
          .catch(async (error) => {
            this.logger.error(`Could not release task ${task.id}`, error);
            await this.update(
              task.id,
              {
                taskState: 'failed',
                taskError: JSON.stringify({
                  code: 'release_failed',
                  message:
                    'Worktree release was interrupted. The checkout remains reserved. Release it again to retry cleanup.',
                }),
              },
              'releasing',
            );
          })
          .catch((error) =>
            this.logger.error(
              `Could not record release recovery failure for task ${task.id}`,
              error,
            ),
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
    // Creation asks for defaults first; warm the branch listing it searches next.
    void this.branches
      .getBranches(repo.path, true, { allowStale: true })
      .catch(() => undefined);
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

  /** Await accepted setup without launching another operation or scanning its checkout.
   * Cancellation ends this wait; the durable preparation continues independently.
   */
  async waitForPreparation(id: number, timeoutMs: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    for (;;) {
      signal.throwIfAborted();
      const task = await this.record(id);
      if (task.archivedAt || task.taskState !== 'preparing') break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const operation = this.operations.get(id);
      const outcome = await new Promise<'changed' | 'timeout'>(
        (resolve, reject) => {
          let settled = false;
          const finish = (outcome: 'changed' | 'timeout', error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve(outcome);
          };
          const onAbort = () =>
            finish(
              'changed',
              signal.reason ?? new Error('Task wait cancelled.'),
            );
          // Normally await the coalesced setup promise. During startup recovery,
          // check only the single DB row until its operation is registered.
          const timer = setTimeout(
            () => finish('timeout'),
            operation ? remaining : Math.min(remaining, 250),
          );
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
          void operation?.then(
            () => finish('changed'),
            (error) => finish('changed', error),
          );
        },
      );
      if (outcome === 'timeout' && Date.now() >= deadline) {
        timedOut = true;
        break;
      }
    }
    signal.throwIfAborted();
    const task = await this.get(id);
    signal.throwIfAborted();
    return { task, timedOut: timedOut && task.taskState === 'preparing' };
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
    if (task.taskState === 'released') {
      const repo = await this.repo(task.repoId);
      const key = await this.git.repositoryKey(repo.path);
      return this.git.exclusive(key, async () => {
        const current = await this.record(id);
        if (current.taskState !== 'released' || current.archivedAt)
          return this.get(id);
        await this.projects.assertProjectIsActive(repo.projectId);
        const saved = this.resumeSetup(current);
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
        }
        await this.update(id, {
          name: patch.name?.trim() || current.name,
          taskState: 'preparing',
          taskError: null,
          taskConfig: JSON.stringify(setup),
          checkoutMode: setup.checkoutMode,
        });
        this.schedule(id);
        return this.get(id);
      });
    }
    if (
      task.taskState !== 'failed' &&
      !(task.taskState === 'ready' && task.linkStatus === 'unlinked')
    )
      return this.get(id);
    if (task.taskError && JSON.parse(task.taskError).code === 'finish_failed')
      throw new ConflictException(
        'Finish this task again to complete process cleanup.',
      );
    if (task.taskError && JSON.parse(task.taskError).code === 'release_failed')
      throw new ConflictException(
        'Release this worktree again to complete process cleanup.',
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
        const [current] = await this.db
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, id));
        // Confirmed project deletion can remove a finished task while its
        // coalesced remote-ref refresh is still returning. Never revive it.
        if (
          !current ||
          current.archivedAt ||
          current.taskState !== 'preparing'
        ) return;
        const detail =
          error instanceof HttpException
            ? error.getResponse()
            : {
                message:
                  error instanceof Error
                    ? conciseFailureMessage(error.message)
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
      if (setup.mode === 'new')
        setup.contextRootRef ??= current.startingCommit ?? setup.resolvedCommit;
      setup.preparationStage = 'preparing_checkout';
      await this.update(id, { taskConfig: JSON.stringify(setup) });
      const environment = await this.allocator.allocate(
        repo,
        await this.record(id),
        setup,
        key,
      );
      await this.worktreeContext.withTaskPreparation(
        repo.id,
        environment.path,
        async () => {
          await this.update(id, {
            path: environment.path,
            poolWorktreeId: environment.poolId,
          });
          if (setup.checkoutMode !== 'snapshot' && !setup.branchPrepared) {
            if (
              !(await this.git.hasLocalBranch(repo.path, setup.localBranch!))
            ) {
              const remote = await this.git.remoteRef(
                repo.path,
                setup.branchName,
              );
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
          // Allocation just checked this reserved checkout; a second full
          // scan would double the slowest step in a large repository.
          const status =
            environment.status ?? (await this.git.status(environment.path));
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
        },
        // New tasks must exclude work already present in their base, including
        // local merges not yet pushed to the repository's comparison ref.
        // Existing branches still need their earlier branch work summarized.
        setup.contextRootRef ?? null,
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

  async finishPreview(id: number, excludeSessionId?: number) {
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
          session.id !== excludeSessionId &&
          session.status !== 'archived' &&
          !this.sessionIsIdle(session.id),
      ).length,
      terminals: runningTerminals.filter(Boolean).length,
      actions: actions.filter((action) => action.status === 'running').length,
    };
  }

  /** MCP self-finish: consent is checked by the tool; no caller is stopped here. */
  async finishAfterTurn(id: number, sessionId: number, confirmStop = false) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    const key = await this.git.repositoryKey(repo.path);
    return this.git.exclusive(key, async () => {
      const current = await this.record(id);
      const caller = (
        await this.db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, sessionId))
      )[0];
      if (caller?.workspaceId !== id || caller.status === 'archived')
        throw new BadRequestException(
          'The caller no longer belongs to this active task.',
        );
      if (
        current.archivedAt ||
        current.taskState !== 'ready' ||
        current.linkStatus !== 'linked'
      )
        throw new ConflictException(
          'Only a ready, active task can be scheduled for finishing.',
        );
      if (
        current.taskFinishRequest &&
        current.taskFinishRequest.sessionId !== sessionId
      )
        throw new ConflictException(
          'Another conversation has already scheduled this task for finishing.',
        );
      const running = await this.finishPreview(id, sessionId);
      if (
        !confirmStop &&
        (running.agents || running.terminals || running.actions)
      )
        throw new ConflictException({
          code: 'running_work',
          message: 'Explicit stop approval is required for other running work.',
          ...running,
        });
      const request = {
        requestId: current.taskFinishRequest?.requestId ?? randomUUID(),
        sessionId,
        confirmStop:
          current.taskFinishRequest?.confirmStop === true || confirmStop,
      };
      // Keep existing stop consent on retries; a new explicit confirmation may
      // authorize other work that started after the first request.
      await this.update(id, { taskFinishRequest: request, taskError: null });
      this.finishRequests.set(id, request);
      this.idleFinishRequests.delete(id);
      // Do not run cleanup from this handler, even if activity tracking currently
      // says idle. Only a subsequent idle event (or startup recovery) starts it.
      return { taskId: id, finishScheduled: true, afterSessionId: sessionId };
    });
  }

  /** Cancel the durable request without waiting behind a queued Git operation. */
  async cancelScheduledFinish(id: number, sessionId: number) {
    const current = await this.record(id);
    if (current.archivedAt || current.taskState === 'finishing')
      throw new ConflictException({
        code: 'finish_already_started',
        message:
          'Task cleanup has already started or finished; its scheduled finish can no longer be cancelled.',
      });
    const request = current.taskFinishRequest;
    if (!request)
      return { taskId: id, cancelled: false, finishScheduled: false };
    if (request.sessionId !== sessionId)
      throw new BadRequestException({
        code: 'finish_request_not_owned',
        message:
          'Only the conversation that scheduled this finish can cancel it.',
      });
    const changed = await this.db
      .update(schema.workspaces)
      .set({
        taskFinishRequest: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(schema.workspaces.id, id),
          eq(schema.workspaces.taskFinishRequest, request),
          ne(schema.workspaces.taskState, 'finishing'),
          isNull(schema.workspaces.archivedAt),
        ),
      )
      .returning({ id: schema.workspaces.id });
    if (!changed.length)
      throw new ConflictException({
        code: 'finish_request_changed',
        message:
          'The scheduled finish changed or cleanup started during cancellation. Inspect get_task before retrying.',
      });
    this.forgetFinishRequest(id, request);
    return { taskId: id, cancelled: true, finishScheduled: false };
  }

  async finish(
    id: number,
    confirmStop = false,
    afterTurn?: FinishRequest,
    options: { readonly allowArchivedProject?: boolean } = {},
  ) {
    const afterSessionId = afterTurn?.sessionId;
    const task = await this.record(id);
    if (task.archivedAt) {
      this.finishRequests.delete(id);
      this.idleFinishRequests.delete(id);
      return this.get(id);
    }
    const repo = await this.repo(task.repoId);
    // Project deletion also cleans up projects that were archived with open
    // tasks. Ordinary task actions retain their archived-project restriction.
    if (!options.allowArchivedProject)
      await this.projects.assertProjectIsActive(repo.projectId);
    const key = await this.git.repositoryKey(repo.path);
    return this.git.exclusive(key, async () => {
      const current = await this.record(id);
      if (current.archivedAt) {
        this.finishRequests.delete(id);
        this.idleFinishRequests.delete(id);
        return this.get(id);
      }
      if (afterSessionId !== undefined) {
        if (!sameFinishRequest(current.taskFinishRequest, afterTurn!)) {
          this.forgetFinishRequest(id, afterTurn!);
          return this.get(id);
        }
        if (!this.sessionIsIdle(afterSessionId)) return this.get(id);
      }
      const running = await this.finishPreview(id);
      if (afterSessionId !== undefined) {
        // Terminal/action preview can await slow process checks. A new turn or
        // a membership change during that wait must never stop the caller.
        const latest = await this.record(id);
        if (!sameFinishRequest(latest.taskFinishRequest, afterTurn!)) {
          this.forgetFinishRequest(id, afterTurn!);
          return this.get(id);
        }
        const caller = (
          await this.db
            .select()
            .from(schema.sessions)
            .where(eq(schema.sessions.id, afterSessionId))
        )[0];
        if (caller?.workspaceId !== id || caller.status === 'archived') {
          this.finishRequests.delete(id);
          this.idleFinishRequests.delete(id);
          await this.update(id, { taskFinishRequest: null });
          return this.get(id);
        }
        if (!this.sessionIsIdle(afterSessionId)) return this.get(id);
      }
      if (
        !confirmStop &&
        (running.agents || running.terminals || running.actions)
      )
        throw new ConflictException({
          code: 'running_work',
          message: 'Stop running work before finishing this task.',
          ...running,
        });
      // Block new turns before releasing any checkout. Clear the durable request
      // so reopening cannot inherit an old instruction to finish again.
      const claimed = await this.db
        .update(schema.workspaces)
        .set({
          taskState: 'finishing',
          taskFinishRequest: null,
          taskError: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.workspaces.id, id),
            afterTurn
              ? and(
                  eq(schema.workspaces.taskFinishRequest, afterTurn),
                  eq(schema.workspaces.taskState, 'ready'),
                  isNull(schema.workspaces.archivedAt),
                )
              : undefined,
          ),
        )
        .returning({ id: schema.workspaces.id });
      if (!claimed.length) {
        if (afterTurn) this.forgetFinishRequest(id, afterTurn);
        return this.get(id);
      }
      this.finishRequests.delete(id);
      this.idleFinishRequests.delete(id);
      this.navigationEvents?.invalidate();
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
        let retentionReason: { code: string; message: string } | null = null;
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
            await this.assertCheckoutIdentity(current, repo, key, pool);
            // Task processes are stopped, so a managed checkout can save its
            // index caches and stay fast to inspect for the next task.
            const status = await this.git.status(current.path, {
              persistIndex: !!pool?.managed,
            });
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
              // Status can be slow. Recheck identity immediately before mutation.
              await this.assertCheckoutIdentity(current, repo, key, pool);
              await worktreeSimpleGit(current.path).raw([
                'checkout',
                '--detach',
                status.head,
              ]);
              released = true;
            }
          } catch (error) {
            const response =
              error instanceof HttpException ? error.getResponse() : null;
            retentionReason =
              response &&
              typeof response === 'object' &&
              'code' in response &&
              'message' in response
                ? {
                    code: String(response.code),
                    message: String(response.message),
                  }
                : {
                    code: 'finish_observation_failed',
                    message: `Could not safely inspect or detach this checkout; it remains reserved. ${conciseFailureMessage(error instanceof Error ? error.message : String(error))}`,
                  };
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
          taskError: retentionReason ? JSON.stringify(retentionReason) : null,
          ...(released
            ? {
                linkStatus: 'unlinked',
                poolWorktreeId: null,
                desiredBranch: taskBranch ?? current.desiredBranch,
              }
            : {}),
        });
        this.branches.invalidateCache(repo.path);
        releaseGitWorktreeCaches(current.path);
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

  private assertReleaseAllowed(current: Task) {
    if (current.archivedAt)
      throw new ConflictException(
        'Reopen this task before releasing its worktree.',
      );
    if (
      current.linkStatus !== 'linked' ||
      !['ready', 'failed', 'releasing'].includes(current.taskState)
    )
      throw new ConflictException(
        'Wait for task setup or cleanup before releasing its worktree.',
      );
    if (current.taskFinishRequest)
      throw new ConflictException(
        'Cancel the scheduled task finish before releasing its worktree.',
      );
    if (
      current.taskError &&
      JSON.parse(current.taskError).code === 'finish_failed'
    )
      throw new ConflictException(
        'Finish this task again to complete process cleanup.',
      );
  }

  private releaseCheckoutToken(task: Task): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          task.id,
          task.path,
          task.poolWorktreeId,
          task.unlinkedAt,
          task.taskConfig,
          task.archivedAt,
        ]),
      )
      .digest('hex');
  }

  private async assertCheckoutIdentity(
    current: Task,
    repo: Repo,
    key: string,
    pool: typeof schema.repoWorktrees.$inferSelect | null | undefined,
  ) {
    try {
      // Git discovers parent repositories when .git disappears. A matching
      // common directory alone is insufficient for a nested or symlinked path.
      const [topLevel, checkoutKey, checkoutPath, repoPath] = await Promise.all(
        [
          worktreeSimpleGit(current.path)
            .revparse(['--show-toplevel'])
            .then((value) => realpath(value.trim())),
          this.git.repositoryKey(current.path),
          realpath(current.path),
          realpath(repo.path),
        ],
      );
      if (
        topLevel === checkoutPath &&
        checkoutKey === key &&
        (!pool || pool.path === current.path) &&
        (!pool?.managed ||
          (checkoutPath === current.path && checkoutPath !== repoPath))
      )
        return;
    } catch {
      // An unreadable or absent Git identity cannot authorize a mutation.
    }
    throw new ConflictException({
      code: 'checkout_changed',
      message:
        'This directory is no longer the task’s verified Git worktree. Restore its Git metadata before releasing it; the assignment remains reserved.',
    });
  }

  private async releaseChecks(current: Task, repo: Repo, key: string) {
    const id = current.id;
    const pool = current.poolWorktreeId
      ? (
          await this.db
            .select()
            .from(schema.repoWorktrees)
            .where(eq(schema.repoWorktrees.id, current.poolWorktreeId))
        )[0]
      : null;
    const managed =
      !!pool?.managed &&
      pool.path === current.path &&
      current.path !== (await realpath(repo.path));
    const assertOwnership = async () => {
      const owners = await this.db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.path, current.path),
            eq(schema.workspaces.linkStatus, 'linked'),
            eq(schema.workspaces.isDefault, false),
            ne(schema.workspaces.id, id),
          ),
        )
        .limit(1);
      const foreignSessions = await this.db
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.worktreePath, current.path),
            or(
              ne(schema.sessions.workspaceId, id),
              isNull(schema.sessions.workspaceId),
            ),
            ne(schema.sessions.status, 'archived'),
          ),
        );
      if (
        owners.length ||
        foreignSessions.some(
          (session) =>
            (managed && session.workspaceId === null) ||
            !this.sessionIsIdle(session.id),
        )
      )
        throw new ConflictException(
          'This checkout is also used by another task or conversation. Stop or archive the other conversation, or release the other task’s assignment, before trying again.',
        );
    };
    const assertIdentity = () =>
      this.assertCheckoutIdentity(current, repo, key, pool);
    const inspect = async (persistIndex = false) => {
      if (await isMissingWorktreePath(current.path)) return null;
      await assertIdentity();
      const status = await this.git.status(current.path, {
        persistIndex: managed && persistIndex,
      });
      const operationInProgress = await this.git.hasOperationInProgress(
        current.path,
      );
      if (status.dirty || status.conflicts || operationInProgress)
        throw new ConflictException({
          code: 'worktree_not_clean',
          message: status.conflicts
            ? 'This worktree has merge conflicts. Resolve the conflicts or abort the Git operation before releasing it.'
            : operationInProgress
              ? 'A Git operation is in progress. Complete or abort it before releasing this worktree.'
              : 'This worktree has local changes. Commit, stash, or move them before releasing it.',
        });
      return status;
    };
    return { managed, assertOwnership, assertIdentity, inspect };
  }

  /** Read-only and coalesced: checking a large checkout never owns the Git operation lock. */
  async releasePreview(id: number) {
    const pending = this.releasePreviews.get(id);
    if (pending) return pending;
    const operation = this.checkReleasePreview(id)
      .catch((error: unknown) => {
        if (error instanceof HttpException) throw error;
        this.logger.warn(
          `Could not check task ${id} for worktree release: ${String(error)}`,
        );
        throw new ConflictException({
          code: 'release_check_failed',
          message:
            'Could not check this worktree. Check that the repository is accessible and try again.',
        });
      })
      .finally(() => {
        if (this.releasePreviews.get(id) === operation)
          this.releasePreviews.delete(id);
      });
    this.releasePreviews.set(id, operation);
    return operation;
  }

  private async checkReleasePreview(id: number) {
    const current = await this.record(id);
    if (current.taskState === 'released' && !current.archivedAt)
      return {
        task: await this.get(id),
        alreadyReleased: true,
        cleanupRequired: false,
        checkoutToken: this.releaseCheckoutToken(current),
        agents: 0,
        terminals: 0,
        actions: 0,
      };
    this.assertReleaseAllowed(current);
    if (current.taskState === 'releasing')
      throw new ConflictException(
        'Worktree release is already in progress. Wait for it to complete.',
      );
    const repo = await this.repo(current.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    const key = await this.git.repositoryKey(repo.path);
    const checks = await this.releaseChecks(current, repo, key);
    await checks.assertOwnership();
    const cleanupRequired =
      !!current.taskError &&
      JSON.parse(current.taskError).code === 'release_failed';
    // Failed shutdown must be retried before treating its last writes as a setup error.
    const [running, inspection] = await Promise.allSettled([
      this.finishPreview(id),
      cleanupRequired ? Promise.resolve() : checks.inspect(),
    ]);
    if (inspection.status === 'rejected') throw inspection.reason;
    if (running.status === 'rejected') throw running.reason;
    const latest = await this.record(id);
    if (
      latest.taskState !== current.taskState ||
      this.releaseCheckoutToken(latest) !== this.releaseCheckoutToken(current)
    )
      throw new ConflictException({
        code: 'checkout_changed',
        message: 'The task checkout changed while checking it. Check again.',
      });
    this.assertReleaseAllowed(latest);
    const task = await this.get(id);
    if (
      task.taskState !== latest.taskState ||
      this.releaseCheckoutToken(task) !== this.releaseCheckoutToken(latest)
    )
      throw new ConflictException({
        code: 'checkout_changed',
        message: 'The task checkout changed while checking it. Check again.',
      });
    return {
      task,
      alreadyReleased: false,
      cleanupRequired,
      checkoutToken: this.releaseCheckoutToken(latest),
      ...running.value,
    };
  }

  /** Releasing never discards files, archives history, or deletes a Git worktree. */
  async releaseWorktree(
    id: number,
    confirmStop = false,
    checkoutToken?: string,
  ) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    const key = await this.git.repositoryKey(repo.path);
    return this.git.exclusive(key, async () => {
      const current = await this.record(id);
      if (checkoutToken && checkoutToken !== this.releaseCheckoutToken(current))
        throw new ConflictException({
          code: 'checkout_changed',
          message:
            'The task checkout changed. Check again before releasing it.',
        });
      if (current.taskState === 'released' && !current.archivedAt)
        return this.get(id);
      this.assertReleaseAllowed(current);
      const { managed, assertOwnership, assertIdentity, inspect } =
        await this.releaseChecks(current, repo, key);
      await assertOwnership();

      const running = await this.finishPreview(id);
      if (
        !confirmStop &&
        (running.agents || running.terminals || running.actions)
      )
        throw new ConflictException({
          code: 'running_work',
          message:
            'Confirm stopping running work before releasing this worktree.',
          ...running,
        });
      // A missing directory can be unassigned without touching another checkout.
      // Fail without stopping work when it is already clear that release is unsafe.
      if (
        current.taskState !== 'releasing' &&
        !(
          current.taskError &&
          JSON.parse(current.taskError).code === 'release_failed'
        )
      )
        await inspect();
      await this.update(id, { taskState: 'releasing', taskError: null });
      let stopped = false;
      try {
        const sessions = await this.db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.workspaceId, id));
        // Check again after blocking execution: a turn may have started during preview.
        const latestRunning = await this.finishPreview(id);
        if (
          !confirmStop &&
          (latestRunning.agents ||
            latestRunning.terminals ||
            latestRunning.actions)
        ) {
          stopped = true; // No cleanup began; execution can safely be enabled again.
          throw new ConflictException({
            code: 'running_work',
            message: 'Running work started. Confirm stopping it and try again.',
            ...latestRunning,
          });
        }
        for (const session of sessions)
          await this.sessions.stopForWorktreeRelease(session.id);
        for (const terminal of await this.db
          .select()
          .from(schema.userTerminals)
          .where(eq(schema.userTerminals.worktreePath, current.path)))
          await this.terminals.destroy(terminal.id, true);
        for (const action of await this.actions.listByWorktree(current.path))
          await this.actions.stop(action.id, true);
        stopped = true;
        // Agents/actions may have written files while stopping. Recheck before detach.
        await assertOwnership();
        const status = await inspect(true);
        const branch =
          current.taskState === 'releasing' &&
          status &&
          !status.branch &&
          status.head === current.finalCommit
            ? current.taskBranch
            : status
              ? status.branch
              : current.taskBranch;
        const saved = {
          finalCommit:
            status?.head ?? current.finalCommit ?? current.startingCommit,
          taskBranch: branch,
          checkoutMode: branch ? 'branch' : 'snapshot',
          sourceRef: current.sourceRef ?? branch,
        };
        // Persist identity before detach so a crash cannot lose the task branch.
        await this.update(id, saved);
        if (saved.finalCommit)
          await worktreeSimpleGit(repo.path).raw([
            'update-ref',
            `refs/elevenex/tasks/${id}/finish`,
            saved.finalCommit,
          ]);
        if (status && managed) {
          await assertIdentity();
          await worktreeSimpleGit(current.path).raw([
            'checkout',
            '--detach',
            status.head,
          ]);
        }
        // The reservation and owner must disappear together for pool reuse.
        this.db.transaction((tx) => {
          tx.delete(schema.taskReservations)
            .where(eq(schema.taskReservations.taskId, id))
            .run();
          tx.update(schema.workspaces)
            .set({
              ...saved,
              taskState: 'released',
              taskError: null,
              linkStatus: 'unlinked',
              poolWorktreeId: null,
              desiredBranch: branch,
              unlinkedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, id))
            .run();
        });
        this.navigationEvents?.invalidate();
        this.branches.invalidateCache(repo.path);
        releaseGitWorktreeCaches(current.path);
        return this.get(id);
      } catch (error) {
        // Failed process cleanup retains ownership and keeps execution blocked.
        // After successful cleanup, allow the user to fix Git/files and retry.
        if (stopped)
          try {
            const sessions = await this.db
              .select()
              .from(schema.sessions)
              .where(
                and(
                  eq(schema.sessions.workspaceId, id),
                  ne(schema.sessions.status, 'archived'),
                ),
              );
            for (const session of sessions)
              await this.sessions.reactivateRuntime(session.id);
          } catch (reactivationError) {
            stopped = false;
            this.logger.error(
              `Could not reactivate task ${id} after release failure`,
              reactivationError,
            );
          }
        const restoreFailure =
          current.taskState === 'failed' &&
          current.taskError &&
          JSON.parse(current.taskError).code !== 'release_failed';
        await this.update(id, {
          taskState: stopped && !restoreFailure ? 'ready' : 'failed',
          taskError: stopped
            ? restoreFailure
              ? current.taskError
              : null
            : JSON.stringify({
                code: 'release_failed',
                message:
                  'Worktree release could not complete. The checkout remains reserved. Release it again to retry cleanup.',
              }),
        });
        throw error;
      }
    });
  }

  private resumeSetup(task: Task): TaskSetup {
    const setup: TaskSetup = task.taskConfig
      ? JSON.parse(task.taskConfig)
      : {
          requestId: randomUUID(),
          mode: 'existing',
          branchName:
            task.taskBranch || task.desiredBranch || task.createdFromRef || '',
        };
    // Preserve the original scope before reopening switches checkout mode.
    if (setup.mode === 'new')
      setup.contextRootRef ??= task.startingCommit ?? undefined;
    setup.mode = 'existing';
    setup.branchPrepared = true;
    setup.environment = 'automatic';
    setup.worktreeId = undefined;
    if (task.linkStatus !== 'linked') setup.confirmExternal = false;
    setup.confirmOverLimit = false;
    setup.useSavedRef = false;
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
    setup.preparationStage = undefined;
    return setup;
  }

  async reopen(id: number) {
    const task = await this.record(id);
    const repo = await this.repo(task.repoId);
    await this.projects.assertProjectIsActive(repo.projectId);
    if (!task.archivedAt) return this.get(id);
    await this.update(id, {
      archivedAt: null,
      taskState: 'preparing',
      taskError: null,
      taskConfig: JSON.stringify(this.resumeSetup(task)),
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
          or(
            eq(schema.sessions.archivedByTask, true),
            ne(schema.sessions.status, 'archived'),
          ),
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
