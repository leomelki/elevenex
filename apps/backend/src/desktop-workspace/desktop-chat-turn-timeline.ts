import {
  SESSION_CHAT_TURN_TOOL_LABEL_LIMIT,
  SESSION_CHAT_TURN_TOOL_META_LIMIT,
  sessionChatToolHeading,
  type SessionChatTurnTimelineRow,
} from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatMedia } from './desktop-chat-media.js';
import { chatItem, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import { chatItemFailed, commandExecution } from './desktop-chat-tool-outcome.js';

function headingInput(input: AgentTranscriptItem['toolInput']): unknown {
  if (typeof input !== 'string') return input;
  const preview = input.slice(0, 16_000);
  if (!/^\s*[{[]/.test(preview)) return preview;
  if (input.length !== preview.length) return undefined;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function inlineResultMedia(raw: AgentTranscriptItem, cache?: ChatMediaCache) {
  const cached = cache?.get(raw);
  const media = cached ? cached.media ?? [] : chatMedia(raw, false).media;
  return media.filter(value => value.inline && value.kind !== 'file')
    .map(({ id, path, caption, inline, kind }) => ({ id, path, caption, inline, ...(kind ? { kind } : {}) }));
}

/** Only saved timelines can share the turn revision and collapse paired receipts. */
export function savedTimelineRow(raw: AgentTranscriptItem, peer: AgentTranscriptItem | undefined,
  changesCache?: ChatChangesCache, mediaCache?: ChatMediaCache): SessionChatTurnTimelineRow {
  if (raw.kind !== 'tool_use' && raw.kind !== 'tool_result') return chatItem(raw, undefined, changesCache, mediaCache);

  const call = raw.kind === 'tool_use' ? raw : peer;
  const result = raw.kind === 'tool_result' ? raw : peer;
  const execution = result ? commandExecution(result, call) : commandExecution(raw);
  const failed = chatItemFailed(raw, raw.kind === 'tool_use' ? commandExecution(raw) : execution) ||
    !!(result && chatItemFailed(result, execution));
  const media = raw.kind === 'tool_result' && !failed ? inlineResultMedia(raw, mediaCache) : [];
  if (raw.kind === 'tool_result' && call)
    return media.length ? { kind: 'media', id: raw.id, callId: call.id, media } : null;

  const toolKind = raw.toolKind ?? null;
  const toolName = raw.toolDisplayName ?? raw.providerToolName ?? raw.toolName ?? (call ? null : 'Tool result');
  const outputText = result?.content ?? result?.providerToolResult;
  const exitPreview = toolKind === 'bash' && typeof outputText === 'string' ? outputText.slice(-16_000) : '';
  const heading = sessionChatToolHeading({ toolKind, toolName }, headingInput(raw.toolInput),
    result ? { text: exitPreview, error: failed, execution, truncated: false } : undefined);
  const title = heading.summary.trim() || 'Tool';
  const label = title.length <= SESSION_CHAT_TURN_TOOL_LABEL_LIMIT ? title : toolKind === 'read'
    ? '…' + title.slice(1 - SESSION_CHAT_TURN_TOOL_LABEL_LIMIT)
    : title.slice(0, SESSION_CHAT_TURN_TOOL_LABEL_LIMIT - 1) + '…';
  return {
    kind: raw.kind === 'tool_use' ? 'call' : 'result',
    id: raw.id, toolKind, label,
    ...(raw.kind === 'tool_use' && result ? { resultId: result.id } : {}),
    ...(failed ? { error: true } : {}),
    ...(heading.meta ? { meta: heading.meta.slice(0, SESSION_CHAT_TURN_TOOL_META_LIMIT) } : {}),
    ...(media.length ? { media } : {}),
  };
}
