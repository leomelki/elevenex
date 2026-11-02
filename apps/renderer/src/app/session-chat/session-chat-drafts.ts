import { Injectable, signal } from "@angular/core";

import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import type { ConversationAttachment, ConversationMention } from '../conversation';
export interface AttachmentDraft extends ConversationAttachment { readonly file: File }

/** Window/workspace-owned drafts. Navigation does not discard unfinished or uncertain sends. */
@Injectable()
export class SessionChatDrafts {
  private scope = "";
  private readonly snapshots = new Map<number, { readonly items: readonly SessionChatItem[]; readonly state: SessionChatState; readonly cursor?: string; readonly before: string | null }>();
  remember(session: number, snapshot: { readonly items: readonly SessionChatItem[]; readonly state: SessionChatState; readonly cursor?: string; readonly before: string | null }): void {
    this.snapshots.delete(session);
    // Five 1 MiB transcript snapshots, with the existing 320-item window cap.
    if (JSON.stringify(snapshot).length > 1_000_000) return;
    this.snapshots.set(session, snapshot);
    if (this.snapshots.size > 5) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  snapshot(session: number) { return this.snapshots.get(session); }
  private readonly entries = new Map<
    number,
    {
      readonly files: ReturnType<typeof signal<readonly AttachmentDraft[]>>;
      readonly mentions: ReturnType<typeof signal<readonly ConversationMention[]>>;
      readonly text: ReturnType<typeof signal<string>>;
      readonly uncertain: ReturnType<typeof signal<string>>;
    }
  >();
  /** Same machine only, after workspace recovery; opaque scope IDs themselves are never persisted. */
  rebind(previous: string, next: string): void { if (this.scope === previous) this.scope = next; }

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
    const entry = { text: signal(""), uncertain: signal(""), files: signal<readonly AttachmentDraft[]>([]), mentions: signal<readonly ConversationMention[]>([]) };
    this.entries.set(session, entry);
    return entry;
  }
}
