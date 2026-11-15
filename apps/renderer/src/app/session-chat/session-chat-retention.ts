import type { SessionChatItem } from '@elevenex/shared';

/** Fetch, retention and rendering are independent budgets. Never size the DOM by this limit. */
export const CHAT_HISTORY_BATCH = 2000;
export const CHAT_RETAINED_ITEMS = 8000;
export const CHAT_RETAINED_BYTES = 16 * 1024 * 1024;
const sizes = new WeakMap<SessionChatItem, number>();

/** Conservative UTF-16 serialized size, cached by immutable item identity. */
export function chatItemBytes(item: SessionChatItem): number {
  let bytes = sizes.get(item);
  if (bytes === undefined) {
    bytes = JSON.stringify(item).length * 2;
    sizes.set(item, bytes);
  }
  return bytes;
}

export function retainChatItems(items: readonly SessionChatItem[], older: boolean): readonly SessionChatItem[] {
  let bytes = 0, count = 0;
  while (count < Math.min(items.length, CHAT_RETAINED_ITEMS)) {
    const item = items[older ? count : items.length - count - 1]!;
    const size = chatItemBytes(item);
    if (count && bytes + size > CHAT_RETAINED_BYTES) break;
    bytes += size;
    count++;
  }
  return count === items.length ? items : older ? items.slice(0, count) : items.slice(-count);
}
