import * as path from 'node:path';
import type { WorktreePoolItem } from '../../../worktrees/worktree-pool.service.js';
import { ToolError } from '../../tool-registry/tool.types.js';
import type { ToolContext } from '../../tool-registry/tool.types.js';

export type WorktreeCategory = 'available' | 'yours' | 'all';

/**
 * Derive a coarse category for a pool item from its link/owner flags:
 *  - `available` — no owning workspace (unlinked & unowned), free to take.
 *  - `yours`     — has a linked owning workspace (owned by a project here).
 * The pool item carries no per-agent identity, so "yours" means "owned by an
 * elevenex project" rather than a specific caller.
 */
export function deriveCategory(item: WorktreePoolItem): 'available' | 'yours' {
  return item.owner ? 'yours' : 'available';
}

export function matchesCategory(
  item: WorktreePoolItem,
  category: WorktreeCategory,
): boolean {
  if (category === 'all') return true;
  return deriveCategory(item) === category;
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
    path: item.path,
    branch: item.currentBranch ?? undefined,
    category: deriveCategory(item),
    owner: item.owner
      ? { project: item.owner.projectName, workspace: item.owner.workspaceName }
      : undefined,
    isDirty: item.isDirty,
    hasConflicts: item.hasConflicts,
    isLocked: item.isLocked,
    isMissing: item.isMissing,
    // Sessions still bound to this worktree: >0 means someone is using it and
    // its files must stay put. 0 means it is free regardless of what it holds.
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
