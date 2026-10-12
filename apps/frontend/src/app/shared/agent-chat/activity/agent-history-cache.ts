import type { AgentSubagentHistoryPayload } from '@/shared/models/agent-runtime.model';

/** Keep older pages while refreshing the tail, without duplicate messages. */
export function mergeAgentHistory(
  previous: AgentSubagentHistoryPayload | null,
  next: AgentSubagentHistoryPayload,
  earlier = false,
): AgentSubagentHistoryPayload {
  if (!previous || (!next.transcriptAvailable && !previous.history.length)) return next;
  const items = new Map(previous.history.map((item) => [item.id, item]));
  for (const item of next.history) items.set(item.id, item);
  return {
    ...next,
    history: [...items.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    transcriptAvailable: next.transcriptAvailable || previous.transcriptAvailable,
    hasEarlier: earlier ? next.hasEarlier : (previous.hasEarlier ?? next.hasEarlier),
  };
}

/** Evict unselected settled histories; navigation must not retain every large chat. */
export function boundAgentHistories<T extends { loading: boolean }>(
  histories: Record<string, T>,
  selected: string,
  maximum = 12,
): Record<string, T> {
  const entries = Object.entries(histories);
  let remove = entries.length - maximum;
  return Object.fromEntries(
    entries.filter(([id, state]) => id === selected || state.loading || remove-- <= 0),
  );
}
