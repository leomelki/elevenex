import {
  SESSION_CHAT_TURN_TOOL_LABEL_LIMIT, SESSION_CHAT_TURN_TOOL_META_LIMIT, type SessionChatTurnTimelineRow,
} from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatMedia } from './desktop-chat-media.js';
import { chatDisplayContent, chatItem, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import { transcriptToolHeading } from './desktop-chat-tool-details.js';
import { chatItemFailed, commandExecution } from './desktop-chat-tool-outcome.js';
import { chatAgentEntry } from './desktop-chat-agent-tools.js';

function inlineResultMedia(raw: AgentTranscriptItem, cache?: ChatMediaCache) {
  const cached = cache?.get(raw);
  const media = cached ? cached.media ?? [] : chatMedia(raw, false).media;
  return media.filter(value => value.inline && value.kind !== 'file')
    .map(({ id, path, caption, inline, kind }) => ({ id, path, caption, inline, ...(kind ? { kind } : {}) }));
}

function compactLabel(title: string, toolKind: string | null): string {
  const label = title.trim() || 'Tool';
  if (label.length <= SESSION_CHAT_TURN_TOOL_LABEL_LIMIT) return label;
  return toolKind === 'read' ? '…' + label.slice(1 - SESSION_CHAT_TURN_TOOL_LABEL_LIMIT)
    : label.slice(0, SESSION_CHAT_TURN_TOOL_LABEL_LIMIT - 1) + '…';
}

/** Only saved timelines can share the turn revision and collapse paired receipts. */
export function savedTimelineRow(raw: AgentTranscriptItem, peer: AgentTranscriptItem | undefined,
  changesCache?: ChatChangesCache, mediaCache?: ChatMediaCache): SessionChatTurnTimelineRow {
  if (raw.kind !== 'tool_use' && raw.kind !== 'tool_result') return chatItem(raw, undefined, changesCache, mediaCache);

  const isCall = raw.kind === 'tool_use';
  const call = isCall ? raw : peer;
  const result = isCall ? peer : raw;
  const execution = result ? commandExecution(result, call) : commandExecution(raw);
  const resultFailed = result && chatItemFailed(result, execution);
  const failed = resultFailed || (isCall && chatItemFailed(raw));
  const media = !isCall && !failed ? inlineResultMedia(raw, mediaCache) : [];
  const agent = chatAgentEntry(raw, peer);
  if (!isCall && call && !agent?.result?.reply)
    return media.length ? { kind: 'media', id: raw.id, callId: call.id, media } : null;

  const toolKind = raw.toolKind ?? null;
  const toolName = raw.toolDisplayName ?? raw.providerToolName ?? raw.toolName ?? null;
  const heading = isCall ? transcriptToolHeading(raw, { toolKind, toolName, error: !!failed }) : undefined;
  const receiptMeta = result && transcriptToolHeading(result, {
    toolKind: result.toolKind ?? null, toolName, error: !!resultFailed, execution,
  }, call, () => chatDisplayContent(result, mediaCache)).meta;
  const meta = receiptMeta ?? heading?.meta;
  const title = heading?.summary ?? toolName ?? 'Tool result';
  const label = compactLabel(title, toolKind);
  const shortMeta = meta?.slice(0, SESSION_CHAT_TURN_TOOL_META_LIMIT);
  return {
    kind: isCall ? 'call' : 'result',
    ...(agent ? { agent } : {}),
    id: raw.id, toolKind, label,
    ...(title === label ? {} : { fullLabel: title }),
    ...(isCall && result ? { resultId: result.id } : {}),
    ...(failed ? { error: true } : {}),
    ...(shortMeta ? { meta: shortMeta } : {}),
    ...(meta !== shortMeta ? { fullMeta: meta } : {}),
    ...(media.length ? { media } : {}),
  };
}
