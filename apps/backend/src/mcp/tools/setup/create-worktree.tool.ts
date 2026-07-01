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
 *  3. Branch missing locally + from_origin unset/false → error; agent must decide
 *     whether to fetch (from_origin: true) or create (pass startPoint).
 */
export const createWorktreeTool = defineTool({
  name: 'create_worktree',
  title: 'Create worktree',
  costClass: 'heavy',
  mutates: true,
  description:
    'Start a background job to create a new git worktree for a branch and return a jobId immediately (never blocks). 🔴heavy. ' +
    'If branchName has no local branch AND from_origin is not set, the tool returns an error asking whether to fetch it from origin (from_origin: true) or create a new branch (pass startPoint). ' +
    'When from_origin is true the tool fetches origin/<branch> before creating the worktree and returns a branchSnapshot (ahead/behind origin, last commit) so the agent can assess branch state immediately. ' +
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
        'Base ref to fork a NEW local branch from (e.g. main, origin/main). ' +
        'Used only when branchName has no local ref and from_origin is not true; ignored otherwise.',
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

    if (!localExists) {
      if (!args.from_origin && !args.startPoint?.trim()) {
        // Branch does not exist locally — agent must decide what to do next.
        const remoteExists = await worktrees.remoteBranchExists(repo.path, branchName);
        throw new ToolError({
          code: 'branch_not_found_locally',
          message: `Branch "${branchName}" does not exist locally.`,
          remediation: remoteExists
            ? `origin/${branchName} exists. Re-call with from_origin: true to fetch and create a local tracking branch, or pass startPoint to create a fresh branch from a different base.`
            : `No local or remote branch named "${branchName}" was found. Pass startPoint (e.g. "origin/main") to create a new branch from that base.`,
          retryable: true,
        });
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

    let branchSnapshot: BranchSnapshot | undefined;
    if (args.from_origin) {
      branchSnapshot = await worktrees.getBranchSnapshot(repo.path, branchName);
    }

    const job = worktreeJobs.startJob(
      repo.id,
      repo.path,
      branchName,
      worktreePath,
      // startPoint is only relevant when creating a brand-new branch; after a
      // fetch the local branch already points at the right commit.
      !localExists && !args.from_origin ? args.startPoint?.trim() : undefined,
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
