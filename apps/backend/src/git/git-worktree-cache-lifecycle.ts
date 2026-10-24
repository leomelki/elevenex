import * as path from 'node:path';
import { clearWorktreeFingerprintCache } from './git-worktree-fingerprint.js';
import { clearLocalRefState } from './git-local-state.js';
import { clearWorktreeTextStats } from './git-file-stats.js';

interface WorktreeCache {
  releaseWorktree(worktreePath: string): void;
}
const owners = new Set<WeakRef<WorktreeCache>>();

export function registerWorktreeCache(owner: WorktreeCache): () => void {
  for (const ref of owners) if (!ref.deref()) owners.delete(ref);
  const ref = new WeakRef(owner);
  owners.add(ref);
  return () => {
    owners.delete(ref);
  };
}

/** Called after successful removal or pool release, never before Git succeeds. */
export function releaseGitWorktreeCaches(worktreePath: string): void {
  const normalized = path.resolve(worktreePath);
  clearWorktreeFingerprintCache(normalized);
  clearLocalRefState(normalized);
  clearWorktreeTextStats(normalized);
  for (const ref of owners) {
    const owner = ref.deref();
    if (owner) owner.releaseWorktree(normalized);
    else owners.delete(ref);
  }
}
