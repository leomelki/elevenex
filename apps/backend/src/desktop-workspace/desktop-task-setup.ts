import { workspaceTaskError } from '../workspaces/workspace-checkout-errors.js';

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
  readonly closeFailed?: true;
  readonly workspaceRecovery?: 'prepare' | 'restore-branch' | 'new-workspace';
}

export type DesktopTaskSetupStep = 'queued' | 'fetching' | 'waiting' | 'checkout' | 'sessions';

const SETUP_STEPS: ReadonlyMap<string, DesktopTaskSetupStep> = new Map([
  ['refreshing_ref', 'fetching'],
  ['waiting_for_checkout', 'waiting'],
  ['preparing_checkout', 'checkout'],
  ['restoring_sessions', 'sessions'],
]);

/**
 * The display step of a task's workspace setup: its current step while
 * preparing, or the step where a failed setup stopped. Failures outside setup
 * (missing folders, close cleanup) record no stage and report none.
 */
export function desktopTaskSetupStep(
  state: string,
  taskConfig: string | null,
): DesktopTaskSetupStep | undefined {
  if (state !== 'preparing' && state !== 'failed') return undefined;
  let stage: unknown;
  try {
    stage = taskConfig && taskConfig.length <= 65536
      ? (JSON.parse(taskConfig) as { preparationStage?: unknown }).preparationStage
      : undefined;
  } catch {
    stage = undefined;
  }
  const step = typeof stage === 'string' ? SETUP_STEPS.get(stage) : undefined;
  // Accepted but not yet started: a retry or a setup waiting for its turn.
  return step ?? (state === 'preparing' ? 'queued' : undefined);
}

export function desktopTaskSetupIssue(
  value: unknown,
): DesktopTaskSetupIssue | undefined {
  if (value == null) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = value.length <= 16384 ? workspaceTaskError(value) : null;
    } catch {
      parsed = null;
    }
  }
  const error =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'finish_failed')
    return {
      code: 'other',
      message: 'The task could not be closed. Its workspace is still reserved. Retry closing to finish cleanup.',
      canUseSnapshot: false,
      closeFailed: true,
    };
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
      'checkout_unavailable',
    ].includes(code);
  if (code === 'environment_missing')
    return {
      code: 'other',
      message:
        'The workspace folder is missing. Prepare a workspace to continue. Your conversations are saved.',
      canUseSnapshot: false,
      workspaceRecovery: 'prepare',
    };
  if (code === 'checkout_unavailable')
    return {
      code: 'other',
      message:
        'The workspace is locked or cannot be accessed. Restore access and retry, or use a separate workspace at the committed revision.',
      canUseSnapshot,
    };
  if (code === 'worktree_not_clean')
    return {
      code: 'other',
      message:
        'The workspace has local changes from interrupted setup. Keep them here and prepare a separate workspace to continue.',
      canUseSnapshot: false,
      workspaceRecovery: 'new-workspace',
    };
  if (code === 'branch_missing')
    return {
      code: 'other',
      message:
        'This task’s branch was deleted. Restore it from the saved revision to continue. Your conversations are saved.',
      canUseSnapshot: false,
      ...(typeof error.savedCommit === 'string' &&
      /^[0-9a-f]{40,64}$/.test(error.savedCommit)
        ? { workspaceRecovery: 'restore-branch' as const }
        : {}),
    };
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
