import { Injectable, signal } from "@angular/core";

import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import type { ConversationAttachment, ConversationMention } from '../conversation';
import { chatItemBytes } from './session-chat-retention';

export interface ChatSnapshot {
  readonly items: readonly SessionChatItem[];
  readonly state: SessionChatState;
  readonly cursor?: string;
  readonly before: string | null;
  readonly next: string | null;
  readonly supportsFollowing: boolean;
}

export interface AttachmentDraft extends ConversationAttachment { readonly file: File }
export function createSessionDraft() {
  return { text: signal(''), uncertain: signal(''), files: signal<readonly AttachmentDraft[]>([]), mentions: signal<readonly ConversationMention[]>([]) };
}
export type SessionDraft = ReturnType<typeof createSessionDraft>;

/** A local conversation has no backend identity until creation is confirmed. */
export interface StartingSession {
  readonly id: string;
  readonly scopeId: string;
  readonly taskId: number;
  readonly draft: SessionDraft;
  readonly status: 'creating' | 'failed' | 'unknown';
  readonly error?: string;
}

/** Window/workspace-owned drafts. Navigation does not discard unfinished or uncertain sends. */
@Injectable()
export class SessionChatDrafts {
  private scope = "";
  private readonly snapshots = new Map<number, { readonly value: ChatSnapshot; readonly bytes: number }>();
  remember(session: number, value: ChatSnapshot): void {
    this.snapshots.delete(session);
    const bytes = value.items.reduce((sum, item) => sum + chatItemBytes(item), 0) + JSON.stringify(value.state).length * 2;
    if (bytes > 24 * 1024 * 1024) return;
    this.snapshots.set(session, { value, bytes });
    let total = [...this.snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes, 0);
    while (this.snapshots.size > 5 || total > 24 * 1024 * 1024) {
      const id = this.snapshots.keys().next().value!;
      total -= this.snapshots.get(id)!.bytes;
      this.snapshots.delete(id);
    }
  }
  snapshot(session: number): ChatSnapshot | undefined {
    const cached = this.snapshots.get(session);
    if (cached) { this.snapshots.delete(session); this.snapshots.set(session, cached); }
    return cached?.value;
  }
  private readonly entries = new Map<number, SessionDraft>();
  /** Same machine only, after workspace recovery; opaque scope IDs themselves are never persisted. */
  rebind(previous: string, next: string): void { if (this.scope === previous) this.scope = next; }

  adopt(scope: string, session: number, draft: SessionDraft): void {
    const existing = this.scope === scope ? this.entries.get(session) : undefined;
    // A revision read may expose the saved row before the create reply arrives.
    // Keep that entry's live sends and attachments, merging any earlier local writing.
    if (existing && existing !== draft) {
      if (draft.text()) existing.text.update(text => [draft.text(), text].filter(Boolean).join('\n\n'));
      return;
    }
    this.entry(scope, session);
    this.entries.set(session, draft);
  }

  entry(scope: string, session: number) {
    if (this.scope !== scope) {
      this.scope = scope;
      this.entries.clear(); this.snapshots.clear();
    }
    const existing = this.entries.get(session);
    if (existing) return existing;
    if (this.entries.size >= 20) {
      const evict = [...this.entries].find(([, draft]) => !draft.uncertain());
      if (evict) this.entries.delete(evict[0]);
    }
    const entry = createSessionDraft();
    this.entries.set(session, entry);
    return entry;
  }
}
