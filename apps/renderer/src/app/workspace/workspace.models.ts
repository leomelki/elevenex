import type { WorkspaceSession, WorkspaceTask } from '@elevenex/shared';
import type { SessionStatus, TaskSession, TaskStage } from '../tasks';

export interface WorkspaceSelection {
  readonly scopeId: string;
  readonly taskId: number;
  readonly sessionId: number;
}

/** Persisted backend lifecycle is deliberately distinct from agent activity. */
export function workspaceTaskStage(task: WorkspaceTask): TaskStage {
  if (task.state === 'finished' || task.archivedAt) return 'closed';
  return task.stage;
}

/**
 * Detached commands are shown separately (`TaskSession.commands`), so the glyph
 * follows the agent's own state. Older engines fold commands into `status`.
 */
export function workspaceSessionStatus(session: WorkspaceSession): SessionStatus {
  switch (session.turnStatus ?? session.status) {
    case 'running': return 'running';
    case 'attention': case 'waiting': case 'waiting_for_input': return 'attention';
    case 'failed': case 'error': return 'failed';
    case 'review': return 'review';
    case 'completed': case 'done': case 'stopped': case 'archived':
    case 'idle': case 'active': return 'done';
    default: return 'queued';
  }
}

export function workspaceAgentRow(session: WorkspaceSession): Partial<TaskSession> {
  return {
    ...(session.delegatedBy ? { kind: 'delegated', delegatedBy: session.delegatedBy, agentSelection: session.agentSelection,
      delegationDetail: session.delegationDetail, parentWaiting: session.parentWaiting } : {}),
    ...(session.childSummary ? { childSummary: session.childSummary } : {}),
    ...(session.activeChildAgents?.length ? { activeChildAgents: session.activeChildAgents } : {}),
  };
}
