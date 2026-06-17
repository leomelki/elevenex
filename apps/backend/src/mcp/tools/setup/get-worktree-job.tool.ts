import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * get_worktree_job — ⚡instant poll of a create_worktree background job. Returns
 * a compact status handle. Jobs are kept ~60s after they finish. When
 * succeeded, the worktree exists on disk — link_worktree next (or start a
 * session there).
 */
export const getWorktreeJobTool = defineTool({
  name: 'get_worktree_job',
  title: 'Get worktree job',
  costClass: 'instant',
  description:
    'Poll a create_worktree background job for its status (pending/running/succeeded/failed). ⚡instant. Jobs expire ~60s after finishing. On succeeded: link_worktree using the returned worktreePath.',
  annotations: { readOnlyHint: true },
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the job belongs to (must match the create_worktree call).'),
    jobId: z.string().min(1).describe('Job id returned by create_worktree.'),
  },
  handler: async (args, ctx) => {
    const { worktreeJobs } = ctx.services;
    let job;
    try {
      job = worktreeJobs.getJob(args.repoId, args.jobId);
    } catch {
      throw new ToolError({
        code: 'job_not_found',
        message: `Worktree job ${args.jobId} not found for repo ${args.repoId}.`,
        remediation:
          'Jobs expire ~60s after finishing. If it succeeded, find the worktree via assess_worktree_pool instead.',
        retryable: false,
      });
    }

    const done = job.status === 'succeeded';
    return {
      data: {
        jobId: job.id,
        status: job.status,
        branchName: job.branchName,
        worktreePath: job.result?.path ?? job.worktreePath,
        error: job.error ?? undefined,
      },
      nextStep: done
        ? 'Worktree ready — link_worktree with this repoId + worktreePath, then create a session.'
        : job.status === 'failed'
          ? 'Job failed — inspect error, then retry create_worktree with a different branch/path.'
          : 'Still working — poll get_worktree_job again shortly.',
    };
  },
});
