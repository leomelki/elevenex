import type { WorkspaceSession, WorkspaceTask } from '@elevenex/shared';
import type { SessionStatus, TaskStage } from '../tasks';

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

export function workspaceSessionStatus(session: WorkspaceSession): SessionStatus {
  switch (session.status) {
    case 'running': return 'running';
    case 'attention': case 'waiting': case 'waiting_for_input': return 'attention';
    case 'failed': case 'error': return 'failed';
    case 'review': return 'review';
    case 'completed': case 'done': case 'stopped': case 'archived': return 'done';
    default: return 'queued';
  }
}
