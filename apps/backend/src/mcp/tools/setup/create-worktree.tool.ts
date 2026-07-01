import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { defaultWorktreePath, resolveRepo } from './worktree.util.js';
import type { BranchSnapshot } from '../../../worktrees/worktrees.service.js';

/**
 * create_worktree — 🔴heavy. Spawns a background `git worktree add` job and
 * returns IMMEDIATELY with a jobId; never blocks. The job dedupes on
 * (repo, branch, path) so retries are idempotent. Poll get_worktree_job until
 * it succeeds, then link_worktree.
 *
 * Branch resolution order:
 *  1. Branch exists locally → proceed, optionally fetch+snapshot when from_origin=true.
 *  2. Branch missing locally + from_origin=true → fetch from origin (creates local
 *     tracking branch), then proceed with snapshot.
 *  3. Branch missing locally + from_origin unset/false + startPoint provided →
 *     create a new local branch forked from startPoint (no remote lookup).
 *  4. Branch missing locally + from_origin unset/false + startPoint omitted →
 *     auto-detect the repo's default branch via `refs/remotes/origin/HEAD` and
 *     use it as startPoint. If detection fails, error so the agent can decide.
 *
 * Freshness: pass fetch_start_point:true to run `git fetch origin <base>` before
 * the job starts, ensuring the branch is forked from the latest upstream commit.
 */
export const createWorktreeTool = defineTool({
  name: 'create_worktree',
  title: 'Create worktree',
  costClass: 'heavy',
  mutates: true,
  description:
    'Start a background job to create a new git worktree for a branch and return a jobId immediately (never blocks). 🔴heavy. ' +
    'If branchName has no local ref and neither from_origin nor startPoint is set, the tool auto-detects the repo default branch (origin/HEAD) and uses it as startPoint — no extra call needed for the common "new branch off main" case. ' +
    'Pass startPoint explicitly to fork from a specific ref (e.g. "origin/release/2.0"). ' +
    'Pass fetch_start_point: true (recommended for new feature branches) to fetch the base ref from origin before forking, so the new branch starts from the latest upstream commit rather than a potentially stale local tracking ref. ' +
    'Pass from_origin: true to fetch an existing remote branch instead of creating a new one; this also returns a branchSnapshot (ahead/behind, last commit). ' +
    'The job dedupes on repo+branch+path. Next: poll get_worktree_job until succeeded, then link_worktree.',
  annotations: { idempotentHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo to create the worktree in. From add_repo / project_overview.'),
    branchName: z
      .string()
      .min(1)
      .describe('Branch to check out in the new worktree (e.g. feature/foo).'),
    from_origin: z
      .boolean()
      .optional()
      .describe(
        'When true: fetch the branch from origin before creating the worktree. ' +
        'If the branch has no local ref, git creates it from origin/<branch>. ' +
        'If the branch already exists locally, the fetch refreshes the remote tracking ref. ' +
        'In both cases a branchSnapshot (ahead/behind, last commit) is returned alongside the jobId.',
      ),
    startPoint: z
      .string()
      .optional()
      .describe(
        'Base ref to fork a NEW local branch from (e.g. "main", "origin/main", "origin/release/2.0"). ' +
        'Used only when branchName has no local ref and from_origin is not true; ignored otherwise. ' +
        'When omitted the tool auto-detects the repo default branch (origin/HEAD) so you rarely need to set this.',
      ),
    fetch_start_point: z
      .boolean()
      .optional()
      .describe(
        'When true: fetch the base ref from origin before forking the new branch. ' +
        'Ensures the worktree starts from the latest upstream commit rather than a potentially ' +
        'stale local tracking ref. Recommended when creating feature branches off main/master. ' +
        'Ignored when from_origin is true (which already performs its own fetch) or when ' +
        'branchName already exists locally.',
      ),
    worktreePath: z
      .string()
      .optional()
      .describe(
        'Explicit absolute path for the worktree. Omit to use the default .worktrees/<repo>/<slug> layout.',
      ),
  },
  handler: async (args, ctx) => {
    const { worktreeJobs, worktrees } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const branchName = args.branchName.trim();
    if (!branchName) {
      throw new ToolError({
        code: 'invalid_branch',
        message: 'branchName is required.',
        remediation: 'Pass a non-empty branch name.',
      });
    }

    const worktreePath = args.worktreePath?.trim() || defaultWorktreePath(repo, branchName);

    const localExists = await worktrees.localBranchExists(repo.path, branchName);

    // Resolved start point: explicit arg wins; otherwise auto-detect default branch.
    let resolvedStartPoint = args.startPoint?.trim() || undefined;

    if (!localExists) {
      if (!args.from_origin && !resolvedStartPoint) {
        // Auto-detect the repo's default branch from refs/remotes/origin/HEAD.
        const detected = await worktrees.getDefaultBranch(repo.path);
        if (detected) {
          resolvedStartPoint = detected;
        } else {
          // Detection failed (no remote, shallow clone, etc.) — ask the agent.
          const remoteExists = await worktrees.remoteBranchExists(repo.path, branchName);
          throw new ToolError({
            code: 'branch_not_found_locally',
            message: `Branch "${branchName}" does not exist locally and the repo default branch could not be detected.`,
            remediation: remoteExists
              ? `origin/${branchName} exists. Re-call with from_origin: true to fetch and create a local tracking branch, or pass startPoint to create a fresh branch from a different base.`
              : `No local or remote branch named "${branchName}" was found. Pass startPoint (e.g. "origin/main") to create a new branch from that base.`,
            retryable: true,
          });
        }
      }

      if (args.from_origin) {
        // from_origin=true: fetch creates the local tracking branch
        const remoteExists = await worktrees.remoteBranchExists(repo.path, branchName);
        if (!remoteExists) {
          throw new ToolError({
            code: 'remote_branch_not_found',
            message: `Branch "${branchName}" does not exist on origin and has no local ref.`,
            remediation: `Pass startPoint (e.g. "origin/main") to create a new branch from a base ref instead.`,
          });
        }

        await worktrees.fetchBranch(repo.path, branchName, true);
      }
    } else if (args.from_origin) {
      // Branch exists locally; refresh the remote tracking ref
      await worktrees.fetchBranch(repo.path, branchName, false);
    }

    // Refresh the base ref so the new branch starts from the latest upstream commit.
    if (!localExists && !args.from_origin && args.fetch_start_point && resolvedStartPoint) {
      const baseRemoteBranch = resolvedStartPoint.startsWith('origin/')
        ? resolvedStartPoint.slice('origin/'.length)
        : resolvedStartPoint;
      await worktrees.fetchBranch(repo.path, baseRemoteBranch, false);
    }

    let branchSnapshot: BranchSnapshot | undefined;
    if (args.from_origin) {
      branchSnapshot = await worktrees.getBranchSnapshot(repo.path, branchName);
    }

    const job = worktreeJobs.startJob(
      repo.id,
      repo.path,
      branchName,
      worktreePath,
      // resolvedStartPoint is set for new branches (explicit or auto-detected).
      // After a from_origin fetch the local branch already points at the right
      // commit, so startPoint would be ignored by git anyway.
      !localExists && !args.from_origin ? resolvedStartPoint : undefined,
    );

    return {
      data: {
        jobId: job.id,
        status: job.status,
        repoId: repo.id,
        branchName,
        worktreePath,
        ...(branchSnapshot !== undefined ? { branchSnapshot } : {}),
      },
      touched: { jobId: job.id },
      nextStep:
        'Poll get_worktree_job with this repoId + jobId until status is "succeeded", then link_worktree.',
    };
  },
});
