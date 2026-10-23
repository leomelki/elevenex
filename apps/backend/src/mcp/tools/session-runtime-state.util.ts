/**
 * Shared "is this session really done" check for the observe/drive tools that
 * wait on session completion (`session_status`, `prompt_session`,
 * `poll_session_status`, `await_session_event`).
 *
 * `sessionState`/`runPhase` go idle as soon as the *visible* turn ends, while
 * background work or queued prompts can remain unfinished. Background work
 * resumes autonomously; paused prompts require an explicit queue resume — see
 * `claude-runtime.service.ts`'s "Background work registry" section. Only
 * `pendingPrompts` is populated for every provider; `backgroundWork` is a
 * Claude-only signal and absent elsewhere, so both are optional here.
 */
export interface SessionRuntimeSnapshot {
  sessionState?: string | null;
  runPhase?: string | null;
  backgroundWork?: unknown[] | null;
  pendingPrompts?: unknown[] | null;
  queuePaused?: boolean | null;
  /** Claude task history; used to explain background work, never to gate it. */
  tasks?: unknown[] | null;
}

/** What a waiting agent needs to know about one live background item. */
export interface BackgroundWorkSummary {
  kind: string;
  label: string;
  /** Pass to stop_background_task. */
  taskId?: string;
  runningForMs?: number;
  canStop?: boolean;
  /**
   * Launched by a subagent that has already finished. Nothing is waiting on
   * its result any more, yet it still holds the session busy until it exits
   * or hits Claude Code's background time limit.
   */
  orphaned?: true;
}

const LIVE_TASK_STATUSES = new Set(['pending', 'running', 'paused']);

type TaskRecord = {
  taskId?: unknown;
  status?: unknown;
  parentTaskId?: unknown;
  canStop?: unknown;
};

/** Summarizes live background work so waiters can see what they wait on. */
export function summarizeBackgroundWork(
  state: SessionRuntimeSnapshot | null | undefined,
  now = Date.now(),
): BackgroundWorkSummary[] {
  if (!state?.backgroundWork?.length) return [];
  const tasks = new Map<string, TaskRecord>();
  for (const task of (state.tasks ?? []) as TaskRecord[]) {
    if (typeof task?.taskId === 'string') tasks.set(task.taskId, task);
  }
  return (
    state.backgroundWork as Array<{
      id?: unknown;
      kind?: unknown;
      label?: unknown;
      startedAt?: unknown;
    }>
  ).map((item) => {
    const id = typeof item.id === 'string' ? item.id : '';
    const taskId = id.startsWith('task:')
      ? id.slice('task:'.length)
      : undefined;
    const task = taskId ? tasks.get(taskId) : undefined;
    const parent =
      typeof task?.parentTaskId === 'string'
        ? tasks.get(task.parentTaskId)
        : undefined;
    const startedAtMs =
      typeof item.startedAt === 'string' ? Date.parse(item.startedAt) : NaN;
    return {
      kind: typeof item.kind === 'string' ? item.kind : 'task',
      label: typeof item.label === 'string' ? item.label : 'Background task',
      ...(taskId ? { taskId } : {}),
      ...(Number.isFinite(startedAtMs)
        ? { runningForMs: Math.max(0, now - startedAtMs) }
        : {}),
      ...(typeof task?.canStop === 'boolean' ? { canStop: task.canStop } : {}),
      ...(parent && !LIVE_TASK_STATUSES.has(String(parent.status))
        ? { orphaned: true as const }
        : {}),
    };
  });
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * One-line explanation of what keeps a session busy, for `nextStep`. Points
 * at stop_background_task when an item was left behind by a finished subagent.
 */
export function describeQueuedWork(
  work: BackgroundWorkSummary[],
  pendingPromptCount: number,
): string {
  const parts = work.slice(0, 3).map((item) => {
    const facts = [
      item.taskId ? `${item.kind} ${item.taskId}` : item.kind,
      item.runningForMs !== undefined
        ? `running ${formatDuration(item.runningForMs)}`
        : null,
      item.orphaned ? 'left behind by a finished subagent' : null,
    ].filter(Boolean);
    return `"${item.label}" (${facts.join(', ')})`;
  });
  if (work.length > 3) parts.push(`${work.length - 3} more`);
  if (pendingPromptCount > 0)
    parts.push(
      `${pendingPromptCount} queued prompt${pendingPromptCount === 1 ? '' : 's'}`,
    );
  const orphaned = work.some((item) => item.orphaned && item.canStop !== false);
  return `Waiting on ${parts.join('; ')}.${
    orphaned
      ? ' Nothing awaits a left-behind task; stop_background_task ends it if you do not need it.'
      : ''
  }`;
}

/** True when unfinished background work or queued prompts remain, including paused prompts. */
export function hasQueuedWork(
  state: SessionRuntimeSnapshot | null | undefined,
): boolean {
  if (!state) return false;
  return (
    (state.backgroundWork?.length ?? 0) > 0 ||
    (state.pendingPrompts?.length ?? 0) > 0
  );
}

/** Paused prompts require an explicit resume; new prompts do not unpause them. */
export function hasPausedQueue(
  state: SessionRuntimeSnapshot | null | undefined,
): boolean {
  return state?.queuePaused === true && (state.pendingPrompts?.length ?? 0) > 0;
}

/** A future prompt queue cannot replace the current turn's permission/error state. */
export function getSessionAttentionStatus(
  state: SessionRuntimeSnapshot | null | undefined,
): 'requires_action' | 'failed' | 'paused' | null {
  if (state?.sessionState === 'requires_action') return 'requires_action';
  if (state?.runPhase === 'error') return 'failed';
  if (hasPausedQueue(state)) return 'paused';
  return null;
}

export function describePausedQueue(
  sessionId: number,
  pendingPromptCount: number,
): string {
  return `Prompt queue paused (${pendingPromptCount} queued prompt${pendingPromptCount === 1 ? '' : 's'}). Queued prompts will not resume automatically. Call resume_pending_prompts with sessionId:${sessionId} to explicitly resume them.`;
}

/**
 * True only when the session is idle AND has no unfinished work, including
 * prompts paused pending an explicit resume. Checking only idle/idle can report
 * completion while background work or an unfinished queue remains.
 */
export function isSessionSettled(
  state: SessionRuntimeSnapshot | null | undefined,
): boolean {
  if (!state) return false;
  return (
    state.sessionState === 'idle' &&
    state.runPhase === 'idle' &&
    !hasQueuedWork(state)
  );
}
