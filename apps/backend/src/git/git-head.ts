import type { SimpleGit } from 'simple-git';

const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * Returns the checked-out branch name, or `null` when HEAD is detached
 * (including during a rebase or bisect). An unborn branch, in a repository
 * with no commits yet, still returns its name.
 *
 * Use this instead of simple-git's `branchLocal()`. That call runs
 * `git branch -v`, which computes ahead/behind against the upstream of every
 * local branch just to report the current one: 20 s in a large monorepo with
 * a few stale branches, against ~4 ms here. It also reports a detached HEAD
 * as a short SHA, or as `(no` mid-rebase, rather than "no branch".
 *
 * The full ref is read instead of `--short`, because `--short` returns
 * `heads/<name>` whenever a tag or remote ref shares the branch name.
 */
export async function readCurrentBranch(
  git: SimpleGit,
): Promise<string | null> {
  // Exit status 1 (detached HEAD) resolves with empty output in simple-git;
  // a broken or missing repository still rejects.
  const ref = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
  return ref.startsWith(BRANCH_REF_PREFIX)
    ? ref.slice(BRANCH_REF_PREFIX.length) || null
    : null;
}
