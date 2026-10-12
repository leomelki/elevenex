import type {
  ClaudeSubagentState,
  ClaudeTaskState,
} from './claude-runtime.types.js';

export const MAX_SETTLED_CLAUDE_TASKS = 200;
export const isLiveClaudeTask = (
  task: Pick<ClaudeTaskState, 'status'>,
): boolean => ['pending', 'running', 'paused'].includes(task.status);

/** Undefined fields are patches, not deletions. Old runs must never revive a worker. */
export function mergeClaudeTask(
  existing: ClaudeTaskState | undefined,
  patch: Partial<ClaudeTaskState> &
    Pick<ClaudeTaskState, 'taskId' | 'updatedAt'>,
  started = false,
): ClaudeTaskState {
  if (existing?.runId && patch.runId && patch.runId < existing.runId)
    return existing;
  const newRun = Boolean(
    existing && patch.runId && patch.runId !== existing.runId,
  );
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const task = {
    ...existing,
    ...fields,
    status: patch.status ?? existing?.status ?? 'pending',
    startedAt: newRun
      ? patch.updatedAt
      : (existing?.startedAt ?? patch.startedAt ?? patch.updatedAt),
  } as ClaudeTaskState;
  if (
    existing &&
    !isLiveClaudeTask(existing) &&
    !newRun &&
    !started &&
    isLiveClaudeTask(task)
  )
    task.status = existing.status;
  if (newRun) {
    task.endTime = undefined;
    task.error = patch.error;
    task.usage = patch.usage;
    task.summary = patch.summary;
  }
  return task;
}

/** Keep every live worker; history bounds must not become execution limits. */
export function retainClaudeTasks<T>(
  items: T[],
  live: (item: T) => boolean,
  maxSettled = MAX_SETTLED_CLAUDE_TASKS,
): T[] {
  let settled = 0;
  return items.filter((item) => live(item) || settled++ < maxSettled);
}

export function mergeClaudeSubagent(
  existing: ClaudeSubagentState | undefined,
  patch: ClaudeSubagentState,
): ClaudeSubagentState {
  if (existing?.runId && patch.runId && patch.runId < existing.runId)
    return existing;
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
  } as ClaudeSubagentState;
}

export function taskSubagent(
  task: ClaudeTaskState,
  existing?: ClaudeSubagentState,
  assignment?: Record<string, unknown>,
): ClaudeSubagentState {
  const live = isLiveClaudeTask(task);
  const executionStatus: ClaudeSubagentState['executionStatus'] = {
    pending: 'pending',
    running: 'running',
    paused: 'paused',
    unavailable: 'unavailable',
    completed: 'completed',
    failed: 'error',
    killed: 'interrupted',
    stopped: 'interrupted',
  }[task.status] as ClaudeSubagentState['executionStatus'];
  const text = (key: string): string | undefined =>
    typeof assignment?.[key] === 'string'
      ? (assignment[key] as string)
      : undefined;
  const result = mergeClaudeSubagent(existing, {
    agentId: task.taskId,
    taskId: task.taskId,
    runId: task.runId,
    agentType:
      task.subagentType ??
      text('subagent_type') ??
      existing?.agentType ??
      'general-purpose',
    displayName: text('name') ?? task.description ?? existing?.displayName,
    parentToolUseId: task.toolUseId ?? existing?.parentToolUseId,
    parentAgentId:
      task.parentTaskId ?? text('parentAgentId') ?? existing?.parentAgentId,
    prompt: task.prompt ?? text('prompt') ?? existing?.prompt,
    model: text('model') ?? existing?.model,
    reasoningEffort: text('effort') ?? existing?.reasoningEffort,
    isBackgrounded: task.isBackgrounded,
    status: live ? 'started' : 'stopped',
    executionStatus,
    startedAt: task.startedAt,
    completedAt: live ? undefined : task.updatedAt,
    lastAssistantMessage: task.summary ?? existing?.lastAssistantMessage,
    lastToolName: task.lastToolName,
    usage: task.usage,
    timestamp: task.updatedAt,
  });
  if (live) result.completedAt = undefined;
  return result;
}

export function claudeVersionAtLeast(
  version: string | undefined,
  minor: number,
  patch: number,
): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, actualMinor, actualPatch] = match.slice(1).map(Number);
  return (
    major > 2 ||
    (major === 2 &&
      (actualMinor > minor || (actualMinor === minor && actualPatch >= patch)))
  );
}
