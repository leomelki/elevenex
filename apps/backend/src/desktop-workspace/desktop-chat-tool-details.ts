import { createHash } from 'node:crypto';
import { sessionChatToolHeading, type SessionChatRecord, type SessionChatToolEvidence, type SessionChatToolRecord, type SessionChatToolReference } from '@elevenex/shared';
import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';
import { chatItem, commandFacts, type ChatChangesCache, type ChatMediaCache } from './desktop-chat-projection.js';

const MAX_RECENT_BYTES = 1024 * 1024;
const MAX_RECENT_RECORDS = 256;

export function toolKey(item: AgentTranscriptItem): string {
  return item.toolUseId ?? item.id;
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
  private readonly recent = new Map<string, { evidence: SessionChatToolEvidence; bytes: number }>();
  private bytes = 0;

  constructor(private readonly changes: ChatChangesCache, private readonly media: ChatMediaCache) {}

  project(raw: AgentTranscriptItem, call?: AgentTranscriptItem): SessionChatRecord | undefined {
    if (raw.kind !== 'tool_use' && raw.kind !== 'tool_result') return;
    const previous = this.compact.get(raw);
    if (previous && previous.call === call) return previous.row;
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
    this.remember(evidence);
    return compact;
  }

  recentEvidence(reference: SessionChatToolReference): SessionChatToolEvidence | undefined {
    const entry = this.recent.get(reference.id);
    if (entry?.evidence.revision !== reference.revision) return;
    this.recent.delete(reference.id);
    this.recent.set(reference.id, entry);
    return entry.evidence;
  }

  resolve(reference: SessionChatToolReference, raw?: AgentTranscriptItem, call?: AgentTranscriptItem): SessionChatToolEvidence | undefined {
    if (raw?.kind !== 'tool_use' && raw?.kind !== 'tool_result') return;
    const evidence = this.evidence(raw, raw.kind, chatItem(raw, call, this.changes, this.media));
    if (evidence.id !== reference.id || evidence.revision !== reference.revision) return;
    this.remember(evidence);
    return evidence;
  }

  private evidence(raw: AgentTranscriptItem, kind: SessionChatToolRecord['kind'], item: SessionChatRecord): SessionChatToolEvidence {
    const { id, toolId, toolName, toolKind, text, input, timestamp, error, truncated, execution } = item;
    // A result can appear by itself at a page boundary. Its address does not
    // depend on whether the matching call was in that same window.
    const revision = createHash('sha256').update(JSON.stringify([
      id, kind, toolId, toolName, toolKind, text, input, truncated, raw.isError,
      commandFacts(raw),
    ]), 'utf16le').digest('hex');
    return {
      id, revision,
      record: { id, kind, toolId, toolName, toolKind, text, input, timestamp, error, truncated, ...(execution ? { execution } : {}) },
    };
  }

  private remember(evidence: SessionChatToolEvidence): void {
    const bytes = Buffer.byteLength(JSON.stringify(evidence));
    this.bytes -= this.recent.get(evidence.id)?.bytes ?? 0;
    this.recent.delete(evidence.id);
    this.recent.set(evidence.id, { evidence, bytes });
    this.bytes += bytes;
    for (const [id, oldest] of this.recent) {
      if (this.recent.size <= MAX_RECENT_RECORDS && this.bytes <= MAX_RECENT_BYTES) break;
      this.recent.delete(id);
      this.bytes -= oldest.bytes;
    }
  }
}
