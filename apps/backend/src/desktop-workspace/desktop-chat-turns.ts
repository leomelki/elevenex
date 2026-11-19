import { createHash } from 'node:crypto';
import {
  SESSION_CHAT_TURN_FILES_LIMIT,
  SESSION_CHAT_TURN_REPLY_LIMIT,
  SESSION_CHAT_TURN_WORK_LIMIT,
  sessionChatToolCategory,
  type SessionChatCompletedTurn,
  type SessionChatItem,
  type SessionChatRecord,
  type SessionChatToolCategory,
} from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { capturedChangeSummary, changeSummary } from './desktop-chat-changes.js';
import { chatItem, chatItemChanges, chatItemFailed, commandExecution, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';
import { toolKey, type ChatToolDetails } from './desktop-chat-tool-details.js';

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
      item.id, item.kind, item.timestamp, item.toolUseId, item.toolKind,
      item.toolDisplayName, item.providerToolName, item.toolName, item.isError,
      item.content, item.toolInput, item.providerToolResult, item.agentMessage?.body,
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
    for (const item of items) hash.update(this.digest(item));
    return hash.digest('hex');
  }

  private reply(items: readonly AgentTranscriptItem[]) {
    let end = items.length;
    while (end > 1) {
      const item = items[end - 1];
      if (item.kind === 'assistant') {
        const projected = this.project(item);
        if (projected.text.trim() || (!projected.error && projected.media?.some(media => media.inline))) break;
      }
      end--;
    }
    let start = end;
    while (start > 1 && items[start - 1].kind === 'assistant') {
      start--;
      if (end - start > SESSION_CHAT_TURN_REPLY_LIMIT) return null;
    }
    const records = items.slice(start, end).map(item => this.project(item));
    if (Buffer.byteLength(JSON.stringify(records)) > REPLY_BYTES) return null;
    return { start, end, records };
  }

  private prepare(items: readonly AgentTranscriptItem[]) {
    const reply = this.reply(items);
    if (!reply) return null;
    const hidden = items.slice(1).filter((item, index) =>
      (index + 1 < reply.start || index + 1 >= reply.end) && !captureMarker(item));
    if (!hidden.length) return null;
    const calls = new Map<string, AgentTranscriptItem>();
    const results = new Map<string, AgentTranscriptItem>();
    for (const item of hidden) {
      if (item.kind === 'tool_use') calls.set(toolKey(item), item);
      else if (item.kind === 'tool_result') results.set(toolKey(item), item);
    }
    return { reply, hidden, calls, results };
  }

  summarize(
    history: readonly AgentTranscriptItem[], start: number, end: number,
    liveIds: ReadonlySet<string>,
  ): SessionChatItem | undefined {
    if (end - start < 2) return undefined;
    const items = history.slice(start, end);
    // A later live receipt can replace any record still in the runtime overlay.
    if (items.some(item => liveIds.has(item.id))) return undefined;
    const prepared = this.prepare(items);
    if (!prepared) return undefined;
    const { reply, hidden, calls } = prepared;
    if (start >= history.length - RECENT_RECORDS && items.length <= INLINE_RECORDS) {
      const bytes = Buffer.byteLength(JSON.stringify(items.map(item =>
        this.project(item, item.kind === 'tool_result' ? calls.get(toolKey(item)) : undefined))));
      if (bytes <= INLINE_BYTES) return undefined;
    }
    const counts: Partial<Record<SessionChatToolCategory, number>> = {};
    const failed = new Set<string>();
    const changes = new Map<string, NonNullable<SessionChatCompletedTurn['changes']>['files'][number]>();
    const edits: ReturnType<typeof chatItemChanges>[] = [];
    let captured: AgentTranscriptItem | undefined;
    let ended = -Infinity;
    let beforeReply = 0;
    for (let index = 1; index < items.length; index++) {
      const item = items[index];
      const key = toolKey(item);
      const call = item.kind === 'tool_result' ? calls.get(key) : undefined;
      const at = Date.parse(item.timestamp);
      if (Number.isFinite(at)) ended = Math.max(ended, at);
      if (item.kind === 'system' && item.turnChanges) captured = item;
      if (index < reply.start && !captureMarker(item)) beforeReply++;
      if (item.kind === 'tool_use' && calls.get(key) === item) {
        const category = sessionChatToolCategory(item.toolKind);
        counts[category] = (counts[category] ?? 0) + 1;
      }
      const error = item.kind === 'error' || chatItemFailed(item, commandExecution(item, call));
      if (error) {
        failed.add(item.kind === 'tool_use' || call ? 'call:' + key : 'item:' + item.id);
      } else if (item.kind === 'tool_result') {
        const edit = chatItemChanges(item, call, this.changesCache);
        if (!edit?.files.length) continue;
        // Only metadata is needed here. Retain the same net-change precedence
        // as the regular timeline while limiting fallback work on long traces.
        if (edits.length < 200) edits.push(edit);
        for (const file of edit.files)
          if (changes.size < 200 || changes.has(file.path)) changes.set(file.path, file);
      }
    }
    const outcome = captured ? capturedChangeSummary(captured, edits)
      : changes.size ? { files: [...changes.values()], total: changes.size } : undefined;
    const started = Date.parse(items[0].timestamp);
    return {
      ...this.project(items[0]),
      completedTurn: {
        revision: this.revision(items),
        endId: items.at(-1)!.id,
        reply: reply.records,
        beforeReply,
        total: hidden.length,
        counts,
        failures: failed.size,
        ...(Number.isFinite(started) && Number.isFinite(ended) ? { duration: Math.max(0, (ended - started) / 1000) } : {}),
        ...(outcome ? { changes: { ...outcome, files: outcome.files.slice(0, SESSION_CHAT_TURN_FILES_LIMIT) } } : {}),
      },
    };
  }

  page(turn: readonly AgentTranscriptItem[], revision: string, offset: number, toolDetails?: ChatToolDetails) {
    const prepared = this.prepare(turn);
    if (!prepared || offset >= prepared.hidden.length || this.revision(turn) !== revision) return null;
    const { hidden, calls, results } = prepared;
    const items: SessionChatRecord[] = [];
    let bytes = 0;
    for (const raw of hidden.slice(offset, offset + SESSION_CHAT_TURN_WORK_LIMIT)) {
      const key = toolKey(raw);
      const call = raw.kind === 'tool_result' ? calls.get(key) : undefined;
      const projected = toolDetails?.project(raw, call) ?? this.project(raw, call);
      const result = raw.kind === 'tool_use' ? results.get(key) : undefined;
      const heading = result ? toolDetails?.project(result, raw)?.toolDetails : undefined;
      const item = result ? {
        ...projected,
        receipt: { id: result.id, error: chatItemFailed(result, commandExecution(result, raw)), ...(heading ? { toolDetails: heading } : {}) },
      } : projected;
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (bytes > WORK_PAGE_BYTES) break;
      items.push(item);
    }
    if (!items.length) return null;
    const next = offset + items.length;
    return { items, nextOffset: next < hidden.length ? next : null, total: hidden.length };
  }
}

export function endOfChatTurn(history: readonly AgentTranscriptItem[], start: number): number {
  for (let index = start + 1; index < history.length; index++)
    if (history[index].kind === 'user') return index;
  return history.length;
}
