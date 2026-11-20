import { createHash } from 'node:crypto';
import { sessionChatToolHeading, type SessionChatRecord, type SessionChatToolEvidence, type SessionChatToolRecord, type SessionChatToolReference } from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItem, commandFacts, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';

const MAX_RECENT_TEXT_BYTES = 1024 * 1024;
const MAX_RECENT_RECORDS = 256;
export type ProjectChatTool = (raw: AgentTranscriptItem, call?: AgentTranscriptItem) => SessionChatRecord | undefined;

interface CachedEvidence {
  readonly evidence: SessionChatToolEvidence;
  readonly callId?: string;
  readonly bytes: number;
}

function decode(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Projects headings for the transcript and keeps a small hot window for explicit
 * reads. Old references can still be resolved against the provider's history. */
export class ChatToolDetails {
  private readonly compact = new WeakMap<AgentTranscriptItem, { call?: AgentTranscriptItem; row: SessionChatRecord }>();
  private readonly recent = new Map<string, CachedEvidence>();
  private bytes = 0;

  constructor(private readonly changes: ChatChangesCache, private readonly media: ChatMediaCache) {}

  projectPage() {
    const retained = new Map<string, CachedEvidence>();
    let bytes = 0;
    const retain = (entry: CachedEvidence) => {
      if (retained.has(entry.evidence.id) || retained.size >= MAX_RECENT_RECORDS ||
          bytes + entry.bytes > MAX_RECENT_TEXT_BYTES) return;
      retained.set(entry.evidence.id, entry);
      bytes += entry.bytes;
    };
    const project: ProjectChatTool = (raw, call) => this.project(raw, call, retain);
    return {
      project,
      activity: (raw: AgentTranscriptItem, peer?: AgentTranscriptItem): SessionChatRecord | undefined => {
        const row = project(raw, raw.kind === 'tool_result' ? peer : undefined);
        if (!row || !peer) return row;
        if (raw.kind === 'tool_use') {
          const result = project(peer, raw);
          return result ? { ...row, receipt: { id: result.id, error: result.error, toolDetails: result.toolDetails } } : row;
        }
        const call = project(peer);
        return call?.toolDetails ? { ...row, invocation: { id: call.id, toolKind: call.toolKind, toolDetails: call.toolDetails } } : row;
      },
      commit: () => {
        // The window starts from the requested edge. Keep that edge hottest,
        // even when a newest-first walk is larger than the cache.
        for (const entry of [...retained.values()].reverse()) this.remember(entry);
      },
    };
  }

  private project(raw: AgentTranscriptItem, call: AgentTranscriptItem | undefined, retain: (entry: CachedEvidence) => void): SessionChatRecord | undefined {
    if (raw.kind !== 'tool_use' && raw.kind !== 'tool_result') return;
    const previous = this.compact.get(raw);
    if (previous && previous.call === call) {
      const entry = this.recent.get(raw.id);
      if (entry && entry.evidence.revision === previous.row.toolDetails?.revision && entry.callId === call?.id) retain(entry);
      return previous.row;
    }
    const item = chatItem(raw, call, this.changes, this.media);
    const evidence = this.evidence(raw, raw.kind, item);
    const isCall = raw.kind === 'tool_use';
    const tool = { toolName: item.toolName, toolKind: call?.toolKind ?? item.toolKind };
    const input = isCall
      ? typeof raw.toolInput === 'string' ? decode(item.input) : raw.toolInput
      : undefined;
    const output = !isCall && (tool.toolKind === 'glob' ||
      (tool.toolKind === 'bash' && item.execution?.exitCode === undefined))
      ? decode(item.text) : undefined;
    const { summary, meta } = sessionChatToolHeading(tool, input, isCall ? undefined : item, output);
    const { execution: _execution, ...row } = item;
    const compact = {
      ...row, input: '', text: '',
      toolDetails: { revision: evidence.revision, ...(isCall ? { summary } : {}), ...(meta ? { meta } : {}) },
    };
    this.compact.set(raw, { call, row: compact });
    retain(this.cacheEntry(evidence, call?.id));
    return compact;
  }

  recentEvidence(reference: SessionChatToolReference, callId?: string): SessionChatToolEvidence | undefined {
    const entry = this.recent.get(reference.id);
    if (entry?.evidence.revision !== reference.revision || (callId !== undefined && entry.callId !== callId)) return;
    this.recent.delete(reference.id);
    this.recent.set(reference.id, entry);
    return entry.evidence;
  }

  resolve(reference: SessionChatToolReference, raw?: AgentTranscriptItem, call?: AgentTranscriptItem): SessionChatToolEvidence | undefined {
    if (raw?.kind !== 'tool_use' && raw?.kind !== 'tool_result') return;
    const evidence = this.evidence(raw, raw.kind, chatItem(raw, call, this.changes, this.media));
    if (evidence.id !== reference.id || evidence.revision !== reference.revision) return;
    this.remember(this.cacheEntry(evidence, call?.id));
    return evidence;
  }

  private evidence(raw: AgentTranscriptItem, kind: SessionChatToolRecord['kind'], item: SessionChatRecord): SessionChatToolEvidence {
    const { id, toolId, toolName, toolKind, text, input, timestamp, error, truncated, execution } = item;
    // A result can appear by itself at a page boundary. Its address does not
    // depend on whether the matching call was in that same window.
    const revision = createHash('sha256')
      .update(JSON.stringify([id, kind, toolId, toolName, toolKind, truncated, raw.isError, commandFacts(raw), text.length]))
      .update(text, 'utf16le')
      .update(input, 'utf16le')
      .digest('hex');
    return {
      id, revision,
      record: { id, kind, toolId, toolName, toolKind, text, input, timestamp, error, truncated, ...(execution ? { execution } : {}) },
    };
  }

  private cacheEntry(evidence: SessionChatToolEvidence, callId?: string): CachedEvidence {
    const { record } = evidence;
    // Count retained strings directly. The entry limit bounds fixed metadata.
    const strings = [record.text, record.input, record.id, record.timestamp, record.toolId,
      record.toolName, record.toolKind, record.execution?.cwd, evidence.revision, callId];
    let bytes = 0;
    for (const value of strings) if (value) bytes += Buffer.byteLength(value);
    return { evidence, callId, bytes };
  }

  private remember(entry: CachedEvidence): void {
    const { id } = entry.evidence;
    this.bytes -= this.recent.get(id)?.bytes ?? 0;
    this.recent.delete(id);
    this.recent.set(id, entry);
    this.bytes += entry.bytes;
    for (const [id, oldest] of this.recent) {
      if (this.recent.size <= MAX_RECENT_RECORDS && this.bytes <= MAX_RECENT_TEXT_BYTES) break;
      this.recent.delete(id);
      this.bytes -= oldest.bytes;
    }
  }
}
