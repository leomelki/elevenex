import type { SessionChatItem } from '@elevenex/shared';

const WINDOW_RECORD_LIMIT = 320;

/** A compact turn is atomic for cursors. Its reply blocks still count toward
 * the display window, keeping Markdown/media work bounded as history grows. */
export function retainChatWindow(items: readonly SessionChatItem[], keepOlder: boolean): readonly SessionChatItem[] {
  let records = 0;
  let count = 0;
  for (; count < items.length; count++) {
    const item = items[keepOlder ? count : items.length - count - 1]!;
    records += 1 + (item.completedTurn?.reply.length ?? 0);
    if (records > WINDOW_RECORD_LIMIT) break;
  }
  return keepOlder ? items.slice(0, count) : items.slice(items.length - count);
}

/** Compact the discarded edge into bounded turn context. Hidden work must not
 * evict an on-screen prompt/reply merely because it occupies many raw records.
 * These records never become cursors; following pages still fill the raw gap. */
export function chatTailContext(discarded: readonly SessionChatItem[]): readonly SessionChatItem[] {
  const turns: SessionChatItem[][] = [];
  for (const item of discarded) {
    if (item.kind === 'user' || !turns.length) turns.push([]);
    turns.at(-1)!.push(item);
  }
  const context: SessionChatItem[] = [];
  let characters = 0;
  for (const turn of turns.slice(0, 16)) {
    let end = turn.length;
    while (end > 0 && turn[end - 1]?.kind !== 'assistant') end--;
    let start = end;
    while (start > 0 && turn[start - 1]?.kind === 'assistant') start--;
    const outcome = turn.filter(item => item.changes).at(-1);
    const media = turn.filter(item => item.kind === 'tool_result' && item.media?.some(media => media.inline));
    const retained = new Set([
      ...(turn[0]?.kind === 'user' ? [turn[0]] : []),
      // Preserve the source boundary: without it a progress message at the
      // raw edge would merge into the retained answer and change its DOM key.
      ...(start > 0 ? [turn[start - 1]!] : []),
      ...turn.slice(start, end), ...media.slice(-8), ...(outcome ? [outcome] : []),
    ]);
    const records = turn.filter(item => retained.has(item));
    const size = records.reduce((total, item) => total + item.text.length + item.input.length +
      (item.completedTurn?.reply.reduce((sum, row) => sum + row.text.length + row.input.length, 0) ?? 0), 0);
    // Keep whole nearest turns. The farther tail stays reachable through next,
    // without an unbounded transcript cache or attaching replies to wrong users.
    if (context.length + records.length > 80 || characters + size > 256000) break;
    context.push(...records);
    characters += size;
  }
  return context;
}
