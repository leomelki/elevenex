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
  const normalizedItems = dedupeTranscriptItems(items);
  const resultsByToolUseId = new Map<string, ClaudeTranscriptItem>();
  const hiddenToolUseIds = new Set<string>();

  for (const item of normalizedItems) {
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

  for (const item of normalizedItems) {
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
  // (e.g. "msg_abc:1") differ from history IDs (e.g. "msg_abc:assistant:0").
  // Group by `${sourceMessageId-or-id-prefix}:${kind}`. Kind separates a thinking and
  // text block of the same message into different groups. The trailing block index is
  // intentionally NOT in the key: streaming uses the Anthropic content-block index,
  // but JSONL history splits each block onto its own line whose `content` array only
  // ever has length 1, so the replay index is always 0 — keying on it would make
  // streaming `msg_abc:1` and history `msg_abc:assistant:0` miss each other and
  // re-render the text after every reload. A single Anthropic message never emits two
  // text or two thinking blocks (only tool_use repeats, and tool_use isn't grouped
  // here), so collapsing same-kind items per sourceMessageId is safe.
  const groups = new Map<string, ClaudeTranscriptItem[]>();
  for (const item of normalizedItems) {
    if (item.kind !== 'assistant' && item.kind !== 'thinking') continue;
    const key = item.sourceMessageId
      ? `${item.sourceMessageId}:${item.kind}`
      : (item.id.includes(':') ? `${item.id.slice(0, item.id.indexOf(':'))}:${item.kind}` : contentGroupKey(item));
    if (!key) continue;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(item);
  }
  for (const item of normalizedItems) {
    if (item.kind !== 'assistant' && item.kind !== 'thinking') continue;
    const key = contentGroupKey(item);
    if (!key) continue;
    const sourceKey = item.sourceMessageId
      ? `${item.sourceMessageId}:${item.kind}`
      : (item.id.includes(':') ? `${item.id.slice(0, item.id.indexOf(':'))}:${item.kind}` : null);
    if (sourceKey === key) continue;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    if (!group.includes(item)) group.push(item);
  }
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const kept = group.reduce((a, b) => ((a.content?.length ?? 0) >= (b.content?.length ?? 0) ? a : b));
    for (const item of group) {
      if (item !== kept) dedupedItemIds.add(item.id);
    }
  }

  for (const item of normalizedItems) {
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
      // Empty thinking is kept so the streaming "Thinking…" indicator shows for a
      // block that was just opened (no delta yet) and so that redacted-thinking
      // signatures don't silently disappear. The view component decides whether
      // to render based on content + streaming state.
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

function dedupeTranscriptItems(items: ClaudeTranscriptItem[]): ClaudeTranscriptItem[] {
  const toolUseGroups = new Map<string, ClaudeTranscriptItem[]>();
  const toolResultGroups = new Map<string, ClaudeTranscriptItem[]>();

  for (const item of items) {
    if (item.kind === 'tool_use' && item.toolUseId) {
      let group = toolUseGroups.get(item.toolUseId);
      if (!group) {
        group = [];
        toolUseGroups.set(item.toolUseId, group);
      }
      group.push(item);
      continue;
    }

    if (item.kind === 'tool_result' && item.toolUseId) {
      let group = toolResultGroups.get(item.toolUseId);
      if (!group) {
        group = [];
        toolResultGroups.set(item.toolUseId, group);
      }
      group.push(item);
    }
  }

  const keptIds = new Set<string>();
  for (const group of toolUseGroups.values()) {
    keptIds.add(pickCanonicalToolUse(group).id);
  }
  for (const group of toolResultGroups.values()) {
    keptIds.add(pickCanonicalToolResult(group).id);
  }

  return items.filter(
    (item) =>
      (item.kind !== 'tool_use' && item.kind !== 'tool_result')
      || !item.toolUseId
      || keptIds.has(item.id),
  );
}

function contentGroupKey(item: ClaudeTranscriptItem): string | null {
  const content = item.content?.trim().replace(/\s+/g, ' ');
  return content ? `${content}:${item.kind}` : null;
}

function pickCanonicalToolUse(group: ClaudeTranscriptItem[]): ClaudeTranscriptItem {
  return group.reduce((best, candidate) => {
    const candidateScore = toolUseScore(candidate);
    const bestScore = toolUseScore(best);
    if (candidateScore !== bestScore) {
      return candidateScore > bestScore ? candidate : best;
    }
    return compareHistoryStability(candidate, best) > 0 ? candidate : best;
  });
}

function pickCanonicalToolResult(group: ClaudeTranscriptItem[]): ClaudeTranscriptItem {
  return group.reduce((best, candidate) => {
    const candidateScore = toolResultScore(candidate);
    const bestScore = toolResultScore(best);
    if (candidateScore !== bestScore) {
      return candidateScore > bestScore ? candidate : best;
    }
    return compareHistoryStability(candidate, best) > 0 ? candidate : best;
  });
}

function toolUseScore(item: ClaudeTranscriptItem): number {
  let score = 0;
  if (item.interaction) score += 8;
  if (item.sourceMessageId) score += 4;
  if (hasNonEmptyToolInput(item.toolInput)) score += 2;
  return score;
}

function toolResultScore(item: ClaudeTranscriptItem): number {
  return (item.content?.length ?? 0) * 10 + (item.sourceMessageId ? 1 : 0);
}

function hasNonEmptyToolInput(toolInput: unknown): boolean {
  if (toolInput == null) return false;
  if (typeof toolInput === 'string') return toolInput.trim().length > 0;
  if (Array.isArray(toolInput)) return toolInput.length > 0;
  if (typeof toolInput === 'object') return Object.keys(toolInput as Record<string, unknown>).length > 0;
  return true;
}

function compareHistoryStability(left: ClaudeTranscriptItem, right: ClaudeTranscriptItem): number {
  return historyStabilityScore(left.id) - historyStabilityScore(right.id);
}

function historyStabilityScore(id: string): number {
  if (id.includes(':tool_use:') || id.includes(':tool_result:')) {
    return 2;
  }
  if (id.includes(':tool:')) {
    return 1;
  }
  return 0;
}
