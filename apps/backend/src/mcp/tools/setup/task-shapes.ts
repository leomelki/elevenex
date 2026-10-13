import { z } from 'zod';

export const taskId = z
  .number()
  .int()
  .positive()
  .describe(
    'Stable task ID from get_current_session, create_task, or list_tasks. Also the workspaceId.',
  );
export const repoId = z
  .number()
  .int()
  .positive()
  .describe('Repository ID from get_current_session or project_overview.');
export const setupShape = {
  name: z
    .string()
    .trim()
    .max(160)
    .optional()
    .describe(
      'Task display name, independent of branch and worktree path; defaults to branch name.',
    ),
  mode: z
    .enum(['new', 'existing'])
    .describe(
      'new creates a branch; existing selects a fully qualified local/remote branch.',
    ),
  branchName: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe(
      'New branch name or existing refs/heads/name or refs/remotes/remote/name. Use find_branches to discover unambiguous refs.',
    ),
  baseRef: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .optional()
    .describe(
      'Base branch/revision for new mode; defaults to repository default. Remote refs are refreshed automatically.',
    ),
  checkoutMode: z
    .enum(['branch', 'snapshot'])
    .optional()
    .describe(
      'branch (default) for implementation; snapshot for an isolated committed revision of an occupied branch.',
    ),
  environment: z
    .enum(['automatic', 'new', 'existing'])
    .optional()
    .describe(
      'automatic (default) allocates/reuses a clean managed worktree; existing selects worktreeId; new requests another worktree.',
    ),
  worktreeId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Pool ID from assess_worktree_pool when environment is existing. The allocator validates ownership and local changes.',
    ),
  confirmOverLimit: z
    .boolean()
    .optional()
    .describe(
      'True only after the human explicitly approves exceeding the configured worktree cap.',
    ),
  confirmExternal: z
    .boolean()
    .optional()
    .describe(
      'True only after the human explicitly chooses an external checkout or checkout with local edits; snapshot avoids using it.',
    ),
  useSavedRef: z
    .boolean()
    .optional()
    .describe(
      'Explicitly accept the locally saved remote ref after a refresh failure; never automatically enable this.',
    ),
};
export const retryShape = {
  ...setupShape,
  mode: setupShape.mode.optional(),
  branchName: setupShape.branchName.optional(),
};
