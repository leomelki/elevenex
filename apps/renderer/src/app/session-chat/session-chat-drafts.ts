import { Injectable, signal } from "@angular/core";

/** Window/workspace-owned drafts. Navigation does not discard unfinished or uncertain sends. */
@Injectable()
export class SessionChatDrafts {
  private scope = "";
  private readonly entries = new Map<
    number,
    {
      readonly text: ReturnType<typeof signal<string>>;
      readonly uncertain: ReturnType<typeof signal<string>>;
    }
  >();
  entry(scope: string, session: number) {
    if (this.scope !== scope) {
      this.scope = scope;
      this.entries.clear();
    }
    const existing = this.entries.get(session);
    if (existing) return existing;
    if (this.entries.size >= 20) {
      const evict = [...this.entries].find(([, draft]) => !draft.uncertain());
      if (evict) this.entries.delete(evict[0]);
    }
    const entry = { text: signal(""), uncertain: signal("") };
    this.entries.set(session, entry);
    return entry;
  }
}
