import { z } from 'zod';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';
import { resolveRepo } from './worktree.util.js';

/**
 * switch_branch — mutates. Check out a different EXISTING branch in a workspace's
 * worktree, reusing it instead of provisioning a new one. Routes through the
 * exact same WorkspacesService.switchBranch the UI's git switch uses, so the
 * dirty-guard, "already checked out elsewhere" guard, and session re-pointing
 * all behave identically. For a NEW branch, use create_worktree (which now
 * creates the branch from startPoint) instead.
 */
export const switchBranchTool = defineTool({
  name: 'switch_branch',
  title: 'Switch branch',
  costClass: 'scoped',
  mutates: true,
  description:
    "Check out a different existing branch in a linked workspace's worktree (the same git switch the UI does). 🟡scoped. Reuse this when you want an existing worktree to work on another branch instead of creating a new one. Refuses if the worktree has uncommitted changes (set force:true to switch anyway) or if the branch is already checked out in another worktree. For a brand-new branch, use create_worktree instead. Get workspaceId from link_worktree / create_session / project_overview.",
  inputShape: {
    repoId: z
      .number()
      .int()
      .positive()
      .describe('Repo the workspace belongs to. From project_overview.'),
    workspaceId: z
      .number()
      .int()
      .positive()
      .describe(
        'Workspace (linked worktree) to switch. From link_worktree / create_session / project_overview.',
      ),
    branchName: z
      .string()
      .min(1)
      .describe('Existing branch to check out in this workspace.'),
    force: z
      .boolean()
      .optional()
      .describe(
        'Switch even when the worktree has uncommitted changes (git carries them over and fails on conflict). Defaults to false.',
      ),
  },
  handler: async (args, ctx) => {
    const { workspaces } = ctx.services;
    const repo = await resolveRepo(ctx, args.repoId);
    const branchName = args.branchName.trim();

    try {
      const ws = await workspaces.switchBranch(
        args.workspaceId,
        branchName,
        args.force ?? false,
        repo.id,
      );

      return {
        data: {
          workspaceId: ws.id,
          repoId: repo.id,
          name: ws.name,
          path: ws.path,
          branch: branchName,
        },
        touched: { workspaceId: ws.id },
        deepLink: ctx.deepLink.project(repo.projectId),
        nextStep:
          'Branch switched — prompt or create a session in this workspace to work on it.',
      };
    } catch (error) {
      if (error instanceof ConflictException) {
        // Branch is checked out in another worktree — switching here is impossible.
        throw new ToolError({
          code: 'branch_checked_out_elsewhere',
          message: error.message,
          remediation:
            'That branch is already checked out in another worktree. Use that worktree, or pick a different branch.',
          retryable: false,
        });
      }
      if (error instanceof BadRequestException) {
        const message = error.message;
        // Dirty worktree guard — do NOT auto-force; surface it so the agent
        // decides (commit/stash, retry with force, or escalate).
        if (/uncommitted changes/i.test(message)) {
          throw new ToolError({
            code: 'switch_requires_confirmation',
            message,
            remediation:
              'The worktree has uncommitted changes. Commit them, or retry with force:true to switch anyway (git will refuse if the changes conflict).',
            retryable: false,
          });
        }
        throw new ToolError({
          code: 'switch_failed',
          message,
          remediation:
            'Ensure the workspace is linked and the branch name exists. Re-check ids with project_overview.',
          retryable: false,
        });
      }
      throw new ToolError({
        code: 'switch_failed',
        message: error instanceof Error ? error.message : 'Could not switch branch.',
        remediation:
          'Verify the branch exists (e.g. it may need to be fetched) and is not checked out elsewhere.',
      });
    }
  },
});
