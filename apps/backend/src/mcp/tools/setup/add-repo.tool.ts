import { z } from 'zod';
import { defineTool, ToolError } from '../../tool-registry/tool.types.js';

/**
 * add_repo — idempotent attach of a git repo to a project by absolute path.
 * ⚡instant. Reuses an existing repo at the same path or registers it. Next:
 * assess_worktree_pool to see what worktrees are available to work in.
 */
export const addRepoTool = defineTool({
  name: 'add_repo',
  title: 'Add repo',
  costClass: 'instant',
  mutates: true,
  description:
    'Attach a git repository to a project by absolute on-disk path, reusing it if already added (idempotent). ⚡instant. Next: assess_worktree_pool to find or create a worktree to run in.',
  annotations: { idempotentHint: true },
  inputShape: {
    projectId: z
      .number()
      .int()
      .positive()
      .describe('Project to attach the repo to. From find_or_create_project.'),
    repoPath: z
      .string()
      .min(1)
      .describe('Absolute filesystem path to the git repository root (must contain .git).'),
  },
  handler: async (args, ctx) => {
    const { repos } = ctx.services;
    const repoPath = args.repoPath.trim();

    const existing = (await repos.findByProject(args.projectId)).find(
      (r) => r.path === repoPath,
    );

    let repo = existing;
    if (!repo) {
      try {
        repo = await repos.addRepo(args.projectId, repoPath);
      } catch (error) {
        // Idempotent fallback: a concurrent add (or realpath alias) may have
        // raised the unique conflict — reuse the existing row if present.
        const afterConflict = (await repos.findByProject(args.projectId)).find(
          (r) => r.path === repoPath,
        );
        if (afterConflict) {
          repo = afterConflict;
        } else {
          throw new ToolError({
            code: 'add_repo_failed',
            message:
              error instanceof Error ? error.message : 'Could not add repo.',
            remediation:
              'Verify the path is an absolute path to a git repository (contains a .git directory).',
          });
        }
      }
    }

    return {
      data: {
        repoId: repo.id,
        projectId: repo.projectId,
        name: repo.name,
        path: repo.path,
        reused: existing !== undefined,
      },
      touched: { repoId: repo.id },
      deepLink: ctx.deepLink.project(repo.projectId),
      nextStep:
        'Inspect worktrees with assess_worktree_pool, then link_worktree or create_worktree.',
    };
  },
});
