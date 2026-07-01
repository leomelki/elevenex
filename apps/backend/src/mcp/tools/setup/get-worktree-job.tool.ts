import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

const WAIT_TIMEOUT_MS = 90_000;

/**
 * get_worktree_job — waits up to 90s for a create_worktree background job to
 * finish, then returns the result. Only returns early if the job is already
 * done or if the 90s window elapses (in which case, call again). Jobs are
 * kept ~60s after they finish. On succeeded, link_worktree next.
 */
export const getWorktreeJobTool = defineTool({
  name: 'get_worktree_job',
  title: 'Get worktree job',
  costClass: 'instant',
  description:
    'Wait up to 90s for a create_worktree background job to finish (pending/running/succeeded/failed). Blocks until the job completes or the timeout elapses. If it times out, call again — the job is still running. Jobs expire ~60s after finishing. On succeeded: link_worktree using the returned worktreePath.',
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
    let result: Awaited<ReturnType<typeof worktreeJobs.waitForCompletion>>;
    try {
      result = await worktreeJobs.waitForCompletion(
        args.repoId,
        args.jobId,
        WAIT_TIMEOUT_MS,
      );
    } catch {
      throw new ToolError({
        code: 'job_not_found',
        message: `Worktree job ${args.jobId} not found for repo ${args.repoId}.`,
        remediation:
          'Jobs expire ~60s after finishing. If it succeeded, find the worktree via assess_worktree_pool instead.',
        retryable: false,
      });
    }

    if (result === 'timeout') {
      return {
        data: {
          jobId: args.jobId,
          status: 'running' as const,
          timedOut: true,
        },
        nextStep:
          'Job is still running after 90s — call get_worktree_job again with the same jobId to keep waiting.',
      };
    }

    const done = result.status === 'succeeded';
    return {
      data: {
        jobId: result.id,
        status: result.status,
        branchName: result.branchName,
        worktreePath: result.result?.path ?? result.worktreePath,
        error: result.error ?? undefined,
      },
      nextStep: done
        ? 'Worktree ready — link_worktree with this repoId + worktreePath, then create a session.'
        : 'Job failed — inspect error, then retry create_worktree with a different branch/path.',
    };
  },
});
