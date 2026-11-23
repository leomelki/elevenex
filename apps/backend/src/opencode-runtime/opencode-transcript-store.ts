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
  private readonly awaitingMessage = new Map<string, Set<string>>();
  private cachedHistory: ClaudeTranscriptItem[] | null = null;

  get messages(): ReadonlyMap<string, Message> {
    return this.messageMap;
  }
  get parts(): ReadonlyMap<string, Part> {
    return this.partMap;
  }
  putMessage(message: Message): Part[] {
    this.messageMap.set(message.id, message);
    this.cachedHistory = null;
    const waiting = this.awaitingMessage.get(message.id);
    this.awaitingMessage.delete(message.id);
    return waiting ? [...waiting].flatMap(id => this.partMap.get(id) ?? []) : [];
  }
  putPart(part: Part): void {
    this.partMap.set(part.id, part);
    if (!this.messageMap.has(part.messageID)) {
      const waiting = this.awaitingMessage.get(part.messageID) ?? new Set<string>();
      waiting.add(part.id);
      this.awaitingMessage.set(part.messageID, waiting);
    }
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
    liveMessages?: ReadonlySet<string>,
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
    const keepLive = (id: string) => !revertMessageID && liveMessages?.has(id);
    for (const { info, parts } of visible) {
      if (this.messageMap.get(info.id) === before.messages.get(info.id))
        this.putMessage(info);
      for (const part of parts) {
        const current = this.partMap.get(part.id);
        const sameTextKind = (part.type === 'text' && current?.type === 'text') ||
          (part.type === 'reasoning' && current?.type === 'reasoning');
        // A restore can lag the socket even before it starts. Preserve
        // observed text and completed tools while this message is live.
        if (keepLive(part.messageID) &&
            ((sameTextKind && current.text !== part.text && current.text.startsWith(part.text)) ||
             (current?.type === 'tool' && part.type === 'tool' &&
              (current.state.status === 'completed' || current.state.status === 'error') &&
              (part.state.status === 'pending' || part.state.status === 'running'))))
          continue;
        if (current === before.parts.get(part.id))
          this.partMap.set(part.id, part);
        // Recover missed tokens only when the snapshot contains every token observed live.
        else if (sameTextKind && part.text.startsWith(current.text))
          this.partMap.set(part.id, part);
      }
    }
    for (const [id, message] of before.messages)
      if (!messageIDs.has(id) && !keepLive(id) && this.messageMap.get(id) === message)
        this.messageMap.delete(id);
    for (const [id, part] of before.parts) {
      if (!partIDs.has(id) && !keepLive(part.messageID) && this.partMap.get(id) === part) {
        this.partMap.delete(id);
        const waiting = this.awaitingMessage.get(part.messageID);
        if (waiting?.delete(id) && !waiting.size) this.awaitingMessage.delete(part.messageID);
      }
    }
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
    for (const message of messages) {
      this.messageMap.delete(message.id);
      this.awaitingMessage.delete(message.id);
    }
    for (const [id, part] of this.partMap)
      if (!this.messageMap.has(part.messageID)) this.partMap.delete(id);
    this.cachedHistory = null;
  }
  partItems(part: Part): ClaudeTranscriptItem[] {
    const message = this.messageMap.get(part.messageID);
    // Until the message metadata arrives this part could be a user prompt.
    return message ? openCodePartItems(part, message) : [];
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
        const parts = partsByMessage.get(message.id) ?? [];
        const items = parts.flatMap((part) =>
          openCodePartItems(part, message),
        );
        const unavailableInput = message.role === 'user' && parts.some(part =>
          part.type === 'file' && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(part.url));
        if (unavailableInput)
          for (const item of items) item.editUnsupported = true;
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
