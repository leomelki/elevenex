import { createHash } from 'node:crypto';
import {
  SESSION_CHAT_FULL_TIMELINE_BYTES,
  SESSION_CHAT_FULL_TIMELINE_SLOTS,
  SESSION_CHAT_TURN_FILES_LIMIT,
  SESSION_CHAT_TURN_REPLY_LIMIT,
  SESSION_CHAT_TURN_WORK_BATCH_BYTES,
  SESSION_CHAT_TURN_WORK_LIMIT,
  SESSION_CHAT_TURN_TIMELINE_BYTES,
  SESSION_CHAT_TURN_TIMELINE_SLOTS,
  sessionChatToolCategory,
  sessionChatToolStatus,
  type SessionChatCompletedTurn,
  type SessionChatItem,
  type SessionChatRecord,
  type SessionChatToolCategory,
  type SessionChatTurnTimelineRow,
} from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { changeSummary, summarizeTurnChanges } from './desktop-chat-changes.js';
import { chatItem, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import { chatItemFailed, commandExecution } from './desktop-chat-tool-outcome.js';
import type { ChatToolDetails, ProjectChatTool } from './desktop-chat-tool-details.js';
import { ChatToolLinks } from './desktop-chat-tool-links.js';
import { savedTimelineRow } from './desktop-chat-turn-timeline.js';
import { chatAgentEntry } from './desktop-chat-agent-tools.js';

const RECENT_RECORDS = 32;
const INLINE_RECORDS = 8;
const INLINE_BYTES = 8 * 1024;
const REPLY_BYTES = 128 * 1024;
const WORK_PAGE_BYTES = 384 * 1024;

function captureMarker(item: AgentTranscriptItem): boolean {
  return item.kind === 'system' && !!item.turnChanges && !item.content?.trim() && !item.agentMessage?.body;
}

/** Projects complete saved turns. The feed owns these weak fingerprints for one history revision. */
export class ChatCompletedTurns {
  private readonly digests = new WeakMap<AgentTranscriptItem, Buffer>();

  constructor(private readonly changesCache?: ChatChangesCache, private readonly mediaCache?: ChatMediaCache) {}

  private project(item: AgentTranscriptItem, call?: AgentTranscriptItem) {
    return chatItem(item, call, this.changesCache, this.mediaCache);
  }

  /** Hash the data that can affect a work page, without assembling its display payload.
   * Hash large strings directly. Images and original tool content stay on the engine. */
  private digest(item: AgentTranscriptItem): Buffer {
    const cached = this.digests.get(item);
    if (cached) return cached;
    const hash = createHash('sha256');
    for (const value of [
      item.id, item.kind, item.assistantPhase, item.timestamp, item.toolUseId, item.toolKind,
      item.toolDisplayName, item.providerToolName, item.toolName, item.isError,
      item.content, item.toolInput, item.providerToolResult, item.nativeTask, item.agentMessage?.body,
      changeSummary(item.turnChanges),
    ]) {
      const encoded = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      hash.update(typeof value === 'string' ? `s${encoded.length}:` : `j${encoded.length}:`);
      hash.update(encoded, 'utf16le');
    }
    for (const image of item.images ?? []) {
      hash.update(`${image.mediaType}:${image.data.length}:`);
      hash.update(image.data);
    }
    const digest = hash.digest();
    this.digests.set(item, digest);
    return digest;
  }

  private revision(items: readonly AgentTranscriptItem[]): string {
    const hash = createHash('sha256');
    // The reply span determines the hidden activity offsets.
    hash.update('desktop-turn-reply-v2');
    for (const item of items) hash.update(this.digest(item));
    return hash.digest('hex');
  }

  private reply(items: readonly AgentTranscriptItem[], links: ChatToolLinks) {
    let end = items.length;
    let progress = 0;
    while (end > 1) {
      const item = items[end - 1];
      if (item.kind === 'assistant') {
        const projected = this.project(item);
        if (projected.text.trim() || (!projected.error && projected.media?.some(media => media.inline))) {
          if (item.assistantPhase !== 'commentary') break;
          progress ||= end;
        }
      }
      end--;
    }
    // Interrupted or failed runs may have only commentary. Keep the latest
    // visible prose when there is no final reply to represent the turn.
    if (end <= 1 && progress) end = progress;
    let start = end;
    const phase = items[end - 1]?.assistantPhase;
    let blocks = 0;
    for (let index = end - 1; index > 0; index--) {
      const item = items[index];
      if (item.kind === 'assistant' && item.assistantPhase === phase) {
        start = index;
        if (++blocks > SESSION_CHAT_TURN_REPLY_LIMIT) return null;
      } else {
        const call = item.kind === 'tool_result' ? links.peer(item) : undefined;
        if (!call) break;
        const result = this.project(item, call);
        if (!result.error && result.media?.some(media => media.inline && media.kind !== 'file')) break;
      }
    }
    const records = items.slice(start, end).filter(item => item.kind === 'assistant').map(item => this.project(item));
    if (Buffer.byteLength(JSON.stringify(records)) > REPLY_BYTES) return null;
    return { start, end, records };
  }

  private prepare(items: readonly AgentTranscriptItem[]) {
    // Provider history can contain successive receipts for the same row.
    // The ordinary history window keeps its first position and latest value.
    const rows = [...new Map(items.map(item => [item.id, item])).values()];
    const links = new ChatToolLinks(rows);
    const reply = this.reply(rows, links);
    if (!reply) return null;
    const hidden = rows.slice(1).filter((item, index) =>
      (item.kind !== 'assistant' || index + 1 < reply.start || index + 1 >= reply.end) && !captureMarker(item));
    if (!hidden.length) return null;
    return { rows, reply, hidden, links };
  }

  summarize(
    history: readonly AgentTranscriptItem[], start: number, end: number,
    liveIds: ReadonlySet<string>, projectTool?: ProjectChatTool, summarizeRecent = false,
  ): SessionChatItem | undefined {
    if (end - start < 2) return undefined;
    const items = history.slice(start, end);
    // A later live receipt can replace any record still in the runtime overlay.
    if (items.some(item => liveIds.has(item.id))) return undefined;
    const prepared = this.prepare(items);
    if (!prepared) return undefined;
    const { rows, reply, hidden, links } = prepared;
    if (!summarizeRecent && start >= history.length - RECENT_RECORDS && rows.length <= INLINE_RECORDS) {
      const bytes = Buffer.byteLength(JSON.stringify(rows.map(item => {
        const call = item.kind === 'tool_result' ? links.peer(item) : undefined;
        return projectTool?.(item, call) ?? this.project(item, call);
      })));
      if (bytes <= INLINE_BYTES) return undefined;
    }
    const counts: Partial<Record<SessionChatToolCategory, number>> = {};
    const agents: NonNullable<SessionChatCompletedTurn['agents']>[number][] = [];
    let failures = 0;
    let ended = -Infinity;
    let beforeReply = 0;
    for (let index = 1; index < rows.length; index++) {
      const item = rows[index];
      const at = Date.parse(item.timestamp);
      if (Number.isFinite(at)) ended = Math.max(ended, at);
      if (captureMarker(item) || (item.kind === 'assistant' && index >= reply.start && index < reply.end)) continue;
      if (index < reply.start) beforeReply++;
      const peer = links.peer(item);
      if (item.kind === 'tool_result' && peer) continue;
      if (agents.length < 16 && (item.kind === 'tool_use' || item.nativeTask)) {
        const entry = chatAgentEntry(item, peer);
        if (entry && ['launch', 'native', 'wait', 'native-wait', 'message', 'stop'].includes(entry.operation.type)) agents.push(entry);
      }
      const error = item.kind === 'error' || chatItemFailed(item);
      const category = item.kind === 'tool_use' ? sessionChatToolCategory(item.toolKind)
        : item.kind === 'tool_result' || item.kind === 'error' ? 'tool' : undefined;
      if (category) counts[category] = (counts[category] ?? 0) + 1;
      if (item.kind === 'tool_use'
        ? sessionChatToolStatus(error, peer && chatItemFailed(peer, commandExecution(peer, item)), false) === 'failed'
        : error) failures++;
    }
    const outcome = summarizeTurnChanges(rows, SESSION_CHAT_TURN_FILES_LIMIT);
    const started = Date.parse(rows[0].timestamp);
    return {
      ...this.project(rows[0]),
      completedTurn: {
        revision: this.revision(rows),
        endId: items.at(-1)!.id,
        reply: reply.records,
        ...(agents.length ? { agents } : {}),
        beforeReply,
        total: hidden.length,
        counts,
        failures,
        ...(Number.isFinite(started) && Number.isFinite(ended) ? { duration: Math.max(0, (ended - started) / 1000) } : {}),
        ...(outcome ? { changes: outcome } : {}),
      } satisfies SessionChatCompletedTurn,
    };
  }

  page(turn: readonly AgentTranscriptItem[], revision: string, offset: number, toolDetails?: ChatToolDetails,
    limit = SESSION_CHAT_TURN_WORK_LIMIT) {
    const prepared = this.prepare(turn);
    if (!prepared || offset >= prepared.hidden.length || this.revision(prepared.rows) !== revision) return null;
    const { hidden, links } = prepared;
    const toolPage = toolDetails?.projectPage();
    const byteLimit = limit > SESSION_CHAT_TURN_WORK_LIMIT ? SESSION_CHAT_TURN_WORK_BATCH_BYTES : WORK_PAGE_BYTES;
    const items: SessionChatRecord[] = [];
    let bytes = 0;
    for (const raw of hidden.slice(offset, offset + limit)) {
      const peer = links.peer(raw);
      const call = raw.kind === 'tool_result' ? peer : undefined;
      const result = raw.kind === 'tool_use' ? peer : undefined;
      const agent = result && !toolPage ? chatAgentEntry(raw, result) : undefined;
      const item = toolPage?.activity(raw, peer) ?? {
        ...this.project(raw, call),
        ...(agent ? { agent } : {}),
        ...(result ? { receipt: { id: result.id, error: chatItemFailed(result, commandExecution(result, raw)) } } : {}),
      };
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > byteLimit) break;
      items.push(item);
    }
    if (!items.length) return null;
    toolPage?.commit();
    const next = offset + items.length;
    return { items, nextOffset: next < hidden.length ? next : null, total: hidden.length };
  }

  timeline(turn: readonly AgentTranscriptItem[], revision: string, offset: number, complete = false) {
    const prepared = this.prepare(turn);
    if (!prepared || offset >= prepared.hidden.length || this.revision(prepared.rows) !== revision) return null;
    const { hidden, links } = prepared;
    const timeline: SessionChatTurnTimelineRow[] = [];
    let bytes = 2;
    const slotLimit = complete ? SESSION_CHAT_FULL_TIMELINE_SLOTS : SESSION_CHAT_TURN_TIMELINE_SLOTS;
    // Reserve space for the response envelope inside the desktop's transport limit.
    const byteLimit = complete ? SESSION_CHAT_FULL_TIMELINE_BYTES - 16 * 1024 : SESSION_CHAT_TURN_TIMELINE_BYTES;
    const end = Math.min(hidden.length, offset + slotLimit);
    for (let position = offset; position < end; position++) {
      const raw = hidden[position];
      const row = savedTimelineRow(raw, links.peer(raw), this.changesCache, this.mediaCache);
      bytes += Buffer.byteLength(JSON.stringify(row)) + Number(timeline.length > 0);
      if (bytes > byteLimit) break;
      timeline.push(row);
    }
    if (!timeline.length) return null;
    const next = offset + timeline.length;
    return { timeline, nextOffset: next < hidden.length ? next : null, total: hidden.length };
  }

  timelineTool(turn: readonly AgentTranscriptItem[], revision: string, itemId: string) {
    const prepared = this.prepare(turn);
    if (!prepared || this.revision(prepared.rows) !== revision) return;
    const item = prepared.hidden.find(row => row.id === itemId);
    if (item?.kind === 'tool_use') return { item, result: prepared.links.peer(item) };
    if (item?.kind === 'tool_result' && !prepared.links.peer(item)) return { item };
  }
}

export function endOfChatTurn(history: readonly AgentTranscriptItem[], start: number): number {
  for (let index = start + 1; index < history.length; index++)
    if (history[index].kind === 'user') return index;
  return history.length;
}
