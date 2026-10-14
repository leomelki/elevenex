import { HttpException } from '@nestjs/common';
import type { TasksService } from '../../../tasks/tasks.service.js';
import { ToolError, type ToolContext } from '../../tool-registry/tool.types.js';

type Task = Awaited<ReturnType<TasksService['get']>>;

export function taskHandle(
  task: Task,
  ctx: ToolContext,
  offset = 0,
  limit = 1,
) {
  const stage: unknown = task.preparationStage;
  return {
    taskId: task.id,
    workspaceId: task.id,
    repoId: task.repoId,
    name: task.name,
    state: task.taskState,
    finishedAt: task.archivedAt,
    finishScheduled: !!task.taskFinishRequest,
    finishRequestedBySessionId: task.taskFinishRequest?.sessionId ?? null,
    branch: task.taskBranch,
    sourceRef: task.sourceRef,
    checkoutMode: task.checkoutMode,
    startingCommit: task.startingCommit,
    finalCommit: task.finalCommit,
    preparationStage: typeof stage === 'string' ? stage : null,
    linkStatus: task.linkStatus,
    worktreeId: task.poolWorktreeId,
    environmentPath: task.linkStatus === 'linked' ? task.path : null,
    environmentAvailable:
      !task.archivedAt &&
      task.taskState === 'ready' &&
      task.linkStatus === 'linked' &&
      !task.error,
    error: task.error,
    draftLength: task.taskDraft?.length ?? 0,
    sessionCount: task.sessions.length,
    sessionOffset: offset,
    nextSessionOffset:
      offset + limit < task.sessions.length ? offset + limit : null,
    sessions: task.sessions.slice(offset, offset + limit).map((session) => ({
      sessionId: session.id,
      name: session.name,
      status: session.status,
      provider: session.activeAgentProvider,
      deepLink: ctx.deepLink.session(session.id),
    })),
  };
}

export function taskNextStep(task: Task): string {
  if (task.archivedAt)
    return 'Read preserved conversations with read_session. To work again, reopen_task, then get_task until ready.';
  if (task.taskState === 'failed' || task.error)
    return 'Inspect error recovery details. Use retry_task with an explicit recovery choice; use finish_task again for finish_failed cleanup.';
  if (task.taskState !== 'ready')
    return 'Setup or cleanup is still in progress. await_task_ready waits for preparation; get_task inspects current state before opening or prompting a session.';
  if (task.taskFinishRequest)
    return 'Finishing is scheduled after the requesting session and its background work become idle. The requester can cancel_finish_task before cleanup starts if more work is needed or they reconsider; otherwise send the final reply and end the turn without polling.';
  return 'open_task_session reuses the latest active conversation. create_session adds a separate conversation sharing this task’s files; create_task with snapshot creates an isolated review.';
}

/** Preserve actionable conflict fields instead of hiding snapshot/external recovery choices. */
export async function taskOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse();
    const detail =
      typeof response === 'string'
        ? { message: response }
        : (response as Record<string, unknown>);
    const code =
      typeof detail.code === 'string'
        ? detail.code
        : error.getStatus() === 404
          ? 'task_not_found'
          : 'task_operation_failed';
    const details = Object.fromEntries(
      Object.entries(detail).filter(
        ([key]) => !['code', 'message', 'statusCode', 'error'].includes(key),
      ),
    );
    throw new ToolError({
      code,
      message:
        typeof detail.message === 'string' ? detail.message : error.message,
      remediation:
        'Inspect get_task. For occupied branches use checkoutMode:"snapshot"; for explicit worktree selection use environment:"existing" plus worktreeId. Retry setup with retry_task; reopen finished tasks before running sessions.',
      details: Object.keys(details).length ? details : undefined,
      retryable: error.getStatus() === 409,
    });
  }
}
