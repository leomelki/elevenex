import * as path from 'node:path';
import type { WorktreePoolItem } from '../../../worktrees/worktree-pool.service.js';
import { ToolError } from '../../tool-registry/tool.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';

export type WorktreeCategory = 'available' | 'assigned' | 'yours' | 'all';
export type DerivedCategory = 'available' | 'assigned' | 'main';

/**
 * True for the repository's own main working tree, which `git worktree list`
 * reports alongside the real pool worktrees. Git refuses to move it and the
 * human works in it directly, so it is never reusable — reusing it would
 * switch the branch under the checkout the user is sitting in.
 */
export function isMainWorktree(item: WorktreePoolItem): boolean {
  return item.path === item.repoRootPath;
}

/** Assigned worktrees belong to tasks, independently of active session counts.
 * `yours` remains an input alias; it never grants ownership to the calling agent.
 */
export function deriveCategory(item: WorktreePoolItem): DerivedCategory {
  if (isMainWorktree(item)) return 'main';
  return item.owner ? 'assigned' : 'available';
}

/**
 * The main working tree deliberately matches only 'all': listing it under
 * 'available' invites an agent to link it and switch the branch of the
 * repository's primary checkout.
 */
export function matchesCategory(
  item: WorktreePoolItem,
  category: WorktreeCategory,
): boolean {
  if (category === 'all') return true;
  return (
    deriveCategory(item) === (category === 'yours' ? 'assigned' : category)
  );
}

/**
 * Effective last-activity timestamp for a pool item: the newer of the
 * context-injection stamp and real session activity. `null` means "unknown" —
 * NOT "never used" — so callers must not treat it as infinitely stale.
 */
export function lastActivityAt(item: WorktreePoolItem): string | null {
  const stamps = [item.lastUsedAt, item.lastSessionActivityAt].filter(
    (stamp): stamp is string => !!stamp,
  );
  if (stamps.length === 0) return null;
  return stamps.reduce((newest, stamp) => (stamp > newest ? stamp : newest));
}

/** True when sessions are still attached to this worktree — it is in use. */
export function isInUse(item: WorktreePoolItem): boolean {
  return item.activeSessionCount > 0 || item.runningAgentCount > 0;
}

/** Compact, model-facing handle for a pool item — no DB noise. */
export function poolItemHandle(item: WorktreePoolItem) {
  return {
    worktreeId: item.id,
    name: item.name,
    path: item.path,
    managed: item.managed,
    isDetached: item.isDetached,
    branch: item.currentBranch ?? undefined,
    category: deriveCategory(item),
    owner: item.owner
      ? {
          taskId: item.owner.workspaceId,
          taskName: item.owner.workspaceName,
          repoId: item.owner.repoId,
          projectId: item.owner.projectId,
          project: item.owner.projectName,
          workspace: item.owner.workspaceName,
        }
      : undefined,
    isDirty: item.isDirty,
    hasConflicts: item.hasConflicts,
    isLocked: item.isLocked,
    isMissing: item.isMissing,
    // Only present when true — a hard "do not reuse this one" marker that no
    // combination of the other flags conveys.
    ...(isMainWorktree(item) ? { isMainWorktree: true as const } : {}),
    // Task ownership, running processes, and local edits matter even with zero sessions.
    activeSessionCount: item.activeSessionCount,
    runningAgentCount: item.runningAgentCount,
    lastActivityAt: lastActivityAt(item) ?? undefined,
  };
}

/** Resolve a repo row by id, mapping NotFound to a structured ToolError. */
export async function resolveRepo(ctx: ToolContext, repoId: number) {
  try {
    return await ctx.services.repos.findOne(repoId);
  } catch {
    throw new ToolError({
      code: 'repo_not_found',
      message: `No repo with id ${repoId}.`,
      remediation: 'List valid repo ids with project_overview.',
    });
  }
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'worktree'
  );
}

/**
 * Default worktree path, mirroring WorktreePoolService.createForRepo so an
 * agent that omits an explicit path gets the same on-disk layout the UI uses.
 */
export function defaultWorktreePath(
  repo: { name: string; path: string },
  name: string,
): string {
  return path.join(
    path.dirname(repo.path),
    '.worktrees',
    repo.name,
    slugify(name),
  );
}
