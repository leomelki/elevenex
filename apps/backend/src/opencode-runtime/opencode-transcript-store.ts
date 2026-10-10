import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { ClaudeTranscriptItem } from '../claude-runtime/claude-runtime.types.js';
import { openCodePartItems } from './opencode-transcript.js';

export interface OpenCodeTranscriptSnapshot {
  messages: ReadonlyMap<string, Message>;
  parts: ReadonlyMap<string, Part>;
}
export interface OpenCodeMessage {
  info: Message;
  parts: Part[];
}

/** Owns stable transcript identities and reconciles snapshots with concurrent events. */
export class OpenCodeTranscriptStore {
  private readonly messageMap = new Map<string, Message>();
  private partMap = new Map<string, Part>();
  private cachedHistory: ClaudeTranscriptItem[] | null = null;

  get messages(): ReadonlyMap<string, Message> {
    return this.messageMap;
  }
  get parts(): ReadonlyMap<string, Part> {
    return this.partMap;
  }
  putMessage(message: Message): void {
    this.messageMap.set(message.id, message);
    this.cachedHistory = null;
  }
  putPart(part: Part): void {
    this.partMap.set(part.id, part);
    this.cachedHistory = null;
  }
  appendDelta(id: string, delta: string): Part | undefined {
    const part = this.partMap.get(id);
    if (part?.type !== 'text' && part?.type !== 'reasoning') return;
    const updated = { ...part, text: part.text + delta };
    this.putPart(updated);
    return updated;
  }
  snapshot(): OpenCodeTranscriptSnapshot {
    return {
      messages: new Map(this.messageMap),
      parts: new Map(this.partMap),
    };
  }
  reconcile(
    persisted: OpenCodeMessage[],
    before: OpenCodeTranscriptSnapshot,
    revertMessageID?: string,
  ): void {
    const revertIndex = revertMessageID
      ? persisted.findIndex((message) => message.info.id === revertMessageID)
      : -1;
    const visible =
      revertIndex >= 0 ? persisted.slice(0, revertIndex) : persisted;
    const messageIDs = new Set(visible.map((message) => message.info.id));
    const partIDs = new Set(
      visible.flatMap((message) => message.parts.map((part) => part.id)),
    );
    for (const { info, parts } of visible) {
      if (this.messageMap.get(info.id) === before.messages.get(info.id))
        this.messageMap.set(info.id, info);
      for (const part of parts)
        if (this.partMap.get(part.id) === before.parts.get(part.id))
          this.partMap.set(part.id, part);
        else {
          const current = this.partMap.get(part.id);
          // Recover missed tokens only when the snapshot contains every token observed live.
          if (
            (part.type === 'text' || part.type === 'reasoning') &&
            current?.type === part.type &&
            part.text.startsWith(current.text)
          )
            this.partMap.set(part.id, part);
        }
    }
    for (const [id, message] of before.messages)
      if (!messageIDs.has(id) && this.messageMap.get(id) === message)
        this.messageMap.delete(id);
    for (const [id, part] of before.parts)
      if (!partIDs.has(id) && this.partMap.get(id) === part)
        this.partMap.delete(id);
    // Native order is authoritative; streaming-only parts follow recovered content.
    const ordered = new Map<string, Part>();
    for (const { parts } of visible)
      for (const { id } of parts) {
        const current = this.partMap.get(id);
        if (current) ordered.set(id, current);
      }
    for (const [id, part] of this.partMap)
      if (!ordered.has(id)) ordered.set(id, part);
    this.partMap = ordered;
    this.cachedHistory = null;
  }
  orderedMessages(): Message[] {
    return [...this.messageMap.values()].sort(
      (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
    );
  }
  removeMessages(messages: Message[]): void {
    for (const message of messages) this.messageMap.delete(message.id);
    for (const [id, part] of this.partMap)
      if (!this.messageMap.has(part.messageID)) this.partMap.delete(id);
    this.cachedHistory = null;
  }
  partItems(part: Part): ClaudeTranscriptItem[] {
    return openCodePartItems(part, this.messageMap.get(part.messageID));
  }
  history(): ClaudeTranscriptItem[] {
    if (!this.cachedHistory) {
      const partsByMessage = new Map<string, Part[]>();
      for (const part of this.partMap.values()) {
        const parts = partsByMessage.get(part.messageID) ?? [];
        parts.push(part);
        partsByMessage.set(part.messageID, parts);
      }
      this.cachedHistory = this.orderedMessages().flatMap((message) => {
        const items = (partsByMessage.get(message.id) ?? []).flatMap((part) =>
          openCodePartItems(part, message),
        );
        if (
          message.role === 'assistant' &&
          message.error &&
          message.error.name !== 'MessageAbortedError'
        )
          items.push({
            id: `${message.id}:error`,
            kind: 'error',
            content: JSON.stringify(message.error.data),
            timestamp: new Date(message.time.created).toISOString(),
            sourceMessageId: message.id,
          });
        return items;
      });
    }
    return [...this.cachedHistory];
  }
  refreshLiveItems(live: ClaudeTranscriptItem[]): ClaudeTranscriptItem[] {
    const current = new Map(this.history().map((item) => [item.id, item]));
    return live.flatMap((item) => {
      const updated = current.get(item.id);
      if (updated) return [updated];
      // A part can arrive before its message metadata. Keep that live event until metadata arrives.
      const part = this.partMap.get(item.id);
      return part ? this.partItems(part) : [];
    });
  }
}
