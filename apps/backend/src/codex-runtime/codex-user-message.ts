import { readableText, record, textValue } from './codex-subagents.js';

/** Hide the same injected context in live receipts and saved history. */
export function stripCodexWorktreeContext(text: string): string {
  const trimmed = text.trimStart();
  const openTag = '<elevenex-worktree-context>';
  const closeTag = '</elevenex-worktree-context>';
  if (!trimmed.startsWith(openTag)) return text;
  const end = trimmed.indexOf(closeTag);
  return end < 0
    ? text
    : trimmed.slice(end + closeTag.length).replace(/^\s+/, '');
}

/** App-server uses camel case; persisted native events use Pascal case. */
export function codexUserMessage(
  value: unknown,
): { id: string; text: string } | null {
  const item = record(value);
  if (item.type !== 'userMessage' && item.type !== 'UserMessage') return null;
  if (item.kind && item.kind !== 'plain') return null;
  const id = textValue(item.id);
  if (!id || !Array.isArray(item.content)) return null;
  // Image/transport payloads must never become text in the chat.
  const content = item.content
    .map((part) => textValue(record(part).text) ?? '')
    .filter(Boolean)
    .join('\n');
  const text = readableText(stripCodexWorktreeContext(content));
  return text ? { id, text } : null;
}
