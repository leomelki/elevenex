import { ConflictException } from '@nestjs/common';
import { ToolError } from '../../tool-registry/tool.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';
import { resolveRepo } from './worktree.util.js';

/** Compact, model-facing snapshot of a linked workspace — no DB noise. */
export function workspaceHandle(ws: {
  id: number;
  repoId: number;
  name: string;
  path: string;
  linkStatus: string;
  currentBranch?: string | null;
  isDirty?: boolean;
  hasConflicts?: boolean;
  pendingStashStatus?: string | null;
}) {
  return {
    workspaceId: ws.id,
    repoId: ws.repoId,
    name: ws.name,
    path: ws.path,
    linkStatus: ws.linkStatus,
    branch: ws.currentBranch ?? undefined,
    isDirty: ws.isDirty ?? undefined,
    hasConflicts: ws.hasConflicts ?? undefined,
    pendingStash: ws.pendingStashStatus ?? undefined,
  };
}

/**
 * Shared body for link_worktree / steal_worktree. `takeover` adds
 * confirmTakeover:true (steal). A ConflictException from the pool means the
 * worktree is owned by someone else or dirty — we surface that as a structured,
 * non-retryable error so the agent escalates (to steal_worktree or a human)
 * rather than silently auto-confirming a takeover/stash.
 */
export async function linkWorktree(
  ctx: ToolContext,
  args: {
    repoId: number;
    worktreeId: number;
    branchName: string;
    workspaceName?: string;
  },
  takeover: boolean,
) {
  const { worktreePool } = ctx.services;
  const repo = await resolveRepo(ctx, args.repoId);
  const branchName = args.branchName.trim();

  try {
    const ws = await worktreePool.linkToProject(repo, args.worktreeId, {
      branchName,
      workspaceName: args.workspaceName?.trim() || undefined,
      ...(takeover ? { confirmTakeover: true } : {}),
    });

    return {
      data: { worktreeId: args.worktreeId, workspace: workspaceHandle(ws as never) },
      touched: { workspaceId: (ws as { id: number }).id, worktreeId: args.worktreeId },
      deepLink: ctx.deepLink.project(repo.projectId),
      nextStep:
        'Worktree linked — create or prompt a session in this workspace.',
    };
  } catch (error) {
    if (error instanceof ConflictException) {
      // Owned-by-another / dirty-worktree guard. Do NOT auto-confirm.
      throw new ToolError({
        code: takeover ? 'takeover_blocked' : 'link_requires_confirmation',
        message: error.message,
        remediation: takeover
          ? 'The worktree has uncommitted changes that would be stashed. Escalate to a human (ask_human) before forcing.'
          : 'This worktree is owned by another project or has uncommitted changes. Use steal_worktree to take it over, or escalate to a human.',
        retryable: false,
      });
    }
    throw new ToolError({
      code: 'link_failed',
      message: error instanceof Error ? error.message : 'Could not link worktree.',
      remediation:
        'Verify the worktreeId via assess_worktree_pool and that the branch is not checked out elsewhere.',
    });
  }
}
