import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { record, textValue } from './codex-subagents.js';

/** Codex writes native items when they complete. The start times describe
 * where their prose and tool calls appeared, including before a later steer
 * or commentary. Keep file order between turns and on equal timestamps. */
export function orderCodexHistory(
  records: readonly Record<string, unknown>[], items: readonly ClaudeTranscriptItem[],
): ClaudeTranscriptItem[] {
  const starts = new Map<string, number>();
  const timedTurns = new Set<number>();
  const turns: number[] = [];
  let turnId: string | undefined;
  let turn = 0;
  for (const [index, entry] of records.entries()) {
    const payload = record(entry.payload);
    const id = textValue(payload.turn_id ?? payload.turnId);
    if (id && id !== turnId && (entry.type === 'turn_context' || payload.type === 'task_started')) {
      turnId = id;
      turn++;
    }
    turns[index] = turn;
    if (entry.type !== 'event_msg' || payload.type !== 'item_completed') continue;
    const itemId = textValue(record(payload.item).id);
    const startedAt = payload.started_at_ms;
    if (itemId && typeof startedAt === 'number' && Number.isFinite(startedAt)) {
      starts.set(itemId, starts.get(itemId) ?? startedAt);
      timedTurns.add(turn);
    }
  }
  const unique = new Map<string, { item: ClaudeTranscriptItem; turn: number; at: number }>();
  for (const item of items) {
    const previous = unique.get(item.id);
    const index = Number(item.transcriptMessageId?.slice('codex-record:'.length));
    const start = item.kind === 'tool_result' ? undefined : starts.get(item.sourceMessageId ?? item.id);
    unique.set(item.id, {
      item, turn: previous?.turn ?? turns[index] ?? 0, at: previous?.at ?? start ?? Date.parse(item.timestamp),
    });
  }
  const ordered = [...unique.values()];
  if (starts.size)
    ordered.sort((a, b) => a.turn - b.turn || (timedTurns.has(a.turn) ? a.at - b.at : 0));
  return ordered.map(({ item }) => item);
}
