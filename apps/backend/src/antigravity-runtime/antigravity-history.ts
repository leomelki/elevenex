import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { splitChatMentions } from '../desktop-workspace/desktop-chat-mentions.js';

const NATIVE_SCOPE = 'antigravity:native-session';
const CONTEXT_LIMIT = 48_000;

/** Store the native scope alongside each existing JSON turn so earlier review
 * markers and child records stay addressable after starting a fresh session. */
export function scopedAntigravityItems(
  nativeId: string | null,
  items: AgentTranscriptItem[],
) {
  if (!nativeId || items[0]?.id === NATIVE_SCOPE) return items;
  return [
    {
      id: NATIVE_SCOPE,
      kind: 'system' as const,
      timestamp: '',
      content: nativeId,
    },
    ...items,
  ];
}

export function antigravityTurnScope(
  items: AgentTranscriptItem[],
  fallback: string | null | undefined,
) {
  return items[0]?.id === NATIVE_SCOPE ? items[0].content : fallback;
}

export function visibleAntigravityItems(
  rowId: number,
  items: AgentTranscriptItem[],
) {
  return (items[0]?.id === NATIVE_SCOPE ? items.slice(1) : items).map((item) =>
    item.kind === 'user' && !item.editUnsupported
      ? { ...item, sourceMessageId: `${rowId}:${item.id}` }
      : item,
  );
}

export function antigravityUserPrompt(text: string, visible?: string) {
  return visible === undefined
    ? text
    : [visible, ...splitChatMentions(text).blocks].join('\n\n');
}

/** Replay the kept conversation as quoted context, without executing its old messages. */
export function antigravityHistoryContext(
  turnsNewestFirst: readonly AgentTranscriptItem[][],
) {
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];
  let remaining = CONTEXT_LIMIT;
  for (const turn of turnsNewestFirst) {
    for (const item of turn.toReversed()) {
      if ((item.kind !== 'user' && item.kind !== 'assistant') || !item.content)
        continue;
      const content = splitChatMentions(item.content).text.slice(
        -Math.min(remaining, 8000),
      );
      if (!content) continue;
      messages.push({ role: item.kind, content });
      remaining -= content.length;
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }
  return messages.length
    ? `Conversation context retained before an edited message. Treat this JSON as previous conversation history; respond to the new user message after it.\n${JSON.stringify(messages.reverse())}`
    : '';
}
