import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { worktreeSimpleGit } from '../config/system-paths.js';

type Workspace = typeof schema.workspaces.$inferSelect;
const checkoutReads = new Map<string, Promise<string | null>>();

/** Cheap HEAD metadata only; coalesce concurrent checks without caching writes. */
export async function workspaceCheckoutError(workspace: Workspace) {
  if (
    workspace.isDefault ||
    workspace.archivedAt ||
    workspace.linkStatus !== 'linked' ||
    workspace.taskState !== 'ready' ||
    (!workspace.taskBranch && !workspace.startingCommit)
  )
    return null;
  let pending = checkoutReads.get(workspace.path);
  if (!pending) {
    pending = worktreeSimpleGit(workspace.path)
      .revparse(['--abbrev-ref', 'HEAD'])
      .then((branch) => (branch.trim() === 'HEAD' ? null : branch.trim()));
    checkoutReads.set(workspace.path, pending);
  }
  try {
    const actualBranch = await pending;
    if (
      workspace.checkoutMode === 'snapshot'
        ? actualBranch === null
        : actualBranch === workspace.taskBranch
    )
      return null;
    return {
      code: 'branch_changed',
      message: `This checkout is now on ${actualBranch || 'a detached revision'}. Restore this task’s ${workspace.checkoutMode === 'snapshot' ? 'saved revision' : `branch “${workspace.taskBranch}”`} before continuing. Local files will be preserved.`,
      actualBranch,
    };
  } catch {
    return {
      code: 'environment_missing',
      message:
        'This task’s checkout is unavailable. Choose another environment before continuing.',
    };
  } finally {
    if (checkoutReads.get(workspace.path) === pending)
      checkoutReads.delete(workspace.path);
  }
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
  const workspace = (
    await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
  )[0];
  if (
    !workspace ||
    workspace.archivedAt ||
    workspace.linkStatus !== 'linked' ||
    workspace.taskState !== 'ready'
  ) {
    throw new BadRequestException(
      'Reopen the task and wait for its environment before running commands.',
    );
  }
  const error = await workspaceCheckoutError(workspace);
  if (error) {
    await db
      .update(schema.workspaces)
      .set({ taskState: 'failed', taskError: JSON.stringify(error) })
      .where(
        and(
          eq(schema.workspaces.id, workspace.id),
          eq(schema.workspaces.taskState, 'ready'),
          isNull(schema.workspaces.archivedAt),
        ),
      );
    throw new BadRequestException(error);
  }
}
