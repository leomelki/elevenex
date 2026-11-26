/** Shared by checkout observation, pool reconciliation and task recovery. */
export const MISSING_WORKTREE_ERROR: {
  code: string;
  message: string;
  [key: string]: unknown;
} = {
  code: 'environment_missing',
  message:
    'This task’s worktree is unavailable. Prepare a worktree to continue from its branch or saved revision. Your conversations are preserved.',
};

export function workspaceTaskError(value: string | null): {
  code?: string;
  message?: string;
  savedCommit?: string;
} | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { message: value };
    const error = parsed as Record<string, unknown>;
    // Older pool reconciliation wrote this failure without a recovery code.
    if (
      !error.code &&
      error.message ===
        'The task worktree is missing. Reopen or choose another worktree.'
    )
      return MISSING_WORKTREE_ERROR;
    return {
      ...error,
      code: typeof error.code === 'string' ? error.code : undefined,
      message: typeof error.message === 'string' ? error.message : undefined,
      savedCommit:
        typeof error.savedCommit === 'string' ? error.savedCommit : undefined,
    };
  } catch {
    return { message: value };
  }
}
