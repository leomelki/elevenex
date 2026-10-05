import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';

/**
 * Older Codex recordings omit the runtime message id. Match those recordings
 * against live copies within the same user turn, consuming each copy once.
 * Ordinary messages retain their provider identity regardless of repeated text.
 */
export function reconcileHistoryIdentities(
  history: AgentTranscriptItem[],
  live: AgentTranscriptItem[],
): AgentTranscriptItem[] {
  const available = new Set(
    live.filter((item) => item.kind === 'assistant' || item.kind === 'thinking'),
  );
  let turnStart = '';
  const nextUser = new Array<string | null>(history.length);
  let boundary: string | null = null;
  for (let index = history.length - 1; index >= 0; index--) {
    nextUser[index] = boundary;
    if (history[index].kind === 'user' && !history[index].parentToolUseId)
      boundary = history[index].timestamp;
  }
  return history.map((item, index) => {
    if (item.kind === 'user' && !item.parentToolUseId) turnStart = item.timestamp;
    if (
      !item.sourceMessageId?.startsWith('codex-history:') ||
      !item.transcriptMessageId?.startsWith('codex-record:')
    )
      return item;
    const match = [...available].find(
      (candidate) =>
        candidate.kind === item.kind &&
        candidate.parentToolUseId === item.parentToolUseId &&
        candidate.content?.trim() === item.content?.trim() &&
        candidate.timestamp >= turnStart &&
        (!nextUser[index] || candidate.timestamp < nextUser[index]!),
    );
    if (!match) return item;
    available.delete(match);
    return { ...item, sourceMessageId: match.sourceMessageId ?? match.id };
  });
}
