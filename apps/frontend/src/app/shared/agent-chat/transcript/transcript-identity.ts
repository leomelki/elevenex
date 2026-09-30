import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

export function transcriptSourceKey(item: AgentTranscriptItem): string {
  const source =
    item.sourceMessageId ??
    (item.kind === 'assistant' || item.kind === 'thinking'
      ? item.id.replace(/:(?:(?:assistant|thinking|text):)?\d+$/, '')
      : item.id);
  return JSON.stringify([item.parentToolUseId ?? '', source, item.kind]);
}

/** A provider message may contain several blocks of the same kind. */
export function transcriptItemKey(item: AgentTranscriptItem): string {
  if (item.toolUseId)
    return JSON.stringify([item.parentToolUseId ?? '', item.toolUseId, item.kind]);
  const block =
    item.kind === 'assistant' || item.kind === 'thinking'
      ? (/:(?:(?:assistant|thinking|text):)?(\d+)$/.exec(item.id)?.[1] ?? '')
      : '';
  return `${transcriptSourceKey(item)}:${block}`;
}

/**
 * Split Claude recordings can reset a block's index to zero. Only fall back
 * to message identity when there is exactly one block of that kind on each
 * side; otherwise preserve all blocks.
 */
export function persistedLiveItems(
  history: AgentTranscriptItem[],
  live: AgentTranscriptItem[],
): Map<string, AgentTranscriptItem> {
  const saved = new Map(history.map((item) => [transcriptItemKey(item), item]));
  const historyGroups = groupBySource(history);
  const liveGroups = groupBySource(live);
  for (const [source, items] of liveGroups) {
    const candidates = historyGroups.get(source);
    if (items.length !== 1 || candidates?.length !== 1) continue;
    const item = items[0];
    const liveContent = item.content?.trim();
    const savedContent = candidates[0].content?.trim();
    if (
      (item.kind === 'assistant' || item.kind === 'thinking') &&
      liveContent &&
      savedContent &&
      (liveContent.startsWith(savedContent) || savedContent.startsWith(liveContent))
    )
      saved.set(transcriptItemKey(item), candidates[0]);
  }
  return saved;
}

function groupBySource(items: AgentTranscriptItem[]): Map<string, AgentTranscriptItem[]> {
  const groups = new Map<string, AgentTranscriptItem[]>();
  for (const item of items) {
    const key = transcriptSourceKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
