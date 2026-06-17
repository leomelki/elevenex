import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { defaultWorktreePath, resolveRepo } from './worktree.util.js';

/**
 * create_worktree — 🔴heavy. Spawns a background `git worktree add` job and
 * returns IMMEDIATELY with a jobId; never blocks. The job dedupes on
 * (repo, branch, path) so retries are idempotent. Poll get_worktree_job until
 * it succeeds, then link_worktree.
 */
export const createWorktreeTool = defineTool({
  name: 'create_worktree',
  title: 'Create worktree',
  costClass: 'heavy',
  mutates: true,
  description:
    'Start a background job to create a new git worktree for a branch and return a jobId immediately (never blocks). 🔴heavy. The job dedupes on repo+branch+path. Next: poll get_worktree_job until succeeded, then link_worktree.',
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
      .describe('Branch to create/check out in the new worktree (e.g. feature/foo).'),
    startPoint: z
      .string()
      .optional()
      .describe("Base ref to branch from (e.g. main, origin/main). Defaults to the repo's HEAD."),
    worktreePath: z
      .string()
      .optional()
      .describe(
        'Explicit absolute path for the worktree. Omit to use the default .worktrees/<repo>/<slug> layout.',
      ),
  },
  handler: async (args, ctx) => {
    const { worktreeJobs } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const branchName = args.branchName.trim();
    if (!branchName) {
      throw new ToolError({
        code: 'invalid_branch',
        message: 'branchName is required.',
        remediation: 'Pass a non-empty branch name.',
      });
    }

    const worktreePath =
      args.worktreePath?.trim() || defaultWorktreePath(repo, branchName);

    // startJob runs `git worktree add` asynchronously and returns a pending
    // handle — we return it straight away so the agent polls instead of blocking.
    const job = worktreeJobs.startJob(repo.id, repo.path, branchName, worktreePath);

    return {
      data: {
        jobId: job.id,
        status: job.status,
        repoId: repo.id,
        branchName,
        worktreePath,
      },
      touched: { jobId: job.id },
      nextStep:
        'Poll get_worktree_job with this repoId + jobId until status is "succeeded", then link_worktree.',
    };
  },
});
