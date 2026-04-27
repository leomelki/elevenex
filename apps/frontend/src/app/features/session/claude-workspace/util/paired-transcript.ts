import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { shouldHideToolCall } from './tool-format';

export type PairedTranscriptUnit =
  | { kind: 'message'; id: string; item: ClaudeTranscriptItem }
  | { kind: 'thinking'; id: string; item: ClaudeTranscriptItem }
  | { kind: 'system'; id: string; item: ClaudeTranscriptItem }
  | {
      kind: 'tool';
      id: string;
      call: ClaudeTranscriptItem;
      result: ClaudeTranscriptItem | null;
      toolUseId: string;
    };

export function pairTranscript(items: ClaudeTranscriptItem[]): PairedTranscriptUnit[] {
  const resultsByToolUseId = new Map<string, ClaudeTranscriptItem>();
  const hiddenToolUseIds = new Set<string>();

  for (const item of items) {
    if (item.kind === 'system' && !item.content?.trim()) {
      continue;
    }

    if (item.kind === 'tool_use') {
      const toolUseId = item.toolUseId || item.id;
      if (shouldHideToolCall(item.toolName, item.toolInput)) {
        hiddenToolUseIds.add(toolUseId);
      }
    }
  }

  for (const item of items) {
    if (item.kind === 'tool_result' && item.toolUseId) {
      if (hiddenToolUseIds.has(item.toolUseId)) {
        continue;
      }
      resultsByToolUseId.set(item.toolUseId, item);
    }
  }

  const out: PairedTranscriptUnit[] = [];
  const seenToolUseIds = new Set<string>();
  const dedupedItemIds = new Set<string>();

  // Deduplicate assistant/thinking messages that appear twice because streaming IDs
  // (e.g. "msg_abc:0") differ from history IDs (e.g. "msg_abc:assistant:0").
  // Group by sourceMessageId when available, then by UUID prefix + kind as fallback.
  const groups = new Map<string, ClaudeTranscriptItem[]>();
  for (const item of items) {
    if (item.kind !== 'assistant' && item.kind !== 'thinking') continue;
    const key = item.sourceMessageId
      ?? (item.id.includes(':') ? `${item.id.slice(0, item.id.indexOf(':'))}:${item.kind}` : null);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(item);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const kept = group.reduce((a, b) => ((a.content?.length ?? 0) >= (b.content?.length ?? 0) ? a : b));
    for (const item of group) {
      if (item !== kept) dedupedItemIds.add(item.id);
    }
  }

  for (const item of items) {
    if (dedupedItemIds.has(item.id)) continue;
    if (item.kind === 'system' && !item.content?.trim()) continue;

    if (item.kind === 'tool_use') {
      const toolUseId = item.toolUseId || item.id;
      if (hiddenToolUseIds.has(toolUseId)) {
        continue;
      }
      seenToolUseIds.add(toolUseId);
      out.push({
        kind: 'tool',
        id: item.id,
        call: item,
        result: resultsByToolUseId.get(toolUseId) ?? null,
        toolUseId,
      });
      continue;
    }
    if (item.kind === 'tool_result') {
      const toolUseId = item.toolUseId;
      if (toolUseId && hiddenToolUseIds.has(toolUseId)) {
        continue;
      }
      if (toolUseId && seenToolUseIds.has(toolUseId)) {
        continue; // already paired
      }
      // orphan result — render as a tool card with no call
      if (shouldHideToolCall(item.toolName, item.toolInput)) {
        continue;
      }
      out.push({
        kind: 'tool',
        id: item.id,
        call: { ...item, kind: 'tool_use', toolName: item.toolName || 'result' },
        result: item,
        toolUseId: toolUseId || item.id,
      });
      continue;
    }
    if (item.kind === 'thinking') {
      if (!item.content?.trim()) {
        continue;
      }
      out.push({ kind: 'thinking', id: item.id, item });
      continue;
    }
    if (item.kind === 'assistant' && !item.content?.trim()) {
      continue;
    }
    if (item.kind === 'user' || item.kind === 'assistant') {
      out.push({ kind: 'message', id: item.id, item });
      continue;
    }
    out.push({ kind: 'system', id: item.id, item });
  }

  return out;
}
