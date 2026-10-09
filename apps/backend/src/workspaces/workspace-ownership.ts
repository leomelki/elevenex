import { and, asc, desc, eq, isNull, isNotNull } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

type Workspace = typeof schema.workspaces.$inferSelect;
const checkoutReads = new Map<string, Promise<boolean>>();

function savedTaskError(
  workspace: Workspace,
): { code?: string; message?: string } | null {
  try {
    return workspace.taskError ? JSON.parse(workspace.taskError) : null;
  } catch {
    return null;
  }
}

function isCheckoutFailure(workspace: Workspace) {
  if (workspace.taskState !== 'failed') return false;
  const code = savedTaskError(workspace)?.code;
  if (code !== 'branch_changed' && code !== 'environment_missing') return false;
  // Setup/cleanup failures must go through their lifecycle, not health recovery.
  try {
    return (
      !workspace.taskConfig ||
      !JSON.parse(workspace.taskConfig).preparationStage
    );
  } catch {
    return false;
  }
}

/** Execution needs an available directory, regardless of Git branch or HEAD state. */
export async function workspaceCheckoutError(workspace: Workspace) {
  if (
    workspace.archivedAt ||
    workspace.linkStatus !== 'linked' ||
    (workspace.taskState !== 'ready' && !isCheckoutFailure(workspace))
  )
    return null;
  let pending = checkoutReads.get(workspace.path);
  if (!pending) {
    pending = fs.stat(workspace.path).then((stat) => stat.isDirectory());
    checkoutReads.set(workspace.path, pending);
  }
  try {
    if (await pending) return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR')
      return {
        code: 'checkout_unavailable',
        message: 'Could not access the task worktree. Try again.',
      };
  } finally {
    if (checkoutReads.get(workspace.path) === pending)
      checkoutReads.delete(workspace.path);
  }
  return {
    code: 'environment_missing',
    message:
      'This task’s checkout is unavailable. Choose another worktree before continuing.',
  };
}

/** Revalidate checkout failures on demand, without moving branches or touching files. */
export async function refreshWorkspaceCheckout(
  db: DrizzleDB,
  initial: Workspace,
) {
  let workspace = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    const error = await workspaceCheckoutError(workspace);
    // SQLite work is small and synchronous; filesystem/Git reads stay outside it.
    const result = db.transaction((tx) => {
      const latest = tx
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspace.id))
        .get();
      if (!latest) return { workspace: null, error: null, stale: false };
      const fields = [
        'path',
        'taskState',
        'taskBranch',
        'startingCommit',
        'checkoutMode',
        'linkStatus',
        'archivedAt',
        'taskError',
        'taskConfig',
        'isDefault',
      ] as const;
      if (fields.some((field) => latest[field] !== workspace[field]))
        return { workspace: latest, error: null, stale: true };
      if (error && error.code !== 'checkout_unavailable') {
        const taskError = JSON.stringify(error);
        if (latest.taskState !== 'failed' || latest.taskError !== taskError)
          tx.update(schema.workspaces)
            .set({ taskState: 'failed', taskError })
            .where(eq(schema.workspaces.id, latest.id))
            .run();
        return {
          workspace: {
            ...latest,
            taskState: 'failed',
            taskError: JSON.stringify(error),
          },
          error,
          stale: false,
        };
      }
      if (!error && latest.taskState === 'ready')
        tx.update(schema.taskReservations)
          .set({ branchName: null })
          .where(
            and(
              eq(schema.taskReservations.taskId, latest.id),
              isNotNull(schema.taskReservations.branchName),
            ),
          )
          .run();
      if (
        !error &&
        latest.linkStatus === 'linked' &&
        !latest.archivedAt &&
        isCheckoutFailure(latest)
      ) {
        tx.update(schema.taskReservations)
          .set({ branchName: null })
          .where(
            and(
              eq(schema.taskReservations.taskId, latest.id),
              isNotNull(schema.taskReservations.branchName),
            ),
          )
          .run();
        tx.update(schema.workspaces)
          .set({ taskState: 'ready', taskError: null })
          .where(eq(schema.workspaces.id, latest.id))
          .run();
        return {
          workspace: { ...latest, taskState: 'ready', taskError: null },
          error,
          stale: false,
        };
      }
      return { workspace: latest, error, stale: false };
    });
    if (!result.stale || !result.workspace) return result;
    workspace = result.workspace;
  }
  return {
    workspace,
    error: {
      code: 'checkout_unavailable',
      message: 'The task worktree changed while being checked. Try again.',
    },
    stale: false,
  };
}

export async function currentWorkspaceForPath(
  db: DrizzleDB,
  worktreePath: string,
) {
  return (
    (
      await db
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.path, worktreePath),
            eq(schema.workspaces.linkStatus, 'linked'),
            isNull(schema.workspaces.archivedAt),
          ),
        )
        .orderBy(
          asc(schema.workspaces.isDefault),
          desc(schema.workspaces.updatedAt),
        )
        .limit(1)
    )[0] ?? null
  );
}

export async function assertWorkspaceCanExecute(
  db: DrizzleDB,
  workspaceId: number | null,
) {
  if (!workspaceId) return;
  const initial = (
    await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
  )[0];
  if (!initial)
    throw new BadRequestException(
      'Reopen the task and wait for its worktree before running commands.',
    );
  const { workspace, error } = await refreshWorkspaceCheckout(db, initial);
  if (error) throw new BadRequestException(error);
  if (!workspace || workspace.archivedAt || workspace.linkStatus !== 'linked')
    throw new BadRequestException(
      'Reopen the task and wait for its worktree before running commands.',
    );
  if (workspace.taskState !== 'ready') {
    const detail = savedTaskError(workspace);
    if (detail?.message) throw new BadRequestException(detail);
    throw new BadRequestException(
      workspace.taskState === 'preparing'
        ? 'The task worktree is still being prepared. Wait for setup to finish.'
        : workspace.taskState === 'finishing'
          ? 'The task is finishing. Reopen it before continuing.'
          : 'The task worktree needs attention. Open the task to retry setup.',
    );
  }
  return workspace;
}
