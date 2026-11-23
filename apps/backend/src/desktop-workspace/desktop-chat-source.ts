import type { AgentTranscriptItem } from '../agent-runtime/agent-runtime.types.js';

const HANDOFF_LIMIT = 320;

function splitBlockSource(item: AgentTranscriptItem): string | undefined {
  if (item.kind !== 'assistant' && item.kind !== 'thinking') return;
  // Older Claude transcripts use saved split-block IDs until an API index is available.
  const message = /^(msg_[^:]+):(?:(assistant|thinking):)?\d+(?::[^:]+)?$/.exec(item.id);
  return message ? `${message[1]}:${item.kind}` : undefined;
}

/** A provider may retire its runtime rows before the transcript read can see
 * the finished turn. Keep the last observed window until those IDs are saved.
 * The feed owns this handoff and clears it on an explicit history rewrite. */
export class ChatHistoryHandoff {
  private first?: string;
  private observed: readonly AgentTranscriptItem[] = [];
  private settling: readonly AgentTranscriptItem[] = [];

  observe(live: readonly AgentTranscriptItem[]): void {
    const first = live[0]?.id;
    if (this.first && this.first !== first && !live.some(item => item.id === this.first))
      this.settling = this.observed.filter(item =>
        item.kind === 'tool_use' || item.kind === 'tool_result' || item.kind === 'user' ||
        ((item.kind === 'assistant' || item.kind === 'thinking') && !!item.content?.trim()));
    this.first = first;
    this.observed = live.length > HANDOFF_LIMIT ? live.slice(-HANDOFF_LIMIT) : live;
  }

  carry(history: readonly AgentTranscriptItem[]): readonly AgentTranscriptItem[] {
    if (!this.settling.length) return [];
    const ids = new Set(this.settling.map(item => item.id));
    const sources = new Set(this.settling.map(splitBlockSource).filter(source => source !== undefined));
    const saved = new Map<string, AgentTranscriptItem>();
    const aliases = new Map<string, AgentTranscriptItem[]>();
    for (const item of history) {
      if (ids.has(item.id)) saved.set(item.id, item);
      else if (sources.size) {
        const source = splitBlockSource(item);
        if (!source || !sources.has(source)) continue;
        const blocks = aliases.get(source) ?? [];
        blocks.push(item);
        aliases.set(source, blocks);
      }
    }
    let missing = false;
    const ordered = this.settling.map(item => {
      const exact = saved.get(item.id);
      if (exact) return exact;
      const source = splitBlockSource(item);
      const blocks = source && aliases.get(source);
      const index = blocks ? blocks.findIndex(block => block.content === item.content) : -1;
      if (blocks && index >= 0) return blocks.splice(index, 1)[0];
      missing = true;
      return item;
    });
    if (!missing) {
      this.settling = [];
      return [];
    }
    // Use the final fields for rows that have already reached durable storage.
    return ordered;
  }

  item(id: string): AgentTranscriptItem | undefined {
    return this.settling.findLast(item => item.id === id);
  }

  clear(): void {
    this.first = undefined;
    this.observed = [];
    this.settling = [];
  }
}
