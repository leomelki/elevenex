import type { SessionChatItem } from "@elevenex/shared";

interface ClaudeBlock {
  readonly item: SessionChatItem;
  readonly position: number;
  readonly index: string;
}

const claudeBlockId = /^(msg_[^:]+):(?:(assistant|thinking):)?(\d+)$/;

/** Claude live IDs use wire indexes; saved split messages can reset those indexes. */
export function reconcileClaudeBlocks(items: readonly SessionChatItem[]): {
  readonly items: readonly SessionChatItem[];
  readonly renderIds: ReadonlyMap<string, string>;
} {
  const groups = new Map<string, { streamed: ClaudeBlock[]; saved: ClaudeBlock[] }>();
  items.forEach((item, position) => {
    if (item.kind !== "assistant" && item.kind !== "thinking") return;
    const match = claudeBlockId.exec(item.id);
    if (!match || (match[2] && match[2] !== item.kind)) return;
    const key = `${match[1]}:${item.kind}`;
    const group = groups.get(key) ?? { streamed: [], saved: [] };
    const blocks = match[2] ? group.saved : group.streamed;
    blocks.push({ item, position, index: match[3]! });
    groups.set(key, group);
  });

  const removed = new Set<number>();
  const replacements = new Map<number, SessionChatItem>();
  const renderIds = new Map<string, string>();
  for (const { streamed, saved } of groups.values()) {
    if (!streamed.length || !saved.length) continue;
    const available = new Set(saved);
    const merge = (live: ClaudeBlock, durable: ClaudeBlock) => {
      const earlier = live.position < durable.position ? live : durable;
      replacements.set(earlier.position, durable.item);
      removed.add(Math.max(live.position, durable.position));
      renderIds.set(durable.item.id, earlier.item.id);
      available.delete(durable);
    };

    // Match exact text at the same index first so repeated blocks count once
    // per receipt. Then allow a changed index for text unique on both sides.
    const unmatched = streamed.filter(live => {
      const durable = saved.find(block => available.has(block) &&
        block.index === live.index && block.item.text === live.item.text,
      );
      if (!durable) return true;
      merge(live, durable);
      return false;
    });
    for (const live of unmatched) {
      const text = live.item.text.trim();
      if (!text || live.item.truncated || unmatched.some(
        block => block !== live && block.item.text.trim() === text,
      )) continue;
      const matches = [...available].filter(
        block => !block.item.truncated && block.item.text.trim() === text,
      );
      if (matches.length === 1) merge(live, matches[0]!);
    }

    // A saved block can complete a partial stream. Require a single block of
    // this kind on each side so a shifted index cannot swallow another reply.
    if (unmatched.length === 1 && streamed.length === 1 && saved.length === 1) {
      const live = unmatched[0]!, durable = saved[0]!;
      const text = live.item.text.trim(), savedText = durable.item.text.trim();
      if (available.has(durable) && (savedText === text ||
        (!live.item.truncated && savedText.startsWith(text)))) merge(live, durable);
    }
  }
  return {
    items: removed.size
      ? items.flatMap((item, index) => removed.has(index) ? [] : [replacements.get(index) ?? item])
      : items,
    renderIds,
  };
}
