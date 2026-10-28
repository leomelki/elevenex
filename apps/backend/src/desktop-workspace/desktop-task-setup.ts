/** Bounded display data; raw Git errors and setup configuration never cross the bridge. */
export interface DesktopTaskSetupIssue {
  readonly code:
    | 'external-checkout'
    | 'branch-in-use'
    | 'environment-busy'
    | 'other';
  readonly message: string;
  readonly workspacePath?: string;
  readonly canUseSnapshot: boolean;
  readonly canExceedWorktreeLimit?: boolean;
}

export function desktopTaskSetupIssue(
  value: unknown,
): DesktopTaskSetupIssue | undefined {
  if (value == null) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = value.length <= 16384 ? JSON.parse(value) : null;
    } catch {
      parsed = null;
    }
  }
  const error =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'worktree_limit_reached') {
    const { count, limit } = error;
    const validQuota =
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      typeof limit === 'number' &&
      Number.isSafeInteger(limit) &&
      limit > 0 &&
      count >= limit;
    return {
      // Keep the existing code vocabulary for older desktop clients.
      code: 'other',
      message: validQuota
        ? `This repository has ${count} workspaces, meeting or exceeding the configured limit of ${limit}. Your task has been saved. Free a workspace and retry, or create one above the limit for this task.`
        : 'This repository has reached its workspace limit. Your task has been saved. Free a workspace and retry, or create one above the limit for this task.',
      canUseSnapshot: false,
      canExceedWorktreeLimit: true,
    };
  }
  const canUseSnapshot =
    error.canSnapshot === true &&
    [
      'external_checkout',
      'branch_in_use',
      'environment_busy',
      'remote_differs',
    ].includes(code);
  if (code === 'external_checkout') {
    const path = error.path;
    return {
      code: 'external-checkout',
      message:
        'This branch is already checked out in another workspace. Your task has been saved.',
      ...(typeof path === 'string' &&
      path.length <= 4096 &&
      !/[\0\r\n]/.test(path)
        ? { workspacePath: path }
        : {}),
      canUseSnapshot,
    };
  }
  if (code === 'branch_in_use')
    return {
      code: 'branch-in-use',
      message:
        'Another task is using this branch. Use its committed revision in a separate workspace, or retry after that task finishes.',
      canUseSnapshot,
    };
  if (code === 'environment_busy')
    return {
      code: 'environment-busy',
      message:
        'The existing workspace has running work. Use a separate workspace at the committed revision, or retry after that work stops.',
      canUseSnapshot,
    };
  return {
    code: 'other',
    message:
      code === 'remote_differs'
        ? 'The local branch differs from the remote branch. Use the committed revision or retry after resolving the difference.'
        : 'The workspace could not be prepared. Your task has been saved; retry setup or check the repository.',
    canUseSnapshot,
  };
}
