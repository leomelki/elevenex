import {
  hasStartedAgentConversation,
  type SessionProviderColumns,
} from '../sessions/session-provider.js';

export interface WorkspaceSessionActivity extends SessionProviderColumns {
  readonly id: number;
  readonly activeAgentProvider: string;
  readonly status: string;
  readonly hasUnreviewedCompletion: boolean;
  readonly lastCompletionAt: string | null;
}

/** Lifecycle/identity survives restarts; a missing completion is not a queue. */
export function inactiveSessionStatus(
  session: WorkspaceSessionActivity,
): string {
  if (session.status === 'archived') return 'archived';
  // Viewing acknowledges a specific completion version. An orphaned legacy
  // flag with no version must not produce a dot that can never be cleared.
  if (session.hasUnreviewedCompletion && session.lastCompletionAt) return 'review';
  if (
    session.lastCompletionAt ||
    session.hasUnreviewedCompletion ||
    session.status === 'stopped' ||
    session.status === 'active' ||
    hasStartedAgentConversation(session)
  )
    return 'done';
  return 'queued';
}
